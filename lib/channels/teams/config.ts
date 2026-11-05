import { parseEmailList } from './util';

export type TeamsConfig = {
  appId: string;
  /** Client secret. Empty when tokens come from Key Vault instead. */
  appSecret: string;
  /** Key Vault (name or URL) holding a pre-minted Bot Framework token, e.g. refreshed by a managed-identity job. */
  tokenVault: string;
  tokenSecretName: string;
  /** Tenant users must belong to (channelData.tenant.id). */
  tenantId: string;
  /** Tenant used to acquire outbound Bot Framework tokens: the bot's tenant for single-tenant apps, `botframework.com` for multi-tenant. */
  authTenant: string;
  agentId: string;
  allowedUsers: string[];
  internalBaseUrl: string;
};

export function getTeamsConfig(): TeamsConfig | null {
  const appId = process.env.TEAMS_BOT_APP_ID?.trim() || '';
  const appSecret = process.env.TEAMS_BOT_APP_SECRET?.trim() || '';
  const tokenVault = process.env.TEAMS_BOT_TOKEN_VAULT?.trim() || '';
  const tenantId = process.env.TEAMS_TENANT_ID?.trim() || '';
  const agentId = process.env.TEAMS_AGENT_ID?.trim() || '';
  if (!appId || (!appSecret && !tokenVault) || !tenantId || !agentId) return null;
  return {
    appId,
    appSecret,
    tokenVault,
    tokenSecretName: process.env.TEAMS_BOT_TOKEN_SECRET?.trim() || 'teams-bot-token',
    tenantId,
    authTenant: process.env.TEAMS_BOT_AUTH_TENANT?.trim() || tenantId,
    agentId,
    allowedUsers: parseEmailList(process.env.TEAMS_ALLOWED_USERS),
    internalBaseUrl: (process.env.TEAMS_INTERNAL_BASE_URL?.trim() || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  };
}
