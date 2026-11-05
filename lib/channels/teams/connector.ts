import { getBotAccessToken } from './auth';
import type { TeamsConfig } from './config';
import { isAllowedServiceUrl, normalizeServiceUrl, splitForTeams } from './util';

export type ConversationRef = {
  serviceUrl: string;
  conversationId: string;
  botId: string;
  botName?: string;
  userId: string;
  userName?: string;
  replyToId?: string;
};

export type TeamsMember = {
  id: string;
  name?: string;
  aadObjectId?: string;
  email?: string;
  userPrincipalName?: string;
  tenantId?: string;
};

export class ConnectorError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

async function connectorFetch(config: TeamsConfig, ref: ConversationRef, path: string, init: RequestInit = {}): Promise<Response> {
  if (!isAllowedServiceUrl(ref.serviceUrl)) throw new Error('service_url_not_allowed');
  const token = await getBotAccessToken(config);
  const res = await fetch(`${normalizeServiceUrl(ref.serviceUrl)}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ConnectorError(`connector ${init.method || 'GET'} ${path} failed: ${res.status}`, res.status, body.slice(0, 500));
  }
  return res;
}

export async function sendActivity(config: TeamsConfig, ref: ConversationRef, activity: Record<string, unknown>): Promise<string | undefined> {
  const res = await connectorFetch(config, ref, `v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`, {
    method: 'POST',
    body: JSON.stringify({
      from: { id: ref.botId, name: ref.botName },
      recipient: { id: ref.userId, name: ref.userName },
      conversation: { id: ref.conversationId },
      ...(ref.replyToId ? { replyToId: ref.replyToId } : {}),
      ...activity,
    }),
  });
  const data = await res.json().catch(() => ({})) as { id?: string };
  return data.id;
}

export async function sendText(config: TeamsConfig, ref: ConversationRef, text: string): Promise<void> {
  for (const chunk of splitForTeams(text)) {
    await sendActivity(config, ref, { type: 'message', textFormat: 'markdown', text: chunk });
  }
}

export async function sendTyping(config: TeamsConfig, ref: ConversationRef): Promise<void> {
  await sendActivity(config, ref, { type: 'typing' });
}

export async function getMember(config: TeamsConfig, ref: ConversationRef, memberId: string): Promise<TeamsMember> {
  const res = await connectorFetch(config, ref, `v3/conversations/${encodeURIComponent(ref.conversationId)}/members/${encodeURIComponent(memberId)}`);
  return await res.json() as TeamsMember;
}
