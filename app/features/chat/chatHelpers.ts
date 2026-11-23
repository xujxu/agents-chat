import type { Agent } from '../agents/agentTypes';
import type { ChatHistoryEntry, AgentUserRequestOption, ChatMessage } from './chatTypes';

export const SCHEDULER_AGENT_ID = 'scheduler';

export function getAgentUserRequestOptionLabel(option: AgentUserRequestOption): string {
  if (option.kind === 'allow_always' || option.optionId === 'allow_always') {
    return 'Always allow in current session';
  }
  return option.label;
}

export function normalizeChatHistory(chats: ChatHistoryEntry[]): ChatHistoryEntry[] {
  const byId = new Map<string, ChatHistoryEntry>();
  for (const chat of chats) {
    if (!byId.has(chat.id)) byId.set(chat.id, chat);
  }
  return Array.from(byId.values());
}

/**
 * A chat reopened from this browser's cache may be behind the server (another device kept
 * chatting). The server copy wins, except for this browser's unsaved changes (`unsavedIds`) and
 * its local notices; saved messages the server no longer has were removed elsewhere.
 */
export function mergeReopenedChatMessages(server: ChatMessage[], cached: ChatMessage[], unsavedIds: Set<string>): ChatMessage[] {
  const local = new Map(cached.map(message => [message.id, message]));
  const merged = new Map(server.map(message => [message.id, unsavedIds.has(message.id) ? local.get(message.id) || message : message]));
  for (const message of cached) {
    if (!merged.has(message.id) && (message.type === 'system' || unsavedIds.has(message.id))) merged.set(message.id, message);
  }
  return [...merged.values()].sort((a, b) => a.ts - b.ts);
}

/** Moves `entry` to the end of the history, keeping the existing chat agent when `entry` has none (a lost agent routes sends to the default agent). */
export function replaceChatHistoryEntry(history: ChatHistoryEntry[], entry: ChatHistoryEntry): ChatHistoryEntry[] {
  const agentId = entry.agentId || history.find(chat => chat.id === entry.id)?.agentId;
  return normalizeChatHistory([...history.filter(chat => chat.id !== entry.id), { ...entry, ...(agentId ? { agentId } : {}) }]);
}

export function formatMessageTime(ts: number) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

export function getMentionedAgentIds(text: string, agents: Agent[]) {
  const matches = [...text.matchAll(/@(\S+)/g)];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const match of matches) {
    const rawId = match[1];
    const agent = agents.find((a) => a.id.toLowerCase() === rawId.toLowerCase());
    if (agent && !seen.has(agent.id)) {
      seen.add(agent.id);
      selected.push(agent.id);
    }
  }
  return selected;
}

export function getDefaultAgentId(agents: Agent[]): string | null {
  const preferred = agents.find((agent) => agent.isDefault && agent.id !== SCHEDULER_AGENT_ID && agent.canTalk !== false);
  return (preferred || agents.find((agent) => agent.id !== SCHEDULER_AGENT_ID) || agents[0] || null)?.id || null;
}

export function getExistingAgentId(agentId: string | null | undefined, agents: Agent[]): string | null {
  if (!agentId) return null;
  return agents.some((agent) => agent.id === agentId) ? agentId : null;
}

export function parseAgents(text: string, agents: Agent[], preferredAgentId?: string | null) {
  const agentIds = getMentionedAgentIds(text, agents);
  if (agentIds.length === 0) {
    // Use preferred agent (from chat's agentId) if available, otherwise fall back to first non-scheduler
    const fallbackId = getExistingAgentId(preferredAgentId, agents) || getDefaultAgentId(agents) || 'main';
    return { agentIds: [fallbackId], message: text };
  }
  const message = text.replace(/(?:^|\s)@(\S+)/g, '').trim();
  return { agentIds, message: message || text };
}

/** Extract the current (last) session ID — handles both string and string[] from SQLite. */
export function lastSessionId(val: unknown): string | null {
  if (Array.isArray(val)) return val.length > 0 ? val[val.length - 1] : null;
  if (typeof val === 'string' && val) return val;
  return null;
}

export function isAcpFailureResult(value: unknown): value is { ok?: unknown; error?: unknown } {
  return !!value && typeof value === 'object' && 'ok' in value && (value as { ok?: unknown }).ok !== true;
}

export function isSendFailureMessage(message: ChatMessage): boolean {
  if (message.type !== 'agent' && message.type !== 'system') return false;
  const text = message.content.trim();
  if (message.type === 'system') {
    return /^(?:⚠️\s*)?Send failed:/i.test(text);
  }
  return text.startsWith('⚠️') && (
    text.includes('Failed to send prompt to agent') ||
    text.includes('Send failed')
  );
}

export function getSendFailureError(message: ChatMessage): string {
  const text = message.content.trim();
  return text.replace(/^⚠️\s*/, '').replace(/^Send failed:\s*/i, '') || 'Failed to send prompt to agent';
}

