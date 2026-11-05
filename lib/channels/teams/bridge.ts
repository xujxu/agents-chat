import { randomUUID } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { appendMessageToChat, getChat, saveChat } from '@/lib/chatStore';
import * as configStore from '@/lib/configStore';
import { createLogger } from '@/lib/logger';
import type { TeamsConfig } from './config';
import { getMember, sendText, type ConversationRef } from './connector';
import { TeamsStreamer } from './stream';
import {
  buildUserRequestAnswer,
  chatNameFromPrompt,
  cleanIncomingText,
  conversationSettingKey,
  formatUserRequest,
  isAllowedServiceUrl,
  newTeamsChatId,
  parseCommand,
  type UserRequestLike,
} from './util';

const logger = createLogger('teams-bot');

const POLL_INTERVAL_MS = 500;
const MAX_TURN_MS = 2 * 60 * 60_000;
const MAX_POLL_FAILURES = 30;
const IDENTITY_TTL_MS = 60 * 60_000;
const SESSION_TOKEN_TTL_S = 60 * 60;

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
  attachments?: { contentType?: string }[];
};

type TeamsUser = { email: string; name: string; aadObjectId: string };

type ConversationState = {
  running: boolean;
  chatId?: string;
  pendingRequest?: UserRequestLike;
  answeredRequestId?: string;
};

type Globals = {
  __teamsProcessed?: Map<string, number>;
  __teamsConversations?: Map<string, ConversationState>;
  __teamsIdentities?: Map<string, { user: TeamsUser; expiresAt: number }>;
  __teamsSessionTokens?: Map<string, { value: string; expiresAt: number }>;
};
const g = globalThis as Globals;
const processed = g.__teamsProcessed ??= new Map();
const conversations = g.__teamsConversations ??= new Map();
const identities = g.__teamsIdentities ??= new Map();
const sessionTokens = g.__teamsSessionTokens ??= new Map();

const HELP_TEXT = [
  '**Commands**',
  '- `/new [prompt]` – start a new conversation (optionally with a first prompt)',
  '- `/stop` – stop the current response',
  '- `/whoami` – show which agents-chat account and chat you are using',
  '- `/help` – show this help',
  '',
  'Anything else is sent to the agent. Conversations also appear in the agents-chat web UI.',
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
    if (botAdded && activity.conversation?.conversationType === 'personal') {
      await sendText(config, { ...ref, replyToId: undefined }, `Hi! I connect you to the **${config.agentId}** agent in agents-chat.\n\n${HELP_TEXT}`);
    }
    return;
  }
  if (activity.type !== 'message') return;

  try {
    await handleMessage(activity, config, ref);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Teams message handling failed');
    await sendText(config, ref, '⚠️ Something went wrong while handling your message. Please try again.').catch(() => undefined);
  }
}

