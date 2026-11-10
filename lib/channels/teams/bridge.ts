import { randomUUID } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { appendMessageToChat, getChat, listChats, saveChat, searchChats } from '@/lib/chatStore';
import * as configStore from '@/lib/configStore';
import type { AgentModel } from '@/lib/configStore';
import { createLogger } from '@/lib/logger';
import { linkWorkItems } from '@/lib/workItemLinks';
import type { TeamsConfig } from './config';
import { getMember, sendActivity, sendText, type ConversationRef } from './connector';
import * as defaults from './defaultAgent';
import { downloadTeamsImages, hasNonTextAttachments, ignoredFileNames, teamsImageRefs, type TeamsAttachment, type TeamsImageRef } from './images';
import { decideCommand, extendCommand } from './shareCommands';
import { TeamsStreamer } from './stream';
import {
  buildUserRequestAnswer,
  chatNameFromPrompt,
  cleanIncomingText,
  conversationAgentKey,
  conversationSettingKey,
  formatAge,
  formatSessionTable,
  formatUserRequest,
  isAllowedServiceUrl,
  isBotMentioned,
  newTeamsChatId,
  parseCommand,
  teamsChatPrefix,
  type TeamsEntity,
  type UserRequestLike,
} from './util';

const logger = createLogger('teams-bot');

const POLL_INTERVAL_MS = 500;
const MAX_TURN_MS = 2 * 60 * 60_000;
const MAX_POLL_FAILURES = 30;
/** Identities are re-checked against the roster after this long, in the background... */
const IDENTITY_REFRESH_MS = 60 * 60_000;
/** ...and after this long without a successful refresh, the next message waits for a fresh lookup. */
const IDENTITY_MAX_AGE_MS = 24 * 60 * 60_000;
const SESSION_TOKEN_TTL_S = 60 * 60;
/** Sessions shown per `/session` list or search. */
const SESSION_LIST_LIMIT = 10;

/** Status lines shown while `send` waits for a cold agent to start. Mutable for tests. */
export const SLOW_START_STATUS = [
  { afterMs: 4000, text: 'Starting the agent… The first message after a while can take a few seconds.' },
  { afterMs: 20_000, text: 'Still starting the agent…' },
];
export type TeamsActivity = {
  id?: string;
  type?: string;
  text?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string } };
  membersAdded?: { id?: string }[];
  attachments?: TeamsAttachment[];
  entities?: TeamsEntity[];
};

type TeamsUser = { email: string; name: string; aadObjectId: string };

type ConversationState = {
  running: boolean;
  chatId?: string;
  /** Agent of the running (or last) turn, so /stop and answers reach it even after `/agent`. */
  agentId?: string;
  pendingRequest?: UserRequestLike;
  answeredRequestId?: string;
};

type CachedIdentity = { user: TeamsUser; refreshAt: number; expiresAt: number };

type Globals = {
  __teamsProcessed?: Map<string, number>;
  __teamsConversations?: Map<string, ConversationState>;
  __teamsIdentities?: Map<string, CachedIdentity>;
  __teamsIdentityRefreshes?: Map<string, Promise<unknown>>;
  __teamsSessionTokens?: Map<string, { value: string; expiresAt: number }>;
  __teamsSessionLists?: Map<string, string[]>;
};
const g = globalThis as Globals;
const processed = g.__teamsProcessed ??= new Map();
const conversations = g.__teamsConversations ??= new Map();
const identities = g.__teamsIdentities ??= new Map();
const identityRefreshes = g.__teamsIdentityRefreshes ??= new Map();
const sessionTokens = g.__teamsSessionTokens ??= new Map();
/** Chat ids of the last `/session` list per person, conversation and agent, so `/session <number>` picks from it. */
const sessionLists = g.__teamsSessionLists ??= new Map();

const HELP_TEXT = [
  '**Commands**',
  '- `/new [prompt]` – start a new conversation (optionally with a first prompt)',
  '- `/stop` – stop the current response',
  '- `/whoami` – show which agents-chat account, agent, model, and chat you are using',
  '- `/agent [number or name]` – list agents you can use, or switch to one (each agent keeps its own conversation)',
  '- `/default [number or name]` – show or change your default agent in Teams',
  '- `/session [number or words]` – list your sessions with the current agent, switch to one, or search them',
  '- `/model [number or name]` – list models, or switch to one',
  '- `/extend [number]` – ask for more time on an agent shared with you that expires soon (1:1 chat only)',
  '- `/approve [number]`, `/deny [number]` – admins: review requests for more time (1:1 chat only)',
  '- `/help` – show this help',
  '',
  'Anything else is sent to the agent. Conversations also appear in the agents-chat web UI.',
].join('\n');