export function shouldInferFailedTargetFromWarning(userMessage: ChatMessage): boolean {
  return !/(?:^|\s)@\S+/.test(userMessage.content);
}

export function hasPersistedAgentSession(agentSessions?: Record<string, string>): boolean {
  return Object.values(agentSessions || {}).some((session) => !!lastSessionId(session));
}

export function hasVisibleMessageText(message: ChatMessage): boolean {
  return Boolean(
    message.content.trim() ||
    message.parts?.some((part) => part.kind === 'text' && part.text.trim())
  );
}

export function getLatestUserWithoutSavedResponseIndex(chatMessages: ChatMessage[]): number {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const message = chatMessages[i];
    if (message.type === 'system') continue;
    if (message.type === 'user') return i;
    if (hasVisibleMessageText(message)) return -1;
  }
  return -1;
}

const UNCONFIRMED_SEND_ERROR = 'Sending was interrupted before confirmation. Check existing replies before using Retry.';

function hasAgentOutputAfter(chatMessages: ChatMessage[], userIndex: number): boolean {
  for (const message of chatMessages.slice(userIndex + 1)) {
    if (message.type === 'user') return false;
    if (message.type === 'agent' && !isSendFailureMessage(message)
      && ((message.parts?.length ?? 0) > 0 || (message.content.trim() && message.content.trim() !== '⏹ Interrupted'))) return true;
  }
  return false;
}

export function migrateFailedSendWarnings(
  chatMessages: ChatMessage[],
  agentSessions?: Record<string, string>,
  options?: { inferLatestUserFailure?: boolean },
): { messages: ChatMessage[]; changed: boolean } {
  const inferLatestUserFailure = options?.inferLatestUserFailure !== false;
  const migrated: ChatMessage[] = [];
  let changed = false;
  for (const [index, message] of chatMessages.entries()) {
    const unconfirmed = message.type === 'user' && (message.sendStatus === 'pending'
      || (message.sendStatus === 'failed' && message.sendError === UNCONFIRMED_SEND_ERROR));
    // The page or server went away before the send was confirmed. If the agent already replied, it got the message.
    if (unconfirmed && hasAgentOutputAfter(chatMessages, index)) {
      migrated.push({ ...message, sendStatus: undefined, sendError: undefined, resendAgentIds: undefined, resendMessage: undefined });
      changed = true;
      continue;
    }
    if (message.type === 'user' && message.sendStatus === 'pending') {
      migrated.push({
        ...message, sendStatus: 'failed',
        sendError: UNCONFIRMED_SEND_ERROR,
      });
      changed = true;
      continue;
    }
    if (isSendFailureMessage(message)) {
      const previous = migrated[migrated.length - 1];
      if (previous?.type === 'user') {
        const shouldInferTarget = shouldInferFailedTargetFromWarning(previous);
        const resendAgentIds = shouldInferTarget && message.agentId ? [message.agentId] : previous.resendAgentIds;
        migrated[migrated.length - 1] = {
          ...previous,
          sendStatus: 'failed',
          sendError: getSendFailureError(message),
          resendAgentIds,
          resendMessage: shouldInferTarget ? (previous.resendMessage || previous.content) : previous.resendMessage,
        };
        changed = true;
        continue;
      }
    }
    migrated.push(message);
  }
  if (inferLatestUserFailure && !hasPersistedAgentSession(agentSessions)) {
    const userIndex = getLatestUserWithoutSavedResponseIndex(migrated);
    const userMessage = userIndex >= 0 ? migrated[userIndex] : null;
    if (userMessage?.type === 'user' && userMessage.sendStatus !== 'failed') {
      migrated[userIndex] = {
        ...userMessage,
        sendStatus: 'failed',
        sendError: userMessage.sendError || 'Failed to send prompt to agent',
      };
      changed = true;
    }
  }
  return { messages: migrated, changed };
}

export function getPersistableMessages(chatMessages: ChatMessage[]): ChatMessage[] {
  return chatMessages.filter(m => !(m.type === 'system' && m.ts !== 0));
}

/** Sidebar status once no turn is running; a failed send only counts until an agent replies after it. */
export function getIdleChatStatus(chatMessages: ChatMessage[]): { label: string; kind: 'done' | 'error' } | null {
  const lastAgentIndex = chatMessages.findLastIndex(m => m.type === 'agent');
  if (chatMessages.slice(lastAgentIndex + 1).some(m => m.type === 'user' && m.sendStatus === 'failed')) return { label: 'Error', kind: 'error' };
  if (lastAgentIndex < 0) return null;
  if (getMessageCopyText(chatMessages[lastAgentIndex]).trim().startsWith('⚠️')) return { label: 'Error', kind: 'error' };
  return { label: 'Done', kind: 'done' };
}

export function getMessageCopyText(message: ChatMessage): string {
  if (message.parts && message.parts.length > 0) {
    return message.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('') || message.content || '';
  }
  return message.content || '';
}
