import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ENV_KEYS = ['ADMIN_EMAILS', 'MEMBER_EMAILS', 'GITHUB_ALLOWED_EMAILS'] as const;

test('role-based access control', async (t) => {
  const originalCwd = process.cwd();
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(path.join(tmpdir(), 'agents-chat-rbac-'));
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may still hold the file on Windows */ }
  });

  process.env.ADMIN_EMAILS = 'admin@contoso.com';
  process.env.MEMBER_EMAILS = '@contoso.com,partner@fabrikam.com';
  process.env.GITHUB_ALLOWED_EMAILS = 'gh-member@example.com';

  const configStore = await import('../lib/configStore');
  const { isMemberEmail, resolveUserRole } = await import('../lib/auth');
  const { canUseAgent, denyRole, getUserRole, usableAgents } = await import('../lib/rbac');
  const { authOptions } = await import('../app/api/auth/[...nextauth]/route');

  configStore.createAgent({ id: 'private', name: 'private', owner: 'admin@contoso.com' });
  configStore.createAgent({ id: 'public', name: 'public', owner: 'admin@contoso.com', public: true });
  configStore.createAgent({ id: 'shared', name: 'shared', owner: 'admin@contoso.com' });
  configStore.addAgentAccess('shared', 'guest@outside.com', 'admin@contoso.com');
  configStore.addAgentAccess('shared', 'ghguest@outside.com', 'admin@contoso.com');

  await t.test('member patterns match exact emails, domains and the wildcard', () => {
    assert.equal(isMemberEmail('Bob@Contoso.com', '@contoso.com', ''), true);
    assert.equal(isMemberEmail('bob@notcontoso.com', '@contoso.com', ''), false);
    assert.equal(isMemberEmail('partner@fabrikam.com', 'partner@fabrikam.com', ''), true);
    assert.equal(isMemberEmail('anyone@example.com', '*', ''), true);
    assert.equal(isMemberEmail('gh@example.com', '', 'gh@example.com'), true);
    assert.equal(isMemberEmail('', '*', ''), false);
  });

  await t.test('roles resolve admin, member, guest, then nobody', () => {
    assert.equal(getUserRole({ email: 'admin@contoso.com' }), 'admin');
    assert.equal(getUserRole({ role: 'admin', sub: 'admin' }), 'admin');
    assert.equal(getUserRole({ email: 'bob@contoso.com' }), 'member');
    assert.equal(getUserRole({ email: 'gh-member@example.com', provider: 'github' }), 'member');
    assert.equal(getUserRole({ email: 'guest@outside.com' }), 'guest');
    assert.equal(getUserRole({ email: 'stranger@outside.com' }), null);
    assert.equal(getUserRole(null), null);
  });

  await t.test('a MEMBER_EMAILS wildcard never admits GitHub accounts', () => {
    process.env.MEMBER_EMAILS = '*';
    try {
      assert.equal(resolveUserRole({ email: 'anyone@outside.com' }, () => false), 'member');
      assert.equal(resolveUserRole({ email: 'anyone@outside.com', provider: 'github' }, () => false), null);
      assert.equal(resolveUserRole({ email: 'anyone@outside.com', provider: 'github' }, () => true), 'guest');
    } finally {
      process.env.MEMBER_EMAILS = '@contoso.com,partner@fabrikam.com';
    }
  });

  await t.test('guests only use agents explicitly shared with them', () => {
    const guest = { email: 'guest@outside.com' };
    assert.deepEqual(usableAgents(guest).map((agent) => agent.id), ['shared']);
    assert.equal(canUseAgent(guest, { id: 'public', owner: 'admin@contoso.com', public: true }), false);
    assert.equal(canUseAgent(guest, { id: 'private', owner: 'admin@contoso.com', public: false }), false);

    const member = { email: 'bob@contoso.com' };
    assert.deepEqual(usableAgents(member).map((agent) => agent.id), ['public']);
    assert.deepEqual(usableAgents({ email: 'admin@contoso.com' }).map((agent) => agent.id).sort(), ['private', 'public', 'shared']);
    assert.deepEqual(usableAgents({ email: 'stranger@outside.com' }), []);
  });

  await t.test('denyRole distinguishes forbidden roles from unknown users', async () => {
    assert.equal(denyRole({ email: 'bob@contoso.com' }, ['admin', 'member']), null);
    const forbidden = denyRole({ email: 'guest@outside.com' }, ['admin', 'member']);
    assert.equal(forbidden?.status, 403);
    assert.equal((await forbidden?.json())?.error, 'forbidden');
    const unknown = denyRole({ email: 'stranger@outside.com' });
    assert.equal(unknown?.status, 403);
    assert.equal((await unknown?.json())?.error, 'not_authorized');
  });

  await t.test('sign-in admits only users with a role', async () => {
    const signIn = authOptions.callbacks?.signIn;
    assert.ok(signIn);
    const entra = (email: string) => signIn({ user: { email }, account: { provider: 'azure-ad' }, profile: { email } } as never);
    const github = (email: string) => signIn({ user: { email }, account: { provider: 'github' }, profile: { email } } as never);

    assert.equal(await entra('bob@contoso.com'), true);
    assert.equal(await entra('guest@outside.com'), true);
    assert.equal(await entra('stranger@outside.com'), '/login?error=NotAuthorized');
    assert.equal(await github('ghguest@outside.com'), true, 'a GitHub user with a share grant may sign in');
    assert.equal(await github('bob@contoso.com'), true, 'MEMBER_EMAILS domains also admit GitHub users');
    assert.equal(await github('stranger@outside.com'), false);

    process.env.MEMBER_EMAILS = '*';
    try {
      assert.equal(await github('stranger@outside.com'), false, 'the wildcard does not open GitHub sign-in');
    } finally {
      process.env.MEMBER_EMAILS = '@contoso.com,partner@fabrikam.com';
    }
  });
});