const GROUP_HELP_TEXT = [
  'In this group chat I only respond when you **@mention** me, and everyone here sees my replies.',
  'Each person gets their own agents-chat conversation and uses their own access. `/session` only shows sessions started in this group chat.',
  '',
  HELP_TEXT,
].join('\n');

/** Returns false if this activity id was already seen (Bot Framework may redeliver). */
export function markActivityProcessed(id: string | undefined): boolean {
  if (!id) return true;
  if (processed.has(id)) return false;
  processed.set(id, Date.now());
  if (processed.size > 1000) {
    const oldest = processed.keys().next().value;
    if (oldest !== undefined) processed.delete(oldest);
  }
  return true;
}

export async function handleActivity(activity: TeamsActivity, config: TeamsConfig): Promise<void> {
  const conversationId = activity.conversation?.id;
  if (!conversationId || !activity.from?.id || !activity.recipient?.id || !isAllowedServiceUrl(activity.serviceUrl)) return;
  const tenantId = activity.channelData?.tenant?.id || activity.conversation?.tenantId;
  if (tenantId?.toLowerCase() !== config.tenantId.toLowerCase()) {
    logger.warn({ tenantId }, 'Ignoring Teams activity from another tenant');
    return;
  }

  const ref: ConversationRef = {
    serviceUrl: activity.serviceUrl,
    conversationId,
    botId: activity.recipient.id,
    botName: activity.recipient.name,
    userId: activity.from.id,
    userName: activity.from.name,
    replyToId: activity.id,
  };

  if (activity.type === 'conversationUpdate') {
    const botAdded = activity.membersAdded?.some((m) => m.id === activity.recipient?.id);
    const conversationType = activity.conversation?.conversationType;
    if (!botAdded || (conversationType !== 'personal' && conversationType !== 'groupChat')) return;
    // Welcome only allowed users, so the bot stays silent to anyone else who installs or adds it.
    const user = await authorize(config, ref, activity);
    if (!user) return;
    if (conversationType === 'personal') {
      rememberPersonalChat(ref, user);
      await sendText(config, { ...ref, replyToId: undefined }, `Hi! I connect you to the **${agentDisplayName(activeAgentId(config, user, conversationId))}** agent in agents-chat.\n\n${HELP_TEXT}`);
      await askToSwitch(config, { ...ref, replyToId: undefined }, user);
    } else {
      await sendText(config, { ...ref, replyToId: undefined }, `Hi! I connect you to the **${config.agentId}** agent in agents-chat. @mention me with your question.\n\n${GROUP_HELP_TEXT}`);
    }
    return;
  }
  if (activity.type !== 'message') return;

  let authorized = false;
  try {
    await handleMessage(activity, config, ref, () => { authorized = true; });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Teams message handling failed');
    if (authorized) await sendText(config, ref, '⚠️ Something went wrong while handling your message. Please try again.').catch(() => undefined);
  }
}

/**
 * Returns the user only if they may use the bot. Everyone else is ignored without a reply, so the
 * bot does not reveal itself: other organizations, anonymous users, accounts without an email, and
 * anyone not in TEAMS_ALLOWED_USERS (deny by default: an empty list lets nobody in).
 */
async function authorize(config: TeamsConfig, ref: ConversationRef, activity: TeamsActivity): Promise<TeamsUser | null> {
  let user: Awaited<ReturnType<typeof resolveUser>>;
  try {
    user = await resolveUser(config, ref, activity);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Ignoring Teams user: roster lookup failed');
    return null;
  }
  if (user === 'external') {
    logger.warn('Ignoring Teams user from another organization or an anonymous user');
    return null;
  }
  if (!user) {
    logger.warn('Ignoring Teams user without an email address');
    return null;
  }
  if (!config.allowedUsers.includes(user.email)) {
    logger.warn(
      { email: user.email },
      config.allowedUsers.length ? 'Ignoring Teams user not in TEAMS_ALLOWED_USERS' : 'TEAMS_ALLOWED_USERS is empty; ignoring all Teams users',
    );
    return null;
  }
  return user;
}

