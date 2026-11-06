// Pure helpers for the Teams bot bridge. Keep this module free of app imports so it can be unit tested directly.
import { createHash } from 'node:crypto';

/** Max characters per Teams text message (Teams caps activities at ~100 KB; stay well below it). */
export const TEAMS_MAX_TEXT = 20000;

export type TeamsCommandName = 'new' | 'stop' | 'help' | 'whoami' | 'model' | 'agent' | 'session';
export type TeamsCommand = { name: TeamsCommandName; args: string } | null;

export function parseCommand(text: string): TeamsCommand {
  const match = /^\/(new|stop|help|whoami|model|agent|session)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase() as TeamsCommandName, args: (match[2] || '').trim() };
}

const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

export type TeamsEntity = { type?: string; text?: string; mentioned?: { id?: string; name?: string } };

function botMentions(entities: unknown, botId: string): TeamsEntity[] {
  if (!Array.isArray(entities)) return [];
  return entities.filter((e): e is TeamsEntity => e?.type === 'mention' && e.mentioned?.id === botId);
}

/** True when the message explicitly @mentions the bot. */
export function isBotMentioned(entities: unknown, botId: string): boolean {
  return botMentions(entities, botId).length > 0;
}

/**
 * Normalize inbound Teams message text and strip stray HTML. With `botId`, only @mentions of the bot are
 * removed and other mentions keep the person's name; without it, every mention is removed.
 */
export function cleanIncomingText(text: unknown, entities?: unknown, botId?: string): string {
  if (typeof text !== 'string') return '';
  const botNames = new Set<string>();
  if (botId) {
    for (const mention of botMentions(entities, botId)) {
      const inner = /<at>([\s\S]*?)<\/at>/i.exec(mention.text || '')?.[1];
      for (const name of [inner, mention.mentioned?.name]) if (name?.trim()) botNames.add(name.trim().toLowerCase());
    }
  }
  return text
    .replace(/<at>([\s\S]*?)<\/at>/gi, (_, name: string) => (!botId || botNames.has(name.trim().toLowerCase()) ? '' : name))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .trim();
}

export function hashId(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** Prefix of every agents-chat chat id created from this Teams conversation. */
export function teamsChatPrefix(conversationId: string): string {
  return `teams-${hashId(conversationId, 12)}-`;
}

export function newTeamsChatId(conversationId: string, now = Date.now()): string {
  return `${teamsChatPrefix(conversationId)}${now.toString(36)}`;
}

/** Short "how long ago" text for session lists. */
export function formatAge(ts: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(ts).toISOString().slice(0, 10);
}

/**
 * User setting holding the agents-chat chat for a Teams conversation. Each agent gets its own chat;
 * the bot's default agent keeps the original key so existing conversations continue.
 */
export function conversationSettingKey(conversationId: string, agentId?: string): string {
  const base = `teams.chat.${hashId(conversationId)}`;
  return agentId ? `${base}.${hashId(agentId, 12)}` : base;
}

/** User setting holding the agent chosen with `/agent` for a Teams conversation. */
export function conversationAgentKey(conversationId: string): string {
  return `teams.agent.${hashId(conversationId)}`;
}

export function chatNameFromPrompt(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((l) => l.trim())?.trim() || 'New chat';
  return `Teams: ${line.length > 60 ? `${line.slice(0, 57)}...` : line}`;
}

/** Only send bot tokens to Microsoft Bot Framework / Teams service hosts. */
export function isAllowedServiceUrl(serviceUrl: unknown): serviceUrl is string {
  if (typeof serviceUrl !== 'string') return false;
  let url: URL;
  try { url = new URL(serviceUrl); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'smba.trafficmanager.net'
    || host.endsWith('.botframework.com')
    || host.endsWith('.botframework.us')
    || host.endsWith('.teams.microsoft.com')
    || host.endsWith('.teams.microsoft.us');
}

export function normalizeServiceUrl(serviceUrl: string): string {
  return serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`;
}

/** Split long text into Teams-sized chunks, preferring paragraph/line boundaries. */
export function splitForTeams(text: string, max = TEAMS_MAX_TEXT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

export function parseEmailList(value: string | undefined): string[] {
  return (value || '').split(/[,;\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

export type UserRequestOption = { optionId: string; label?: string };
export type UserRequestQuestion = { id: string; header: string; question?: string; options?: { label: string }[] };
export type UserRequestLike = {
  id: string;
  title?: string;
  prompt?: string;
  options?: UserRequestOption[];
  questions?: UserRequestQuestion[];
};

function optionLabel(option: UserRequestOption): string {
  return option.label || option.optionId;
}

/** Render a pending agent request (permission prompt / question) as Teams text. */
export function formatUserRequest(request: UserRequestLike): string {
  const lines: string[] = [`**${request.title || 'The agent needs your input'}**`];
  if (request.prompt) lines.push('', request.prompt);
  if (request.options?.length) {
    lines.push('', 'Reply with the number or name of one option:');
    request.options.forEach((option, index) => lines.push(`${index + 1}. ${optionLabel(option)}`));
  } else if (request.questions?.length) {
    lines.push('', request.questions.length > 1 ? 'Reply with one answer per line, in order:' : 'Reply with your answer:');
    request.questions.forEach((q, index) => {
      const choices = q.options?.length ? ` (${q.options.map((o) => o.label).join(' / ')})` : '';
      lines.push(`${index + 1}. ${q.question || q.header}${choices}`);
    });
  } else {
    lines.push('', 'Reply with your answer.');
  }
  lines.push('', '_Send /stop to cancel._');
  return lines.join('\n');
}

/**
 * Translate a Teams text reply into a respond-user-request body.
 * Returns null when the reply does not select a valid option.
 */
export function buildUserRequestAnswer(request: UserRequestLike, text: string): Record<string, unknown> | null {
  const reply = text.trim();
  if (request.options?.length) {
    const lower = reply.toLowerCase();
    const index = /^\d+$/.test(reply) ? Number(reply) - 1 : -1;
    const option = request.options[index]
      ?? request.options.find((o) => optionLabel(o).toLowerCase() === lower || o.optionId.toLowerCase() === lower);
    return option ? { optionId: option.optionId } : null;
  }
  if (request.questions?.length) {
    const lines = request.questions.length > 1 ? reply.split(/\r?\n/).map((l) => l.trim()) : [reply];
    const answers: Record<string, string> = {};
    request.questions.forEach((q, i) => { answers[q.header] = lines[i] ?? ''; });
    return { answers };
  }
  return { answer: reply };
}
