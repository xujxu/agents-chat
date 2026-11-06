import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { TeamsConfig } from './config';

const execAsync = promisify(exec);

const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
const BOT_FRAMEWORK_JWKS = 'https://login.botframework.com/v1/.well-known/keys';

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;
type TokenResult = { value: string; expiresAt: number };

// Kept on globalThis: Next.js bundles instrumentation.ts and route handlers separately, so module
// state would not be shared between the startup warm-up and the request path.
type AuthState = {
  jwks: Map<string, RemoteJwks>;
  /** `refreshAt`: time to fetch a new token; `expiresAt`: last moment the cached token may still be used. */
  botToken: { value: string; refreshAt: number; expiresAt: number; key: string } | null;
  pendingBotToken: Promise<string> | null;
  vaultAccess: TokenResult | null;
  keepWarm?: ReturnType<typeof setInterval>;
};
const authGlobals = globalThis as { __teamsAuth?: AuthState };
const state: AuthState = authGlobals.__teamsAuth ??= { jwks: new Map(), botToken: null, pendingBotToken: null, vaultAccess: null };
const jwksCache = state.jwks;

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
export async function verifyInboundToken(
  authHeader: string | null,
  config: TeamsConfig,
  activityServiceUrl: string | undefined,
  signingKeys: JWTVerifyGetKey = getJwks(BOT_FRAMEWORK_JWKS),
): Promise<JWTPayload> {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader || '');
  if (!match) throw new Error('missing_bearer_token');
  const token = match[1].trim();

  const { payload } = await jwtVerify(token, signingKeys, {
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

/** Key Vault access token from the Azure CLI login of the account running this service. */
async function getVaultAccessToken(): Promise<string> {
  if (state.vaultAccess && state.vaultAccess.expiresAt - 5 * 60_000 > Date.now()) return state.vaultAccess.value;
  const { stdout } = await execAsync('az account get-access-token --resource https://vault.azure.net -o json', {
    timeout: 60_000,
    windowsHide: true,
  }).catch((err: Error) => {
    throw new Error(`keyvault_cli_token_failed: ${err.message.split('\n')[0]}`);
  });
  const data = JSON.parse(stdout) as { accessToken?: string; expires_on?: number; expiresOn?: string };
  if (!data.accessToken) throw new Error('keyvault_cli_token_failed: no accessToken');
  const expiresAt = data.expires_on ? Number(data.expires_on) * 1000 : Date.parse(data.expiresOn || '') || Date.now() + 10 * 60_000;
  state.vaultAccess = { value: data.accessToken, expiresAt };
  return data.accessToken;
}

/** Read a Bot Framework token that an external job (e.g. managed identity + federated credential) stores in Key Vault. */
async function fetchTokenFromKeyVault(config: TeamsConfig): Promise<TokenResult> {
  const url = `${keyVaultBaseUrl(config.tokenVault)}/secrets/${encodeURIComponent(config.tokenSecretName)}?api-version=7.4`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getVaultAccessToken()}` } });
  const data = await res.json().catch(() => ({})) as { value?: string; error?: { code?: string } };
  if (res.status === 401) state.vaultAccess = null;
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
  const cached = state.botToken && state.botToken.key === key ? state.botToken : null;
  if (cached && cached.refreshAt > now) return cached.value;
  if (cached && cached.expiresAt > now) {
    // Still valid: refresh in the background so replies never wait on Key Vault / Entra.
    refreshBotToken(config, key).catch(() => undefined);
    return cached.value;
  }
  return refreshBotToken(config, key);
}

function refreshBotToken(config: TeamsConfig, key: string): Promise<string> {
  if (state.pendingBotToken) return state.pendingBotToken;
  state.pendingBotToken = (async () => {
    const token = config.tokenVault ? await fetchTokenFromKeyVault(config) : await fetchTokenWithSecret(config);
    const expiresAt = token.expiresAt - 5 * 60_000;
    // Re-read Key Vault every 10 minutes so rotated tokens are picked up well before expiry.
    const refreshAt = config.tokenVault ? Math.min(expiresAt, Date.now() + 10 * 60_000) : expiresAt - 5 * 60_000;
    state.botToken = { value: token.value, key, refreshAt: Math.max(Date.now() + 30_000, refreshAt), expiresAt: Math.max(Date.now() + 30_000, expiresAt) };
    return token.value;
  })().finally(() => {
    state.pendingBotToken = null;
  });
  return state.pendingBotToken;
}

const KEEP_WARM_INTERVAL_MS = 5 * 60_000;

/**
 * Fetch the outbound bot token and the inbound signing keys at startup, then keep the bot token
 * (and the Azure CLI Key Vault token behind it) fresh in the background, so the first Teams
 * message after a restart or an idle period does not wait on `az`, Key Vault, or Entra ID.
 * Never throws; failures are logged and retried on the next tick or on demand.
 */
export async function warmUpTeams(config: TeamsConfig, options: { inboundKeys?: boolean; onError?: (stage: string, err: unknown) => void } = {}): Promise<void> {
  const onError = options.onError ?? (() => undefined);
  if (!state.keepWarm) {
    state.keepWarm = setInterval(() => {
      getBotAccessToken(config).catch((err) => onError('bot-token', err));
    }, KEEP_WARM_INTERVAL_MS);
    state.keepWarm.unref?.();
  }
  await Promise.all([
    getBotAccessToken(config).catch((err) => onError('bot-token', err)),
    options.inboundKeys === false ? undefined : prefetchInboundKeys().catch((err) => onError('inbound-keys', err)),
  ]);
}

/** Load the Bot Framework signing keys into the JWKS cache (a lookup of an unknown key id forces one fetch). */
async function prefetchInboundKeys(): Promise<void> {
  try {
    await getJwks(BOT_FRAMEWORK_JWKS)({ alg: 'RS256', kid: '__agents-chat-warmup__' });
  } catch (err) {
    if ((err as { code?: string })?.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw err;
  }
}

/** Test hook: forget cached tokens and stop the keep-warm timer. */
export function resetTeamsAuthForTests(): void {
  if (state.keepWarm) clearInterval(state.keepWarm);
  state.keepWarm = undefined;
  state.botToken = null;
  state.pendingBotToken = null;
  state.vaultAccess = null;
}
