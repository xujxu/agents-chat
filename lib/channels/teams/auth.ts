import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import type { TeamsConfig } from './config';

const execAsync = promisify(exec);

const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
const BOT_FRAMEWORK_JWKS = 'https://login.botframework.com/v1/.well-known/keys';

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new Map<string, RemoteJwks>();

function getJwks(url: string): RemoteJwks {
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 24 * 60 * 60 * 1000 });
    jwksCache.set(url, jwks);
  }
  return jwks;
}

/**
 * Validate the bearer token the Bot Connector service attaches to inbound Teams activities.
 * Throws on any failure.
 *
 * Only Bot Framework-issued tokens are accepted. Entra ID tokens are deliberately rejected: any app in a
 * tenant can obtain an app-only Entra token whose audience is this bot, so they would not prove the
 * request came from the Bot Connector service.
 */
export async function verifyInboundToken(authHeader: string | null, config: TeamsConfig, activityServiceUrl: string | undefined): Promise<JWTPayload> {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader || '');
  if (!match) throw new Error('missing_bearer_token');
  const token = match[1].trim();

  const { payload } = await jwtVerify(token, getJwks(BOT_FRAMEWORK_JWKS), {
    issuer: BOT_FRAMEWORK_ISSUER,
    audience: config.appId,
    algorithms: ['RS256'],
    clockTolerance: 300,
  });

  // The serviceurl claim binds the token to the service URL the bot token will be sent to.
  const claimServiceUrl = (payload as Record<string, unknown>).serviceurl;
  if (typeof claimServiceUrl !== 'string' || !activityServiceUrl
    || claimServiceUrl.replace(/\/+$/, '').toLowerCase() !== activityServiceUrl.replace(/\/+$/, '').toLowerCase()) {
    throw new Error('service_url_mismatch');
  }
  return payload;
}

/** `refreshAt`: time to fetch a new token; `expiresAt`: last moment the cached token may still be used. */
let cachedToken: { value: string; refreshAt: number; expiresAt: number; key: string } | null = null;
let pendingToken: Promise<string> | null = null;

type TokenResult = { value: string; expiresAt: number };

async function fetchTokenWithSecret(config: TeamsConfig): Promise<TokenResult> {
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.authTenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.appId,
      client_secret: config.appSecret,
      scope: 'https://api.botframework.com/.default',
    }),
  });
  const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`bot_token_failed: ${res.status} ${data.error || ''}`.trim());
  }
  const ttlMs = Math.max(60, Number(data.expires_in) || 3600) * 1000;
  return { value: data.access_token, expiresAt: Date.now() + ttlMs };
}

export function keyVaultBaseUrl(vault: string): string {
  if (/^https:\/\//i.test(vault)) return vault.replace(/\/+$/, '');
  if (!/^[a-z0-9-]{3,24}$/i.test(vault)) throw new Error('invalid_token_vault');
  return `https://${vault}.vault.azure.net`;
}

let vaultAccess: TokenResult | null = null;

/** Key Vault access token from the Azure CLI login of the account running this service. */
async function getVaultAccessToken(): Promise<string> {
  if (vaultAccess && vaultAccess.expiresAt - 5 * 60_000 > Date.now()) return vaultAccess.value;
  const { stdout } = await execAsync('az account get-access-token --resource https://vault.azure.net -o json', {
    timeout: 60_000,
    windowsHide: true,
  }).catch((err: Error) => {
    throw new Error(`keyvault_cli_token_failed: ${err.message.split('\n')[0]}`);
  });
  const data = JSON.parse(stdout) as { accessToken?: string; expires_on?: number; expiresOn?: string };
  if (!data.accessToken) throw new Error('keyvault_cli_token_failed: no accessToken');
  const expiresAt = data.expires_on ? Number(data.expires_on) * 1000 : Date.parse(data.expiresOn || '') || Date.now() + 10 * 60_000;
  vaultAccess = { value: data.accessToken, expiresAt };
  return data.accessToken;
}

/** Read a Bot Framework token that an external job (e.g. managed identity + federated credential) stores in Key Vault. */
async function fetchTokenFromKeyVault(config: TeamsConfig): Promise<TokenResult> {
  const url = `${keyVaultBaseUrl(config.tokenVault)}/secrets/${encodeURIComponent(config.tokenSecretName)}?api-version=7.4`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getVaultAccessToken()}` } });
  const data = await res.json().catch(() => ({})) as { value?: string; error?: { code?: string } };
  if (res.status === 401) vaultAccess = null;
  if (!res.ok || !data.value) {
    throw new Error(`bot_token_keyvault_failed: ${res.status} ${data.error?.code || ''}`.trim());
  }
  const claims = decodeJwt(data.value);
  if (claims.appid !== config.appId && claims.azp !== config.appId) throw new Error('bot_token_keyvault_wrong_app');
  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  if (expiresAt <= Date.now() + 60_000) throw new Error('bot_token_keyvault_expired');
  return { value: data.value, expiresAt };
}

/** Acquire (and cache) an app-only token for calling the Bot Connector service. */
export async function getBotAccessToken(config: TeamsConfig): Promise<string> {
  const key = config.tokenVault
    ? `kv|${config.tokenVault}|${config.tokenSecretName}|${config.appId}`
    : `${config.authTenant}|${config.appId}`;
  const now = Date.now();
  const cached = cachedToken && cachedToken.key === key ? cachedToken : null;
  if (cached && cached.refreshAt > now) return cached.value;
  if (cached && cached.expiresAt > now) {
    // Still valid: refresh in the background so replies never wait on Key Vault / Entra.
    refreshBotToken(config, key).catch(() => undefined);
    return cached.value;
  }
  return refreshBotToken(config, key);
}

function refreshBotToken(config: TeamsConfig, key: string): Promise<string> {
  if (pendingToken) return pendingToken;
  pendingToken = (async () => {
    const token = config.tokenVault ? await fetchTokenFromKeyVault(config) : await fetchTokenWithSecret(config);
    const expiresAt = token.expiresAt - 5 * 60_000;
    // Re-read Key Vault every 10 minutes so rotated tokens are picked up well before expiry.
    const refreshAt = config.tokenVault ? Math.min(expiresAt, Date.now() + 10 * 60_000) : expiresAt - 5 * 60_000;
    cachedToken = { value: token.value, key, refreshAt: Math.max(Date.now() + 30_000, refreshAt), expiresAt: Math.max(Date.now() + 30_000, expiresAt) };
    return token.value;
  })().finally(() => {
    pendingToken = null;
  });
  return pendingToken;
}