async function handleMessage(activity: TeamsActivity, config: TeamsConfig, ref: ConversationRef): Promise<void> {
  if (activity.conversation?.conversationType !== 'personal') {
    await sendText(config, ref, 'I only work in 1:1 chats. Please message me directly.');
    return;
  }

  const user = await resolveUser(config, ref, activity);
  if (!user) {
    await sendText(config, ref, '⚠️ I could not determine your email address, so I cannot map you to an agents-chat account.');
    return;
  }
  if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(user.email)) {
    logger.warn({ email: user.email }, 'Teams user is not in TEAMS_ALLOWED_USERS');
    await sendText(config, ref, `Sorry, ${user.email} is not allowed to use this bot.`);
    return;
  }

  const text = cleanIncomingText(activity.text);
  if (!text) {
    const hasAttachments = activity.attachments?.some((a) => a.contentType && a.contentType !== 'text/html');
    if (hasAttachments) await sendText(config, ref, 'Attachments are not supported yet. Please send text.');
    return;
  }

  const state = getConversationState(ref.conversationId);
  const command = parseCommand(text);

  if (state.running) {
    if (command?.name === 'stop') {
      await interrupt(config, user, state);
      return;
    }
    if (state.pendingRequest && !command) {
      await answerPendingRequest(config, ref, user, state, text);
      return;
    }
    await sendText(config, ref, 'I am still working on your previous message. Send `/stop` to cancel it.');
    return;
  }

  switch (command?.name) {
    case 'help':
      await sendText(config, ref, HELP_TEXT);
      return;
    case 'whoami': {
      const chatId = currentChatId(user, ref.conversationId);
      await sendText(config, ref, `Account: **${user.email}**\nAgent: **${config.agentId}**\nChat: ${chatId ? `\`${chatId}\`` : '(none yet)'}`);
      return;
    }
    case 'stop':
      await sendText(config, ref, 'Nothing is running.');
      return;
    case 'new':
      configStore.setUserSetting(user.email, conversationSettingKey(ref.conversationId), '');
      if (!command.args) {
        await sendText(config, ref, '🆕 Started a new conversation. Send your first message.');
        return;
      }
      await runTurn(config, ref, user, state, command.args);
      return;
    default:
      await runTurn(config, ref, user, state, text);
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

function currentChatId(user: TeamsUser, conversationId: string): string | undefined {
  return configStore.getUserSettings(user.email)[conversationSettingKey(conversationId)] || undefined;
}

async function resolveUser(config: TeamsConfig, ref: ConversationRef, activity: TeamsActivity): Promise<TeamsUser | null> {
  const cacheKey = activity.from?.aadObjectId || ref.userId;
  const cached = identities.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const member = await getMember(config, ref, ref.userId);
  const email = (member.email || member.userPrincipalName || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  const user: TeamsUser = { email, name: member.name || activity.from?.name || email, aadObjectId: member.aadObjectId || activity.from?.aadObjectId || ref.userId };
  identities.set(cacheKey, { user, expiresAt: Date.now() + IDENTITY_TTL_MS });
  return user;
}

async function sessionCookie(user: TeamsUser): Promise<string> {
  const cached = sessionTokens.get(user.email);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not configured');
  // Mirror the NextAuth jwt callback parsing so Teams and web always agree on admin role.
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const role = adminEmails.includes(user.email) ? 'admin' : 'user';
  const value = await encode({
    token: { name: user.name, email: user.email, sub: user.aadObjectId, role },
    secret,
    maxAge: SESSION_TOKEN_TTL_S,
  });
  sessionTokens.set(user.email, { value, expiresAt: Date.now() + (SESSION_TOKEN_TTL_S - 300) * 1000 });
  return value;
}

type AcpResult = { status: number; data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Call the existing /api/acp route over loopback as the mapped user. */
async function acp(config: TeamsConfig, user: TeamsUser, body: Record<string, unknown>): Promise<AcpResult> {
  const res = await fetch(`${config.internalBaseUrl}/api/acp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `next-auth.session-token=${await sessionCookie(user)}` },
    body: JSON.stringify({ agentId: config.agentId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function ensureChat(config: TeamsConfig, user: TeamsUser, conversationId: string, prompt: string): Promise<{ id: string; name: string }> {
  const existingId = currentChatId(user, conversationId);
  if (existingId) {
    const existing = await getChat(user.email, existingId);
    if (existing) return { id: existing.id, name: existing.name };
  }
  const chat = { id: newTeamsChatId(conversationId), name: chatNameFromPrompt(prompt) };
  await saveChat(user.email, { ...chat, ts: Date.now(), agentId: config.agentId, messages: [], agentSessions: {} });
  configStore.setUserSetting(user.email, conversationSettingKey(conversationId), chat.id);
  return chat;
}

async function runTurn(config: TeamsConfig, ref: ConversationRef, user: TeamsUser, state: ConversationState, prompt: string): Promise<void> {
  state.running = true;
  state.pendingRequest = undefined;
  try {
    const chat = await ensureChat(config, user, ref.conversationId, prompt);
    state.chatId = chat.id;
    const userTs = Date.now();
    const agentMessageId = `teams-${randomUUID()}`;
    await appendMessageToChat(user.email, chat, { id: `teams-user-${randomUUID()}`, type: 'user', content: prompt, ts: userTs });

    // Show progress right away: `send` can take several seconds while a cold agent process starts.
    const streamer = new TeamsStreamer(config, ref);
    const indicator = streamer.informative('Thinking…');
    const sent = await acp(config, user, { action: 'send', chatId: chat.id, text: prompt, messageId: agentMessageId, messageTs: userTs + 1 });
    await indicator;
    if (!sent.data?.ok) {
      await streamer.finish(describeSendError(config, sent));
      return;
    }

    await pollTurn(config, ref, user, state, chat.id, agentMessageId, streamer);
  } finally {
    state.running = false;
    state.pendingRequest = undefined;
  }
}

function describeSendError(config: TeamsConfig, result: AcpResult): string {
  const error = String(result.data?.error || `HTTP ${result.status}`);
  if (result.status === 409) return 'The agent is still busy with a previous request in this chat. Send `/stop` to cancel it, or try again shortly.';
  if (result.status === 403) return `You do not have access to the **${config.agentId}** agent.`;
  if (result.status === 404 || /not.?found/i.test(error)) return `The **${config.agentId}** agent is not configured in agents-chat.`;
  if (result.status === 410) return 'This chat was deleted. Send `/new` to start a new conversation.';
  return `⚠️ Could not send your message to the agent: ${error}`;
}

async function pollTurn(
  config: TeamsConfig,
  ref: ConversationRef,
  user: TeamsUser,
  state: ConversationState,
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
      const polled = await acp(config, user, { action: 'poll', chatId });
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
      await sendText(config, ref, formatUserRequest(request));
    } else if (!request) {
      state.pendingRequest = undefined;
    }

    if (turn.done) {
      const error = typeof turn.error === 'string' ? turn.error : '';
      const suffix = error ? `⚠️ ${error}` : (turn.statusText === 'Interrupted' ? '⏹ Stopped.' : '');
      const finalText = suffix ? `${fullText}${fullText ? '\n\n' : ''}${suffix}` : fullText;
      await streamer.finish(finalText);
      await acp(config, user, { action: 'turn-clear', chatId }).catch(() => undefined);
      return;
    }

    if (!state.pendingRequest) {
      if (fullText) await streamer.update(fullText);
      else await streamer.informative(String(turn.statusText || 'Thinking…'));
    }
    lastText = fullText;
  }

  await streamer.finish(`${lastText}\n\n⚠️ Stopped waiting after ${MAX_TURN_MS / 60_000} minutes. Check the agents-chat web UI.`.trim());
}

async function answerPendingRequest(config: TeamsConfig, ref: ConversationRef, user: TeamsUser, state: ConversationState, text: string): Promise<void> {
  const request = state.pendingRequest;
  if (!request) return;
  const answer = buildUserRequestAnswer(request, text);
  if (!answer) {
    await sendText(config, ref, 'Please reply with the number or name of one of the options, or send `/stop`.');
    return;
  }
  const result = await acp(config, user, { action: 'respond-user-request', chatId: state.chatId, requestId: request.id, ...answer });
  if (!result.data?.ok) {
    await sendText(config, ref, `⚠️ Could not deliver your answer: ${String(result.data?.error || `HTTP ${result.status}`)}`);
    return;
  }
  state.answeredRequestId = request.id;
  state.pendingRequest = undefined;
}

async function interrupt(config: TeamsConfig, user: TeamsUser, state: ConversationState): Promise<void> {
  if (!state.chatId) return;
  const result = await acp(config, user, { action: 'interrupt', chatId: state.chatId });
  if (!result.data?.ok) logger.warn({ status: result.status, error: result.data?.error }, 'Teams /stop failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
