// `/extend` (recipients) and `/approve` / `/deny` (admins) for shared-agent access, in 1:1 chats with the bot.
import * as configStore from '@/lib/configStore';
import { createLogger } from '@/lib/logger';
import type { TeamsConfig } from './config';
import { notifyExtensionDecision, sendShareReminders } from './shareReminders';

const logger = createLogger('teams-bot');
const DAY_MS = 24 * 60 * 60_000;

type PendingRequest = { agentId: string; agentName: string; email: string; requestedAt: string };
type Globals = { __teamsExtensionLists?: Map<string, PendingRequest[]> };
const g = globalThis as Globals;
/** The last `/approve` or `/deny` list per admin and conversation, so numbers pick from what was shown. */
const requestLists = g.__teamsExtensionLists ??= new Map();

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 10)}`;
}

function background(promise: Promise<unknown>, what: string): void {
  void promise.catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, what));
}

/**
 * `/extend` lists the caller's shared agents that expire within SHARE_REMIND_DAYS (or recently expired);
 * `/extend <number|name>` asks admins for SHARE_DAYS more days, like **Request 30 more days** in the web UI.
 */
export function extendCommand(config: TeamsConfig, email: string, args: string): string {
  const grants = configStore.listUserAgentGrants(email).filter((grant) => grant.acceptedAt);
  const eligible = grants.filter((grant) => new Date(grant.expiresAt).getTime() - Date.now() <= configStore.SHARE_REMIND_DAYS * DAY_MS);
  const describe = (grant: (typeof grants)[number]) =>
    `**${grant.agentName}** – ${grant.status === 'expired' ? 'expired' : 'expires'} ${formatDate(grant.expiresAt)}${grant.extensionDays ? ' (request pending)' : ''}`;
  const query = args.trim().toLowerCase();

  if (!query) {
    if (!eligible.length) {
      if (!grants.length) return 'No agents are shared with you.';
      return [
        `You can ask for more time from ${configStore.SHARE_REMIND_DAYS} days before access expires. Your shared agents:`,
        ...grants.map((grant) => `- ${describe(grant)}`),
      ].join('\n');
    }
    return [
      `Send \`/extend <number>\` to ask an admin for ${configStore.SHARE_DAYS} more days:`,
      ...eligible.map((grant, i) => `${i + 1}. ${describe(grant)}`),
    ].join('\n');
  }

  const index = /^\d+$/.test(query) ? Number(query) - 1 : -1;
  const grant = index >= 0 ? eligible[index]
    : eligible.find((item) => item.agentId.toLowerCase() === query || item.agentName.toLowerCase() === query);
  if (!grant) {
    const other = grants.find((item) => item.agentId.toLowerCase() === query || item.agentName.toLowerCase() === query);
    if (other) return `Your access to **${other.agentName}** expires ${formatDate(other.expiresAt)}. You can ask for more time from ${configStore.SHARE_REMIND_DAYS} days before that.`;
    return 'No matching agent. Send `/extend` to see the list.';
  }
  if (grant.extensionDays) return `You already asked for ${grant.extensionDays} more days on **${grant.agentName}**. An admin will review it.`;
  if (!configStore.requestAgentAccessExtension(grant.agentId, email, configStore.SHARE_DAYS)) {
    return `Could not request more time on **${grant.agentName}**. Ask an admin.`;
  }
  background(sendShareReminders(config), 'Teams extension notice failed');
  return `📨 Asked for ${configStore.SHARE_DAYS} more days on **${grant.agentName}**. Admins have been notified; I will message you here when it is decided.`;
}

/**
 * Admins only. `/approve` or `/deny` lists pending extension requests; `/approve <number>` grants the
 * requested days and `/deny <number>` declines. The recipient is told in Teams when reachable.
 */
export function decideCommand(
  config: TeamsConfig, admin: { email: string; isAdmin: boolean }, conversationId: string, args: string, approve: boolean,
): string {
  const verb = approve ? 'approve' : 'deny';
  if (!admin.isAdmin) return `Only admins can ${verb} extension requests.`;
  const listKey = `${admin.email}|${conversationId}`;
  const query = args.trim();

  if (!query) {
    const requests = configStore.listAgentAccessExtensionRequests();
    requestLists.delete(listKey);
    if (!requests.length) return 'No extension requests are waiting.';
    requestLists.set(listKey, requests.map((request) => ({
      agentId: request.agentId, agentName: request.agentName, email: request.email, requestedAt: request.extensionRequestedAt || '',
    })));
    if (requestLists.size > 1000) requestLists.delete(requestLists.keys().next().value!);
    const lines = requests.map((request, i) =>
      `${i + 1}. **${request.email}** – ${request.extensionDays} more days on **${request.agentName}** (${request.status === 'expired' ? 'expired' : 'expires'} ${formatDate(request.expiresAt)})`);
    return [`Send \`/approve <number>\` or \`/deny <number>\`:`, ...lines].join('\n');
  }

  const list = requestLists.get(listKey);
  if (!list) return `Send \`/${verb}\` first to see the requests.`;
  const index = /^\d+$/.test(query) ? Number(query) - 1 : -1;
  const picked = list[index];
  if (!picked) return `No request number ${query}. Send \`/${verb}\` to see the list.`;
  const current = configStore.getAgentAccess(picked.agentId, picked.email);
  // The request may have been handled (or replaced) since the list was shown.
  if (!current || (current.extensionRequestedAt || '') !== picked.requestedAt) {
    return `The request from **${picked.email}** on **${picked.agentName}** was already handled or changed. Send \`/${verb}\` to see the current list.`;
  }

  if (approve) {
    if (!configStore.extendAgentAccess(picked.agentId, picked.email, current.extensionDays || configStore.SHARE_DAYS)) {
      return 'Could not approve that request.';
    }
  } else if (!configStore.denyAgentAccessExtension(picked.agentId, picked.email)) {
    return 'Could not deny that request.';
  }
  background(notifyExtensionDecision(picked, approve, config), 'Teams extension decision notice failed');
  const updated = configStore.getAgentAccess(picked.agentId, picked.email);
  return approve
    ? `✅ Approved: **${picked.email}** can use **${picked.agentName}** until ${formatDate(updated?.expiresAt || '')}.`
    : `❌ Denied the request from **${picked.email}** on **${picked.agentName}**.`;
}
