import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ENV_KEYS = ['ADMIN_EMAILS', 'MEMBER_EMAILS', 'GITHUB_ALLOWED_EMAILS', 'NEXTAUTH_SECRET', 'AZURE_AD_TENANT_ID', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'] as const;

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
  delete process.env.AZURE_AD_TENANT_ID;
  process.env.GITHUB_CLIENT_ID = 'test-client';
  process.env.GITHUB_CLIENT_SECRET = 'test-secret';

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

  await t.test('a MEMBER_EMAILS wildcard only admits accounts of a pinned Entra tenant', () => {
    process.env.MEMBER_EMAILS = '*';
    try {
      for (const tenant of [undefined, 'common', 'organizations', 'consumers']) {
        if (tenant === undefined) delete process.env.AZURE_AD_TENANT_ID;
        else process.env.AZURE_AD_TENANT_ID = tenant;
        assert.equal(resolveUserRole({ email: 'anyone@outside.com', provider: 'azure-ad' }, () => false), null, `tenant ${tenant}`);
      }
      process.env.AZURE_AD_TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';
      assert.equal(resolveUserRole({ email: 'anyone@outside.com', provider: 'azure-ad' }, () => false), 'member');
      assert.equal(resolveUserRole({ email: 'anyone@outside.com', provider: 'github' }, () => false), null);
      assert.equal(resolveUserRole({ email: 'anyone@outside.com', provider: 'github' }, () => true), 'guest');
    } finally {
      process.env.MEMBER_EMAILS = '@contoso.com,partner@fabrikam.com';
      delete process.env.AZURE_AD_TENANT_ID;
    }
  });

  await t.test('without ADMIN_EMAILS or MEMBER_EMAILS nobody signs in except admin-granted users', async () => {
    const signIn = authOptions.callbacks!.signIn!;
    for (const key of ['ADMIN_EMAILS', 'MEMBER_EMAILS', 'GITHUB_ALLOWED_EMAILS'] as const) delete process.env[key];
    try {
      assert.equal(getUserRole({ email: 'bob@contoso.com', provider: 'azure-ad' }), null);
      assert.equal(await signIn({ user: { email: 'bob@contoso.com' }, account: { provider: 'azure-ad' }, profile: { email: 'bob@contoso.com' } } as never), '/login?error=NotAuthorized');
      assert.notEqual(await signIn({ user: { email: 'bob@contoso.com' }, account: { provider: 'github' }, profile: { email: 'bob@contoso.com' } } as never), true);
      assert.equal(await signIn({ user: { email: 'guest@outside.com' }, account: { provider: 'azure-ad' }, profile: { email: 'guest@outside.com' } } as never), true, 'an agent grant still admits its guest');
    } finally {
      process.env.ADMIN_EMAILS = 'admin@contoso.com';
      process.env.MEMBER_EMAILS = '@contoso.com,partner@fabrikam.com';
      process.env.GITHUB_ALLOWED_EMAILS = 'gh-member@example.com';
    }
  });

  await t.test('GitHub accounts without a public email fall back to the id-based noreply address', async () => {
    const github = authOptions.providers.find((provider) => provider.id === 'github');
    assert.ok(github);
    const profile = (github as unknown as { options: { profile: (p: unknown, t: unknown) => { email: string } } }).options.profile;
    assert.equal(profile({ id: 42, login: 'octo', email: null }, {}).email, '42+octo@users.noreply.github.com');
  });

  await t.test('owners demoted to guest can no longer manage their agent', async () => {
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'rbac-test-secret';
    const { encode } = await import('next-auth/jwt');
    const { NextRequest } = await import('next/server');
    const acp = await import('../app/api/acp/route');
    t.after(() => clearInterval((globalThis as { __acpCleanupTimer?: NodeJS.Timeout }).__acpCleanupTimer));
    configStore.createAgent({ id: 'demoted-own', name: 'demoted-own', owner: 'demoted@outside.com' });
    configStore.addAgentAccess('demoted-own', 'demoted@outside.com', 'admin@contoso.com');
    const cookie = await encode({ token: { email: 'demoted@outside.com', sub: 'demoted', provider: 'azure-ad' }, secret: process.env.NEXTAUTH_SECRET! });
    const call = (body: Record<string, unknown>) => acp.POST(new NextRequest('http://localhost/api/acp', {
      method: 'POST',
      headers: { cookie: `next-auth.session-token=${cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'demoted-own', ...body }),
    }));
    assert.equal(getUserRole({ email: 'demoted@outside.com' }), 'guest');
    for (const body of [
      { action: 'update-agent-config', cwd: '/' },
      { action: 'delete-agent' },
      { action: 'add-agent-access', email: 'friend@outside.com' },
      { action: 'remove-agent-access', email: 'demoted@outside.com' },
      { action: 'list-agent-access' },
      { action: 'acp-authenticate', methodId: 'x' },
    ]) {
      assert.equal((await call(body)).status, 403, body.action);
    }
    assert.ok(configStore.getAgentById('demoted-own'), 'the agent is untouched');
    configStore.deleteAgent('demoted-own');
  });

  await t.test('sessions recorded in another user\'s chat are recognised as theirs', async () => {
    const chatStore = await import('../lib/chatStore');
    await chatStore.saveChat('alice@contoso.com', { id: 'c1', name: 'c1', ts: 1, messages: [], agentSessions: { shared: ['s-old', 's-alice'] } } as never);
    assert.equal(chatStore.isAgentSessionOwnedByOtherUser('bob@contoso.com', 'shared', 's-alice'), true);
    assert.equal(chatStore.isAgentSessionOwnedByOtherUser('bob@contoso.com', 'shared', 's-old'), true);
    assert.equal(chatStore.isAgentSessionOwnedByOtherUser('alice@contoso.com', 'shared', 's-alice'), false);
    assert.equal(chatStore.isAgentSessionOwnedByOtherUser('bob@contoso.com', 'public', 's-alice'), false);
    assert.equal(chatStore.isAgentSessionOwnedByOtherUser('bob@contoso.com', 'shared', 's-bob'), false);
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

  await t.test('roles granted in the UI apply immediately and override stale token claims', async () => {
    const entra = { email: 'carol@outside.com', provider: 'azure-ad' };
    assert.equal(getUserRole(entra), null);

    configStore.setUserRole('Carol@Outside.com', 'member', 'admin@contoso.com');
    assert.equal(getUserRole(entra), 'member');
    assert.equal(getUserRole({ ...entra, provider: 'github' }), 'member', 'explicit UI roles admit GitHub users');
    assert.deepEqual(usableAgents(entra).map((agent) => agent.id), ['public']);

    configStore.setUserRole('carol@outside.com', 'admin', 'admin@contoso.com');
    assert.equal(getUserRole(entra), 'admin');
    assert.equal(getUserRole({ ...entra, role: 'user' }), 'admin', 'promotion does not wait for a token refresh');

    const signIn = authOptions.callbacks!.signIn!;
    assert.equal(await signIn({ user: { email: 'carol@outside.com' }, account: { provider: 'github' }, profile: { email: 'carol@outside.com' } } as never), true);

    const jwt = authOptions.callbacks!.jwt!;
    const refreshed = await jwt({ token: { email: 'carol@outside.com', provider: 'azure-ad', sub: 'carol' } } as never);
    assert.equal(refreshed.role, 'admin');

    assert.equal(configStore.removeUserRole('carol@outside.com'), true);
    assert.equal(getUserRole({ ...entra, role: 'admin' }), null, 'a stale admin claim on an OAuth token is ignored');
    assert.equal(getUserRole({ email: 'carol@outside.com', role: 'admin' }), null, 'nor is one on a provider-less token');
    assert.equal((await jwt({ token: { ...refreshed } } as never)).role, 'user');
  });

  await t.test('/api/users is admin-only and protects env admins and the caller', async () => {
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'rbac-test-secret';
    const { encode } = await import('next-auth/jwt');
    const { NextRequest } = await import('next/server');
    const route = await import('../app/api/users/route');
    const request = async (email: string, method: string, query = '', body?: unknown) => {
      const cookie = await encode({ token: { email, sub: email, provider: 'azure-ad' }, secret: process.env.NEXTAUTH_SECRET! });
      return new NextRequest(`http://localhost/api/users${query}`, {
        method,
        headers: { cookie: `next-auth.session-token=${cookie}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };

    assert.equal((await route.GET(await request('bob@contoso.com', 'GET'))).status, 403, 'members cannot list roles');
    assert.equal((await route.POST(await request('bob@contoso.com', 'POST', '', { email: 'x@y.com', role: 'admin' }))).status, 403, 'members cannot grant roles');

    const created = await route.POST(await request('admin@contoso.com', 'POST', '', { email: 'Dave@Outside.com', role: 'member' }));
    assert.equal(created.status, 200);
    const users = (await created.json()).users as { email: string; role: string; sources: string[]; uiRole: string | null; grantedBy?: string }[];
    const dave = users.find((user) => user.email === 'dave@outside.com');
    assert.deepEqual([dave?.role, dave?.sources, dave?.uiRole, dave?.grantedBy], ['member', ['ui'], 'member', 'admin@contoso.com']);
    assert.ok(users.some((user) => user.email === 'guest@outside.com' && user.role === 'guest' && user.sources.includes('grant')));
    assert.equal(getUserRole({ email: 'dave@outside.com' }), 'member');

    const post = async (email: string, role: unknown) => route.POST(await request('admin@contoso.com', 'POST', '', { email, role }));
    assert.equal((await post('not-an-email', 'member')).status, 400);
    assert.equal((await post('eve@outside.com', 'guest')).status, 400, 'guests come from agent grants only');
    assert.equal((await post('admin@contoso.com', 'member')).status, 400, 'admins cannot change their own role');
    process.env.ADMIN_EMAILS = 'admin@contoso.com,env-admin@contoso.com';
    try {
      assert.equal((await post('env-admin@contoso.com', 'member')).status, 409, 'env admins are managed in env');
    } finally {
      process.env.ADMIN_EMAILS = 'admin@contoso.com';
    }

    assert.equal((await route.DELETE(await request('admin@contoso.com', 'DELETE', '?email=admin%40contoso.com'))).status, 400);
    const daveRemoved = await route.DELETE(await request('admin@contoso.com', 'DELETE', '?email=dave%40outside.com'));
    assert.equal(daveRemoved.status, 200);
    assert.equal((await daveRemoved.json()).remaining, null);
    assert.equal((await route.DELETE(await request('admin@contoso.com', 'DELETE', '?email=dave%40outside.com'))).status, 404);
    assert.equal(getUserRole({ email: 'dave@outside.com' }), null);

    const erinPost = await (await post('erin@contoso.com', 'admin')).json();
    const erin = erinPost.users.find((user: { email: string }) => user.email === 'erin@contoso.com');
    assert.deepEqual([erin.role, erin.sources.sort(), erin.envMember], ['admin', ['env', 'ui'], '@contoso.com']);
    const removed = await (await route.DELETE(await request('admin@contoso.com', 'DELETE', '?email=erin%40contoso.com'))).json();
    assert.deepEqual(removed.remaining, { role: 'member', envMember: '@contoso.com' }, 'a domain pattern keeps the user a member');
    assert.ok(removed.users.some((user: { email: string; sources: string[] }) => user.email === 'erin@contoso.com' && user.sources.join() === 'env'));
    assert.equal(getUserRole({ email: 'erin@contoso.com' }), 'member');
  });
});
