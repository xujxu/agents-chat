import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('agent sharing: invites, share links and expiry', async (t) => {
  const originalCwd = process.cwd();
  const originalEnv = { ADMIN_EMAILS: process.env.ADMIN_EMAILS, MEMBER_EMAILS: process.env.MEMBER_EMAILS, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
  const dir = mkdtempSync(path.join(tmpdir(), 'agents-chat-sharing-'));
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may still hold the file on Windows */ }
  });
  process.env.ADMIN_EMAILS = 'admin@contoso.com';
  process.env.MEMBER_EMAILS = '@contoso.com';
  process.env.NEXTAUTH_SECRET = 'sharing-test-secret';

  // A grant made before share links existed (old agent_access schema), to check the upgrade keeps it working.
  const { default: Database } = await import('better-sqlite3');
  mkdirSync(path.join(dir, '.data'));
  const legacy = new Database(path.join(dir, '.data', 'config.db'));
  legacy.exec(`CREATE TABLE agent_access (agent_id TEXT NOT NULL, email TEXT NOT NULL, granted_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (agent_id, email));
    INSERT INTO agent_access (agent_id, email, granted_by, created_at) VALUES ('legacy', 'old@outside.com', 'admin@contoso.com', '2020-01-01 00:00:00');`);
  legacy.close();

  const configStore = await import('../lib/configStore');
  const { canUseAgent, getUserRole } = await import('../lib/rbac');
  const { encode } = await import('next-auth/jwt');
  const { NextRequest } = await import('next/server');
  const route = await import('../app/api/agent-access/route');
  const sql = (statement: string, ...args: unknown[]) => {
    const db = new Database(path.join(dir, '.data', 'config.db'));
    try { db.prepare(statement).run(...args); } finally { db.close(); }
  };

  const call = async (email: string, body?: Record<string, unknown>) => {
    const cookie = await encode({ token: { email, sub: email, provider: 'azure-ad' }, secret: process.env.NEXTAUTH_SECRET! });
    const req = new NextRequest('http://localhost/api/agent-access', {
      method: body ? 'POST' : 'GET',
      headers: { cookie: `next-auth.session-token=${cookie}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = body ? await route.POST(req) : await route.GET(req);
    return { status: res.status, data: await res.json() };
  };

  configStore.createAgent({ id: 'shared', name: 'Shared', owner: 'admin@contoso.com' });
  const guest = { email: 'guest@outside.com' };
  const agent = { id: 'shared', owner: 'admin@contoso.com', public: false };

  await t.test('grants made before the upgrade stay accepted with a fresh 30-day expiry', () => {
    const entry = configStore.getAgentAccess('legacy', 'old@outside.com')!;
    assert.equal(entry.status, 'active');
    assert.equal(entry.acceptedAt, '2020-01-01T00:00:00Z');
    const days = (new Date(entry.expiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, `expires 30 days after the upgrade (${days})`);
  });

  await t.test('a grant is only an invite until the share link is opened', async () => {
    configStore.addAgentAccess('shared', guest.email, 'admin@contoso.com');
    assert.equal(configStore.getAgentAccess('shared', guest.email)?.status, 'pending');
    assert.equal(canUseAgent(guest, agent), false);
    assert.equal(getUserRole(guest), 'guest', 'invitees can sign in to accept');

    assert.equal((await call(guest.email, { action: 'accept', token: 'not-a-real-token-123' })).data.error, 'invalid_link');
    for (const action of ['get-link', 'create-link', 'revoke-link', 'extend', 'approve-extension', 'deny-extension']) {
      for (const caller of [guest.email, 'bob@contoso.com']) {
        const res = await call(caller, { action, agentId: 'shared', email: guest.email, days: 30 });
        assert.equal(res.status, 403, `${caller} cannot ${action}`);
      }
    }
    assert.equal(configStore.getAgentAccess('shared', guest.email)?.status, 'pending', 'rejected calls change nothing');
    const { data } = await call('admin@contoso.com', { action: 'create-link', agentId: 'shared' });
    assert.match(data.token, /^[A-Za-z0-9_-]{32}$/);

    const stranger = await call('bob@contoso.com', { action: 'accept', token: data.token });
    assert.deepEqual([stranger.status, stranger.data.error], [403, 'not_invited']);

    const accepted = await call(guest.email, { action: 'accept', token: data.token });
    assert.deepEqual([accepted.status, accepted.data.agentId], [200, 'shared']);
    assert.equal(canUseAgent(guest, agent), true);

    const rotated = await call('admin@contoso.com', { action: 'create-link', agentId: 'shared' });
    assert.notEqual(rotated.data.token, data.token);
    assert.equal((await call(guest.email, { action: 'accept', token: data.token })).data.error, 'invalid_link', 'old links stop working');
    sql(`UPDATE agent_access SET expires_at = datetime('now', '-1 day') WHERE email = ?`, guest.email);
    const expired = await call(guest.email, { action: 'accept', token: rotated.data.token });
    assert.deepEqual([expired.status, expired.data.error], [403, 'expired'], 'an expired grant cannot be re-accepted');
    assert.equal(canUseAgent(guest, agent), false);
    sql(`UPDATE agent_access SET expires_at = datetime('now', '+30 days') WHERE email = ?`, guest.email);

    await call('admin@contoso.com', { action: 'revoke-link', agentId: 'shared' });
    assert.equal(configStore.getAgentShareToken('shared'), null);
    assert.equal((await call(guest.email, { action: 'accept', token: rotated.data.token })).data.error, 'invalid_link', 'disabled links stop working');
  });

  await t.test('access expires, stays sign-in capable for a grace period, and can be extended', async () => {
    sql(`UPDATE agent_access SET expires_at = datetime('now', '-1 day') WHERE email = ?`, guest.email);
    assert.equal(canUseAgent(guest, agent), false);
    assert.equal(getUserRole(guest), 'guest', 'expired guests can still sign in to ask for more time');

    assert.equal((await call(guest.email, { action: 'request-extension', agentId: 'shared', days: 500 })).status, 400);
    assert.equal((await call(guest.email, { action: 'request-extension', agentId: 'shared', days: 14 })).status, 200);
    const admin = await call('admin@contoso.com');
    assert.deepEqual(admin.data.extensionRequests.map((r: { email: string; extensionDays: number }) => [r.email, r.extensionDays]), [[guest.email, 14]]);
    assert.deepEqual((await call(guest.email)).data.extensionRequests, [], 'guests do not see requests');

    assert.equal((await call('admin@contoso.com', { action: 'approve-extension', agentId: 'shared', email: guest.email })).status, 200);
    const entry = configStore.getAgentAccess('shared', guest.email)!;
    const days = (new Date(entry.expiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days <= 14, `extended from now by the requested days (${days})`);
    assert.equal(entry.extensionDays, null);
    assert.equal(canUseAgent(guest, agent), true);

    sql(`UPDATE agent_access SET expires_at = datetime('now', '-31 days') WHERE email = ?`, guest.email);
    assert.equal(getUserRole(guest), null, 'long-expired grants no longer admit sign-in');
  });

  await t.test('scheduled jobs stop running once their creator loses access', async () => {
    const { runAgentOnce } = await import('../lib/scheduler/agentRunner');
    configStore.addAgentAccess('shared', 'carol@contoso.com', 'admin@contoso.com');
    sql(`UPDATE agent_access SET accepted_at = datetime('now'), expires_at = datetime('now', '-1 day') WHERE email = ?`, 'carol@contoso.com');
    const job = { id: 'j1', agentId: 'shared', ownerEmail: 'carol@contoso.com', prompt: 'hi' } as Parameters<typeof runAgentOnce>[0];
    const res = await runAgentOnce(job, { timeoutMs: 1000 });
    assert.match(res.error || '', /access denied/);
  });

  await t.test('sign-in only returns to paths on this site', async () => {
    const { safeCallbackPath } = await import('../lib/safeCallbackUrl');
    const origin = 'http://chat.example';
    assert.equal(safeCallbackPath('https://chat.example/invite/abc?x=1#y', origin), '/invite/abc?x=1#y', 'middleware may report https');
    assert.equal(safeCallbackPath('/invite/abc', origin), '/invite/abc');
    for (const bad of ['https://evil.com/x', '//evil.com', '/\\evil.com', '/.//evil.com', '/..//evil.com', '/a/..//evil.com', 'javascript:alert(1)', null]) {
      assert.equal(safeCallbackPath(bad, origin), '/', String(bad));
    }
  });

  await t.test('only admins grant or revoke through /api/acp', async () => {
    const acp = await import('../app/api/acp/route');
    t.after(() => clearInterval((globalThis as { __acpCleanupTimer?: NodeJS.Timeout }).__acpCleanupTimer));
    configStore.createAgent({ id: 'bobs', name: 'bobs', owner: 'bob@contoso.com' });
    const cookie = await encode({ token: { email: 'bob@contoso.com', sub: 'bob', provider: 'azure-ad' }, secret: process.env.NEXTAUTH_SECRET! });
    const post = (body: Record<string, unknown>) => acp.POST(new NextRequest('http://localhost/api/acp', {
      method: 'POST',
      headers: { cookie: `next-auth.session-token=${cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'bobs', ...body }),
    }));
    assert.equal((await post({ action: 'add-agent-access', email: 'x@outside.com' })).status, 403);
    assert.equal((await post({ action: 'list-agent-access' })).status, 200, 'owners can still see who has access');
  });
});
