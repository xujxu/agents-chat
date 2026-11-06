import { isAdminToken } from '@/lib/auth';
import { canUseAgent } from '@/lib/rbac';
import * as configStore from '@/lib/configStore';
import { createLogger } from '@/lib/logger';
import { getTeamsConfig, type TeamsConfig } from './config';
import { ConnectorError, sendActivity } from './connector';

const logger = createLogger('teams-bot');

/** Internal agent that the web UI also hides from its agent lists. */
export const SCHEDULER_AGENT_ID = 'scheduler';

export function userRole(email: string): 'admin' | 'user' {
  // Same rule as the web: ADMIN_EMAILS or an admin role granted in the UI.
  return isAdminToken({ email }) ? 'admin' : 'user';
}

/** Agents this person may talk to, using the same rule as the web UI and /api/acp. */
export function talkableAgents(email: string): configStore.AgentRecord[] {
  const token = { email, role: userRole(email) };
  return configStore.getAllAgents().filter((agent) => agent.id !== SCHEDULER_AGENT_ID && canUseAgent(token, agent));
}

/**
 * This person's default agent in Teams:
 * 1. the one they chose with `/default` (or "Yes, switch" on the switch prompt);
 * 2. for people who may not use TEAMS_AGENT_ID, the agent shared with them (set when they accept the
 *    share link) — people who may use TEAMS_AGENT_ID are asked first instead (see `pendingSwitchAgent`);
 * 3. TEAMS_AGENT_ID, else the first agent they may use.
 * Falls back to TEAMS_AGENT_ID (which then answers with the "no access" message) when they may use none.
 * Settings naming an agent they may not use are ignored.
 */
export function defaultAgentId(config: TeamsConfig, email: string, agents = talkableAgents(email)): string {
  const usable = (id: string | undefined) => !!id && agents.some((agent) => agent.id === id);
  const settings = configStore.getUserSettings(email);
  const chosen = settings[configStore.TEAMS_DEFAULT_AGENT_SETTING];
  if (usable(chosen)) return chosen;
  if (usable(config.agentId)) return config.agentId;
  const shared = settings[configStore.DEFAULT_AGENT_SETTING];
  if (usable(shared)) return shared;
  return agents[0]?.id ?? config.agentId;
}

/**
 * The agent shared with this person that they have not been asked about yet, when it is not already
 * their Teams default. Only people who may use TEAMS_AGENT_ID are asked; the others switch automatically.
 */
export function pendingSwitchAgent(config: TeamsConfig, email: string): configStore.AgentRecord | null {
  const settings = configStore.getUserSettings(email);
  const shared = settings[configStore.DEFAULT_AGENT_SETTING];
  if (!shared || settings[configStore.TEAMS_SWITCH_ASKED_SETTING] === shared) return null;
  const agents = talkableAgents(email);
  const agent = agents.find((a) => a.id === shared);
  if (!agent || !agents.some((a) => a.id === config.agentId)) return null;
  return defaultAgentId(config, email, agents) === shared ? null : agent;
}

export function agentName(agentId: string): string {
  return configStore.getAgentById(agentId)?.name || agentId;
}

/** The switch question with "Yes, switch" / "No, stay" buttons that send `/default <agent id>`. */
export function switchPromptActivity(config: TeamsConfig, email: string, agent: configStore.AgentRecord): Record<string, unknown> {
  const current = defaultAgentId(config, email);
  const name = agent.name || agent.id;
  const currentName = agentName(current);
  return {
    type: 'message',
    textFormat: 'markdown',
    text: [
      `🔗 The **${name}** agent was shared with you. Switch your Teams chats to it?`,
      `You are using **${currentName}** now. You can change this any time with \`/default\`, or use \`/agent\` to switch one chat.`,
    ].join('\n\n'),
    suggestedActions: {
      actions: [
        { type: 'imBack', title: 'Yes, switch', value: `/default ${agent.id}` },
        { type: 'imBack', title: `No, stay on ${currentName}`, value: `/default ${current}` },
      ],
    },
  };
}

/** Records that this person was asked about `agentId`, so they are asked only once. */
export function markSwitchAsked(email: string, agentId: string): void {
  configStore.setUserSetting(email, configStore.TEAMS_SWITCH_ASKED_SETTING, agentId);
}

/**
 * Asks this person in their 1:1 Teams chat whether to switch to the agent just shared with them.
 * Best-effort: when the bot cannot reach them yet, they are asked when they install it or next message it.
 */
export async function offerTeamsSwitch(email: string, config: TeamsConfig | null = getTeamsConfig()): Promise<boolean> {
  if (!config || !config.allowedUsers.includes(email.toLowerCase())) return false;
  const agent = pendingSwitchAgent(config, email);
  const conversation = configStore.getTeamsConversation(email);
  if (!agent || !conversation) return false;
  try {
    await sendActivity(config, conversation, switchPromptActivity(config, email, agent));
    markSwitchAsked(email, agent.id);
    return true;
  } catch (err) {
    if (err instanceof ConnectorError && (err.status === 403 || err.status === 404)) {
      configStore.removeTeamsConversation(email, conversation.conversationId);
    }
    logger.warn({ email, err: err instanceof Error ? err.message : String(err) }, 'Teams switch prompt not delivered');
    return false;
  }
}
