// Inbound Bot Framework token validation: the only gate in front of /api/teams/messages.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import { verifyInboundToken } from '../lib/channels/teams/auth';
import type { TeamsConfig } from '../lib/channels/teams/config';

const config = { appId: 'bot-app-id' } as TeamsConfig;
const serviceUrl = 'https://smba.trafficmanager.net/amer/';

const keys = (async () => {
  const signing = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(signing.publicKey)), kid: 'k1', alg: 'RS256' }] });
  return { privateKey: signing.privateKey, otherKey: other.privateKey, jwks };
})();

type Overrides = { claims?: JWTPayload; issuer?: string; audience?: string; expiresIn?: string | number; key?: CryptoKey | Uint8Array; alg?: string };
async function token(o: Overrides = {}): Promise<string> {
  const jwt = new SignJWT({ serviceurl: serviceUrl, ...o.claims })
    .setProtectedHeader({ alg: o.alg ?? 'RS256', kid: 'k1' })
    .setIssuer(o.issuer ?? 'https://api.botframework.com')
    .setAudience(o.audience ?? config.appId)
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '1h');
  return jwt.sign((o.key ?? (await keys).privateKey) as Parameters<SignJWT['sign']>[0]);
}
const verify = async (header: string | null, url: string | undefined = serviceUrl) => verifyInboundToken(header, config, url, (await keys).jwks);

test('accepts a Bot Framework token for this bot and service URL', async () => {
  const payload = await verify(`Bearer ${await token()}`);
  assert.equal(payload.aud, config.appId);
  // Trailing slash and case differences in the service URL are tolerated.
  await verify(`bearer ${await token()}`, 'https://SMBA.trafficmanager.net/amer');
});

test('rejects missing or malformed authorization headers', async () => {
  await assert.rejects(verify(null), /missing_bearer_token/);
  await assert.rejects(verify(''), /missing_bearer_token/);
  await assert.rejects(verify(`Basic ${await token()}`), /missing_bearer_token/);
  await assert.rejects(verify('Bearer not-a-jwt'));
});

test('rejects tokens from another issuer, for another audience, or expired', async () => {
  await assert.rejects(verify(`Bearer ${await token({ issuer: 'https://sts.windows.net/tenant/' })}`), /iss/);
  await assert.rejects(verify(`Bearer ${await token({ audience: 'another-bot' })}`), /aud/);
  await assert.rejects(verify(`Bearer ${await token({ expiresIn: Math.floor(Date.now() / 1000) - 3600 })}`), /exp/);
});

test('rejects tokens signed with an unknown key or a non-RS256 algorithm', async () => {
  await assert.rejects(verify(`Bearer ${await token({ key: (await keys).otherKey as CryptoKey })}`), /signature/);
  await assert.rejects(verify(`Bearer ${await token({ alg: 'HS256', key: new TextEncoder().encode('x'.repeat(32)) })}`));
});

test('binds the token to the activity service URL', async () => {
  await assert.rejects(verify(`Bearer ${await token()}`, 'https://smba.trafficmanager.net/emea/'), /service_url_mismatch/);
  await assert.rejects(verifyInboundToken(`Bearer ${await token()}`, config, undefined, (await keys).jwks), /service_url_mismatch/);
  await assert.rejects(verify(`Bearer ${await token({ claims: { serviceurl: undefined } })}`), /service_url_mismatch/);
});