async function handleMessage(
  activity: TeamsActivity,
  config: TeamsConfig,
  conversationRef: ConversationRef,
  onAuthorized: () => void,
): Promise<void> {
  const conversationType = activity.conversation?.conversationType;
  const mentioned = isBotMentioned(activity.entities, conversationRef.botId);
  if (conversationType !== 'personal' && conversationType !== 'groupChat') {
    if (mentioned && (await authorize(config, conversationRef, activity))) {
      await sendText(config, conversationRef, 'I only work in 1:1 chats and group chats.');
    }
    return;
  }
  const isGroup = conversationType === 'groupChat';
  // Never interrupt a group discussion: act only on messages that explicitly @mention the bot,
  // even if the app is granted permission to read every message in the chat.
  if (isGroup && !mentioned) return;
  const ref: ConversationRef = { ...conversationRef, isGroup };

  const user = await authorize(config, ref, activity);
  if (!user) return;
  onAuthorized();
  if (!isGroup) rememberPersonalChat(ref, user);

  const html = (activity.attachments ?? []).flatMap((a) => (a.contentType === 'text/html' && typeof a.content === 'string' ? [a.content] : []));
  const text = cleanIncomingText(activity.text, activity.entities, ref.botId, html);
  const images = teamsImageRefs(activity.attachments);
  if (!text && images.length === 0) {
    if (hasNonTextAttachments(activity.attachments)) await sendText(config, ref, 'Only images are supported as attachments. Please send text or an image.');
    else if (isGroup) await sendText(config, ref, GROUP_HELP_TEXT);
    return;
  }
  const ignoredFiles = ignoredFileNames(activity.attachments);
  if (ignoredFiles.length) {
    await sendText(config, ref, `⚠️ Only images are supported as attachments; the agent will not see ${ignoredFiles.map((name) => `"${name}"`).join(', ')}.`);
  }

  // Group chats keep separate state per person so nobody can answer or stop someone else's turn.
  const state = getConversationState(isGroup ? `${ref.conversationId}|${ref.userId}` : ref.conversationId);
  const command = text ? parseCommand(text) : null;
  // Ask about a newly shared agent once, in a 1:1 chat, if the share-time message could not reach them.
  if (!isGroup && command?.name !== 'default') await askToSwitch(config, ref, user);

  if (state.running) {
    if (command?.name === 'stop') {
      await interrupt(config, user, state);
      return;
    }
    if (state.pendingRequest && !command && text) {
      await answerPendingRequest(config, ref, user, state, text);
      return;
    }
    await sendText(config, ref, `I am still working on your previous message. ${isGroup ? 'Mention me with `/stop`' : 'Send `/stop`'} to cancel it.`);
    return;
  }

  switch (command?.name) {
    case 'help':
      await sendText(config, ref, isGroup ? GROUP_HELP_TEXT : HELP_TEXT);
      return;
    case 'whoami': {
      const agentId = activeAgentId(config, user, ref.conversationId);
      const chatId = currentChatId(config, user, agentId, ref.conversationId);
      const modelId = selectedModelId(user, agentId);
      await sendText(config, ref, `Account: **${user.email}**\nAgent: **${agentId}**\nModel: ${modelId ? `\`${modelId}\`` : "(agent's default)"}\nChat: ${chatId ? `\`${chatId}\`` : '(none yet)'}`);
      return;
    }
    case 'agent':
      await sendText(config, ref, changeAgent(config, user, ref.conversationId, command.args));
      return;
    case 'default':
      await sendText(config, ref, changeDefaultAgent(config, user, ref.conversationId, command.args));
      return;
    case 'model':
      await sendText(config, ref, changeModel(user, activeAgentId(config, user, ref.conversationId), command.args));
      return;
    case 'session':
      await sendText(config, ref, await changeSession(config, ref, user, command.args));
      return;
    case 'stop':
      await sendText(config, ref, 'Nothing is running.');
      return;
    case 'extend':
    case 'approve':
    case 'deny':
      if (isGroup) {
        await sendText(config, ref, 'Send this command in a 1:1 chat with me.');
      } else if (command.name === 'extend') {
        await sendText(config, ref, extendCommand(config, user.email, command.args));
      } else {
        const admin = { email: user.email, isAdmin: defaults.userRole(user.email) === 'admin' };
        await sendText(config, ref, decideCommand(config, admin, ref.conversationId, command.args, command.name === 'approve'));
      }
      return;
    case 'new':
      configStore.setUserSetting(user.email, chatSettingKey(config, activeAgentId(config, user, ref.conversationId), ref.conversationId), '');
      if (!command.args && images.length === 0) {
        await sendText(config, ref, '🆕 Started a new conversation. Send your first message.');
        return;
      }
      await runTurn(config, ref, user, state, command.args, images);
      return;
    default:
      await runTurn(config, ref, user, state, text, images);
  }
}

/** Keeps the person's 1:1 chat so the bot can message them later (share expiry reminders). */
function rememberPersonalChat(ref: ConversationRef, user: TeamsUser): void {
  try {
    configStore.saveTeamsConversation(user.email, {
      serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, botId: ref.botId, botName: ref.botName, userId: ref.userId, userName: ref.userName,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not save the Teams chat for reminders');
  }
}

function getConversationState(conversationId: string): ConversationState {
  let state = conversations.get(conversationId);
  if (!state) {
    state = { running: false };
    conversations.set(conversationId, state);
  }
  return state;
}

function chatSettingKey(config: TeamsConfig, agentId: string, conversationId: string): string {
  return conversationSettingKey(conversationId, agentId === config.agentId ? undefined : agentId);
}

function currentChatId(config: TeamsConfig, user: TeamsUser, agentId: string, conversationId: string): string | undefined {
  return configStore.getUserSettings(user.email)[chatSettingKey(config, agentId, conversationId)] || undefined;
}

/** The agent this user talks to in this conversation: their `/agent` choice, else their default agent. */
function activeAgentId(config: TeamsConfig, user: TeamsUser, conversationId: string): string {
  const chosen = configStore.getUserSettings(user.email)[conversationAgentKey(conversationId)];
  return chosen && configStore.getAgentById(chosen) ? chosen : defaults.defaultAgentId(config, user.email);
}

/** In a 1:1 chat, asks once whether to switch to an agent newly shared with this user (see `defaultAgent.ts`). */
async function askToSwitch(config: TeamsConfig, ref: ConversationRef, user: TeamsUser): Promise<void> {
  const agent = defaults.pendingSwitchAgent(config, user.email);
  if (!agent) return;
  try {
    await sendActivity(config, ref, defaults.switchPromptActivity(config, user.email, agent));
    defaults.markSwitchAsked(user.email, agent.id);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not ask about switching to a shared agent');
  }
}

function agentLabelFor(agent: configStore.AgentRecord): string {
  return agent.name && agent.name !== agent.id ? `${agent.name} (\`${agent.id}\`)` : `\`${agent.id}\``;
}

/** Finds agents by list number, exact id or name, else by partial id or name. */
function matchAgents(agents: configStore.AgentRecord[], args: string): configStore.AgentRecord[] {
  const query = args.trim().toLowerCase();
  const index = /^\d+$/.test(query) ? Number(query) - 1 : -1;
  const exact = agents[index] ?? agents.find((agent) => agent.id.toLowerCase() === query || agent.name?.toLowerCase() === query);
  return exact ? [exact] : agents.filter((agent) => agent.id.toLowerCase().includes(query) || !!agent.name?.toLowerCase().includes(query));
}

/**
 * `/agent` lists the agents this user can talk to; `/agent <number|id|name>` switches this Teams
 * conversation (for this user only) to that agent. Each agent keeps its own agents-chat chat, so
 * switching back continues the earlier conversation.
 */
function changeAgent(config: TeamsConfig, user: TeamsUser, conversationId: string, args: string): string {
  const agents = defaults.talkableAgents(user.email);
  const current = activeAgentId(config, user, conversationId);
  const fallback = defaults.defaultAgentId(config, user.email, agents);
  const label = (agent: configStore.AgentRecord) => `${agentLabelFor(agent)}${agent.id === fallback ? ' – default' : ''}`;
  const list = (items: configStore.AgentRecord[]) => items.map((agent) => `${agents.indexOf(agent) + 1}. ${label(agent)}${agent.id === current ? ' ✅' : ''}`).join('\n');
  if (!args.trim()) {
    if (agents.length === 0) return `No agents are available. You are using **${current}**.`;
    return `**Agents** (✅ = current)\n${list(agents)}\n\nSend \`/agent <number or name>\` to switch.`;
  }

  const matches = matchAgents(agents, args);
  if (matches.length === 0) return `No agent you can use matches "${args.trim()}". Send \`/agent\` to see the list.`;
  if (matches.length > 1) return `"${args.trim()}" matches several agents:\n${list(matches)}\n\nSend \`/agent <number>\` to pick one.`;

  const agent = matches[0];
  configStore.setUserSetting(user.email, conversationAgentKey(conversationId), agent.id === fallback ? '' : agent.id);
  const resumed = currentChatId(config, user, agent.id, conversationId);
  return `Now talking to ${label(agent)} in this chat. ${resumed ? 'Your earlier conversation with it continues; send `/new` to start fresh.' : 'Your next message starts a new conversation with it.'}`;
}

/**
 * `/default` shows this user's default agent in Teams; `/default <number|id|name>` changes it for every
 * Teams chat that has no `/agent` choice, and switches this chat to it. The switch prompt's buttons send it.
 */
function changeDefaultAgent(config: TeamsConfig, user: TeamsUser, conversationId: string, args: string): string {
  const agents = defaults.talkableAgents(user.email);
  const current = defaults.defaultAgentId(config, user.email, agents);
  const list = (items: configStore.AgentRecord[]) => items.map((agent) => `${agents.indexOf(agent) + 1}. ${agentLabelFor(agent)}${agent.id === current ? ' ✅' : ''}`).join('\n');
  if (!args.trim()) {
    if (agents.length === 0) return `No agents are available. Your default is **${current}**.`;
    return `**Your default agent in Teams** (✅)\n${list(agents)}\n\nSend \`/default <number or name>\` to change it.`;
  }

  const matches = matchAgents(agents, args);
  if (matches.length === 0) return `No agent you can use matches "${args.trim()}". Send \`/default\` to see the list.`;
  if (matches.length > 1) return `"${args.trim()}" matches several agents:\n${list(matches)}\n\nSend \`/default <number>\` to pick one.`;

  const agent = matches[0];
  configStore.setUserSetting(user.email, configStore.TEAMS_DEFAULT_AGENT_SETTING, agent.id);
  configStore.setUserSetting(user.email, conversationAgentKey(conversationId), '');
  // Answering (or choosing a default directly) settles any pending switch question.
  const shared = configStore.getUserDefaultAgent(user.email);
  if (shared) defaults.markSwitchAsked(user.email, shared);
  const others = 'Chats where you picked an agent with `/agent` keep that agent.';
  if (agent.id === current) return `Your default agent in Teams stays ${agentLabelFor(agent)}, and this chat uses it. ${others}`;
  return `Your default agent in Teams is now ${agentLabelFor(agent)}, and this chat uses it. ${others}`;
}

type ChatSummary = { id: string; name: string; ts: number; agentId?: string };

/**
 * `/session` lists this user's sessions (agents-chat chats) with the current agent, `/session <number>`
 * switches this Teams conversation to one, `/session <chat id>` opens it directly, and `/session <words>`
 * (or `/session search <words>`) searches them the same way the web UI does. Everyone in a group chat
 * sees the replies, so there only sessions started in that group chat are listed or opened.
 */
async function changeSession(config: TeamsConfig, ref: ConversationRef, user: TeamsUser, args: string): Promise<string> {
  const agentId = activeAgentId(config, user, ref.conversationId);
  const agentName = agentDisplayName(agentId);
  const current = currentChatId(config, user, agentId, ref.conversationId);
  const groupPrefix = teamsChatPrefix(ref.conversationId);
  const visible = (chat: ChatSummary) => chat.agentId === agentId && (!ref.isGroup || chat.id.startsWith(groupPrefix));
  const listKey = `${user.email}|${ref.conversationId}|${agentId}`;
  const where = ref.isGroup ? ' in this group chat' : '';

  const show = (title: string, chats: ChatSummary[]) => {
    const shown = chats.slice(0, SESSION_LIST_LIMIT);
    sessionLists.delete(listKey);
    sessionLists.set(listKey, shown.map((chat) => chat.id));
    if (sessionLists.size > 1000) sessionLists.delete(sessionLists.keys().next().value!);
    const location = (id: string) => (id.startsWith(groupPrefix) ? 'This chat' : id.startsWith('teams-') ? 'Teams' : 'Web');
    const table = formatSessionTable(shown.map((chat) => ({ ...chat, current: chat.id === current, location: location(chat.id) })));
    const more = chats.length > shown.length ? `\n\n_…and ${chats.length - shown.length} more. Send \`/session <words>\` to search._` : '';
    return `${title}\n\n${table}${more}\n\nSend \`/session <number or id>\` to switch, \`/session <words>\` to search, or \`/new\` to start a new session.`;
  };
  const open = (chat: ChatSummary) => {
    if (chat.id === current) return `You are already in session **${chat.name || chat.id}** with **${agentName}**.`;
    configStore.setUserSetting(user.email, chatSettingKey(config, agentId, ref.conversationId), chat.id);
    return `Switched to session **${chat.name || chat.id}** with **${agentName}** (last active ${formatAge(chat.ts)}). Your next message continues it.`;
  };

  let query = args.trim();
  if (!query) {
    const chats = (await listChats(user.email)).filter(visible);
    if (chats.length === 0) return `You have no sessions with **${agentName}**${where} yet. Your next message starts one.`;
    return show(`**Your sessions with ${agentName}**${where}`, chats);
  }

  if (/^\d+$/.test(query)) {
    const ids = sessionLists.get(listKey) ?? (await listChats(user.email)).filter(visible).slice(0, SESSION_LIST_LIMIT).map((chat) => chat.id);
    const id = ids[Number(query) - 1];
    const chat = id ? await getChat(user.email, id) : null;
    if (!chat || !visible(chat)) return `There is no session ${query}. Send \`/session\` to see the list.`;
    return open(chat);
  }

  const search = /^search\s+([\s\S]+)$/i.exec(query);
  if (search) query = search[1].trim();
  else {
    const chat = await getChat(user.email, query);
    if (chat && visible(chat)) return open(chat);
  }
  const results = (await searchChats(user.email, query)).filter(visible);
  if (results.length === 0) return `No sessions with **${agentName}**${where} match "${query}". Send \`/session\` to see the list.`;
  return show(`**Sessions with ${agentName}${where} matching "${query}"**`, results);
}

/**
 * Map the Teams sender to an agents-chat user. Cached per sender: after IDENTITY_REFRESH_MS the cached
 * identity is still used, but re-checked against the roster in the background (a sender who has
 * left the organization or lost their email is dropped from the cache), so normal messages never
 * wait on the roster lookup. TEAMS_ALLOWED_USERS is checked on every message regardless.
 */
async function resolveUser(config: TeamsConfig, ref: ConversationRef, activity: TeamsActivity): Promise<TeamsUser | 'external' | null> {
  const cacheKey = activity.from?.aadObjectId || ref.userId;
  const cached = identities.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    if (cached.refreshAt <= now && !identityRefreshes.has(cacheKey)) {
      const refresh = lookupUser(config, ref, activity, cacheKey)
        .catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Background Teams roster refresh failed'))
        .finally(() => identityRefreshes.delete(cacheKey));
      identityRefreshes.set(cacheKey, refresh);
    }
    return cached.user;
  }
  return lookupUser(config, ref, activity, cacheKey);
}

async function lookupUser(config: TeamsConfig, ref: ConversationRef, activity: TeamsActivity, cacheKey: string): Promise<TeamsUser | 'external' | null> {
  const member = await getMember(config, ref, ref.userId);
  // Group chats can include people from other organizations and anonymous meeting guests.
  if (member.userRole === 'anonymous' || (member.tenantId && member.tenantId.toLowerCase() !== config.tenantId.toLowerCase())) {
    identities.delete(cacheKey);
    return 'external';
  }
  const email = (member.email || member.userPrincipalName || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    identities.delete(cacheKey);
    return null;
  }
  const user: TeamsUser = { email, name: member.name || activity.from?.name || email, aadObjectId: member.aadObjectId || activity.from?.aadObjectId || ref.userId };
  identities.set(cacheKey, { user, refreshAt: Date.now() + IDENTITY_REFRESH_MS, expiresAt: Date.now() + IDENTITY_MAX_AGE_MS });
  return user;
}

async function sessionCookie(user: TeamsUser): Promise<string> {
  const cached = sessionTokens.get(user.email);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not configured');
  const value = await encode({
    token: { name: user.name, email: user.email, sub: user.aadObjectId, role: defaults.userRole(user.email), provider: 'teams' },
    secret,
    maxAge: SESSION_TOKEN_TTL_S,
  });
  sessionTokens.set(user.email, { value, expiresAt: Date.now() + (SESSION_TOKEN_TTL_S - 300) * 1000 });
  return value;
}

type AcpResult = { status: number; data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Call the existing /api/acp route over loopback as the mapped user. */
async function acp(config: TeamsConfig, user: TeamsUser, agentId: string, body: Record<string, unknown>): Promise<AcpResult> {
  const res = await fetch(`${config.internalBaseUrl}/api/acp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `next-auth.session-token=${await sessionCookie(user)}` },
    body: JSON.stringify({ ...body, agentId }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/**
 * The model the web UI would use for this user and agent: their saved model choice, then the
 * agent default, then the first model. Sent explicitly so Teams turns run on the same model.
 */
function selectedModelId(user: TeamsUser, agentId: string): string | undefined {
  const agent = configStore.getAgentById(agentId);
  const models = agent?.models ?? [];
  const known = (id: string | null | undefined) => !!id && models.some((model) => model.modelId === id);
  const preferred = configStore.getUserAgentModelPref(user.email, agentId);
  if (preferred && (models.length === 0 || known(preferred))) return preferred;
  if (known(agent?.defaultModelId)) return agent!.defaultModelId;
  return models[0]?.modelId;
}

/**
 * `/model` lists the agent's models; `/model <number|id|name>` saves the choice as the user's
 * model preference for this agent (the same one the web UI's model picker saves).
 */
function changeModel(user: TeamsUser, agentId: string, args: string): string {
  const models = configStore.getAgentById(agentId)?.models ?? [];
  if (models.length === 0) return `The **${agentId}** agent has no model list, so its model cannot be changed here.`;
  const current = selectedModelId(user, agentId);
  const label = (model: AgentModel) => (model.name && model.name !== model.modelId ? `${model.name} (\`${model.modelId}\`)` : `\`${model.modelId}\``);
  const list = (items: AgentModel[]) => items.map((model) => `${models.indexOf(model) + 1}. ${label(model)}${model.modelId === current ? ' ✅' : ''}`).join('\n');
  const query = args.trim().toLowerCase();
  if (!query) return `**Models** (✅ = current)\n${list(models)}\n\nSend \`/model <number or name>\` to switch.`;

  const index = /^\d+$/.test(query) ? Number(query) - 1 : -1;
  const exact = models[index] ?? models.find((model) => model.modelId.toLowerCase() === query || model.name?.toLowerCase() === query);
  const matches = exact ? [exact] : models.filter((model) => model.modelId.toLowerCase().includes(query) || !!model.name?.toLowerCase().includes(query));
  if (matches.length === 0) return `No model matches "${args.trim()}". Send \`/model\` to see the list.`;
  if (matches.length > 1) return `"${args.trim()}" matches several models:\n${list(matches)}\n\nSend \`/model <number>\` to pick one.`;

  configStore.setUserAgentModelPref(user.email, agentId, matches[0].modelId);
  return `Model set to ${label(matches[0])} for **${agentId}**. It applies from your next message here and in the agents-chat web UI.`;
}

async function ensureChat(config: TeamsConfig, user: TeamsUser, agentId: string, conversationId: string, prompt: string): Promise<{ id: string; name: string }> {
  const existingId = currentChatId(config, user, agentId, conversationId);
  if (existingId) {
    const existing = await getChat(user.email, existingId);
    if (existing) return { id: existing.id, name: existing.name };
  }
  const chat = { id: newTeamsChatId(conversationId), name: chatNameFromPrompt(prompt) };
  await saveChat(user.email, { ...chat, ts: Date.now(), agentId, messages: [], agentSessions: {} });
  configStore.setUserSetting(user.email, chatSettingKey(config, agentId, conversationId), chat.id);
  return chat;
}

async function runTurn(config: TeamsConfig, ref: ConversationRef, user: TeamsUser, state: ConversationState, prompt: string, imageRefs: TeamsImageRef[] = []): Promise<void> {
  state.running = true;
  state.pendingRequest = undefined;
  // Show progress before anything else: saving the chat and `send` (which starts a cold agent
  // process) can take several seconds.
  const agentId = activeAgentId(config, user, ref.conversationId);
  state.agentId = agentId;
  const agentName = agentDisplayName(agentId);
  const workItemUrl = configStore.getAgentById(agentId)?.workItemUrl;
  const streamer = new TeamsStreamer(config, ref, undefined, agentLabel(agentName), (text) => linkWorkItems(text, workItemUrl));
  const indicator = streamer.informative(thinkingLine(agentName));
  const slowTimers: ReturnType<typeof setTimeout>[] = [];
  try {
    const images = imageRefs.length ? await downloadTeamsImages(config, imageRefs) : [];
    if (images.length < imageRefs.length) {
      if (!prompt && images.length === 0) {
        await indicator;
        await streamer.finish('⚠️ Could not download your image from Teams. Please try again, or describe it in text.');
        return;
      }
      await sendText(config, ref, `⚠️ Could not download ${imageRefs.length - images.length} of your image(s) from Teams; the agent will not see ${imageRefs.length - images.length === 1 ? 'it' : 'them'}.`);
    }
    const chat = await ensureChat(config, user, agentId, ref.conversationId, prompt || 'Image');
    state.chatId = chat.id;
    const userTs = Date.now();
    const agentMessageId = `teams-${randomUUID()}`;
    await appendMessageToChat(user.email, chat, { id: `teams-user-${randomUUID()}`, type: 'user', content: prompt, ts: userTs, ...(images.length ? { attachments: images } : {}) });

    for (const status of SLOW_START_STATUS) {
      slowTimers.push(setTimeout(() => { streamer.informative(status.text).catch(() => undefined); }, status.afterMs));
    }
    const modelId = selectedModelId(user, agentId);
    const sent = await acp(config, user, agentId, {
      action: 'send', chatId: chat.id, text: prompt, messageId: agentMessageId, messageTs: userTs + 1,
      ...(images.length ? { attachments: images } : {}), ...(modelId ? { modelId } : {}),
    });
    slowTimers.forEach(clearTimeout);
    await indicator;
    if (!sent.data?.ok) {
      await streamer.finish(describeSendError(agentId, sent));
      return;
    }

    await pollTurn(config, ref, user, state, agentId, agentName, chat.id, agentMessageId, streamer);
  } finally {
    slowTimers.forEach(clearTimeout);
    state.running = false;
    state.pendingRequest = undefined;
  }
}

function describeSendError(agentId: string, result: AcpResult): string {
  const error = String(result.data?.error || `HTTP ${result.status}`);
  if (result.status === 409) return 'The agent is still busy with a previous request in this chat. Send `/stop` to cancel it, or try again shortly.';
  if (result.status === 403) return `You do not have access to the **${agentId}** agent. Send \`/agent\` to pick another.`;
  if (result.status === 404 || /not.?found/i.test(error)) return `The **${agentId}** agent is not configured in agents-chat.`;
  if (result.status === 410) return 'This chat was deleted. Send `/new` to start a new conversation.';
  return `⚠️ Could not send your message to the agent: ${error}`;
}

async function pollTurn(
  config: TeamsConfig,
  ref: ConversationRef,
  user: TeamsUser,
  state: ConversationState,
  agentId: string,
  agentName: string,
  chatId: string,
  agentMessageId: string,
  streamer: TeamsStreamer,
): Promise<void> {
  const startedAt = Date.now();
  let lastText = '';
  let failures = 0;

  while (Date.now() - startedAt < MAX_TURN_MS) {
    await sleep(POLL_INTERVAL_MS);
    let turn: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      const polled = await acp(config, user, agentId, { action: 'poll', chatId });
      if (!polled.data?.ok) throw new Error(String(polled.data?.error || `HTTP ${polled.status}`));
      turn = polled.data.activeTurn ?? null;
      failures = 0;
    } catch (err) {
      if (++failures >= MAX_POLL_FAILURES) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Giving up polling Teams turn');
        await streamer.finish(`${lastText}\n\n⚠️ Lost track of the agent response. Check the agents-chat web UI.`.trim());
        return;
      }
      continue;
    }

    if (!turn || turn.messageId !== agentMessageId) {
      // The turn was cleared elsewhere (e.g. by the web UI); fall back to the persisted message.
      const saved = (await getChat(user.email, chatId))?.messages.find((m) => m.id === agentMessageId);
      await streamer.finish(saved?.content || lastText);
      return;
    }

    const fullText = typeof turn.fullText === 'string' ? turn.fullText : '';
    const request = turn.userRequest as UserRequestLike | undefined;
    if (request?.id && request.id !== state.pendingRequest?.id && request.id !== state.answeredRequestId) {
      state.pendingRequest = request;
      await streamer.flush(fullText);
      const question = `${agentLabel(agentName)}\n\n${formatUserRequest(request)}`;
      await sendText(config, ref, ref.isGroup ? `${question}\n_@mention me with your reply._` : question);
    } else if (!request) {
      state.pendingRequest = undefined;
    }

    if (turn.done) {
      const error = typeof turn.error === 'string' ? turn.error : '';
      const suffix = error ? `⚠️ ${error}` : (turn.statusText === 'Interrupted' ? '⏹ Stopped.' : '');
      const finalText = suffix ? `${fullText}${fullText ? '\n\n' : ''}${suffix}` : fullText;
      await streamer.finish(finalText);
      await acp(config, user, agentId, { action: 'turn-clear', chatId }).catch(() => undefined);
      return;
    }

    if (!state.pendingRequest) {
      if (fullText) await streamer.update(fullText);
      else await streamer.informative(statusLine(agentName, turn.statusText));
    }
    lastText = fullText;
  }

  await streamer.finish(`${lastText}\n\n⚠️ Stopped waiting after ${MAX_TURN_MS / 60_000} minutes. Check the agents-chat web UI.`.trim());
}

/** Name shown on replies so users can tell which agent answered. */
function agentDisplayName(agentId: string): string {
  return configStore.getAgentById(agentId)?.name?.trim() || agentId;
}

function agentLabel(agentName: string): string {
  return `*🤖 ${agentName}*`;
}

function thinkingLine(agentName: string): string {
  return `${agentName} is thinking…`;
}

function statusLine(agentName: string, statusText: unknown): string {
  const text = typeof statusText === 'string' ? statusText.trim() : '';
  return !text || text === 'Thinking' ? thinkingLine(agentName) : text;
}

async function answerPendingRequest(config: TeamsConfig, ref: ConversationRef, user: TeamsUser, state: ConversationState, text: string): Promise<void> {
  const request = state.pendingRequest;
  if (!request) return;
  const answer = buildUserRequestAnswer(request, text);
  if (!answer) {
    await sendText(config, ref, 'Please reply with the number or name of one of the options, or send `/stop`.');
    return;
  }
  const result = await acp(config, user, state.agentId ?? config.agentId, { action: 'respond-user-request', chatId: state.chatId, requestId: request.id, ...answer });
  if (!result.data?.ok) {
    await sendText(config, ref, `⚠️ Could not deliver your answer: ${String(result.data?.error || `HTTP ${result.status}`)}`);
    return;
  }
  state.answeredRequestId = request.id;
  state.pendingRequest = undefined;
}

async function interrupt(config: TeamsConfig, user: TeamsUser, state: ConversationState): Promise<void> {
  if (!state.chatId) return;
  const result = await acp(config, user, state.agentId ?? config.agentId, { action: 'interrupt', chatId: state.chatId });
  if (!result.data?.ok) logger.warn({ status: result.status, error: result.data?.error }, 'Teams /stop failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
