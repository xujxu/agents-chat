// Teams reminders for shared agents, with Bot Connector and Entra ID mocked; data is written to a temp dir.
// Runs in CI (.github/workflows/checks.yml). Locally: npx --yes --package=tsx@4.20.6 tsx --test tests/teams-share-reminders.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TENANT = 'tenant-1';
const SERVICE_URL = 'https://smba.trafficmanager.net/amer/';

type Post = { conversationId: string; text: string };
const posts: Post[] = [];
const goneConversations = new Set<string>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'test-token', expires_in: 3600 });
  if (url.includes('/members/')) {
    const id = decodeURIComponent(url.split('/members/')[1]);
    return json({ id, email: `${id.slice(3)}@contoso.com`, name: id.slice(3), tenantId: TENANT, aadObjectId: `aad-${id}` });
  }
  const match = url.match(/\/v3\/conversations\/([^/]+)\/activities/);
  if (url.startsWith(SERVICE_URL) && match) {
    const conversationId = decodeURIComponent(match[1]);
    if (goneConversations.has(conversationId)) return json({ error: { code: 'BotNotInConversationRoster' } }, 403);
    posts.push({ conversationId, text: JSON.parse(String(init?.body)).text });
    return json({ id: `act-${posts.length}` });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const config = {
  appId: 'bot-app', appSecret: 'test-secret', tokenVault: '', tokenSecretName: 'teams-bot-token',
  tenantId: TENANT, authTenant: TENANT, agentId: 'teams',
  allowedUsers: ['alice@contoso.com', 'bob@contoso.com', 'admin@contoso.com', 'boss@contoso.com', 'dave@contoso.com'], internalBaseUrl: 'http://127.0.0.1:9',
};

function personalChat(email: string) {
  const name = email.split('@')[0];
  return { serviceUrl: SERVICE_URL, conversationId: `dm-${name}`, botId: '28:bot-app', userId: `29:${name}`, userName: name };
}

async function main() {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-chat-reminders-'));
  process.env.NEXTAUTH_SECRET = 'test-only-nextauth-secret-0123456789';
  process.env.MEMBER_EMAILS = '@contoso.com';
  process.env.ADMIN_EMAILS = 'admin@contoso.com';
  process.env.NEXTAUTH_URL = 'https://chat.contoso.com/';
  try {
    process.chdir(dir);
    const configStore = await import('../lib/configStore');
    const { sendShareReminders } = await import('../lib/channels/teams/shareReminders');
    const { handleActivity } = await import('../lib/channels/teams/bridge');
    const { default: Database } = await import('better-sqlite3');

    configStore.createAgent({ id: 'research', name: 'Research', owner: 'admin@contoso.com' });
    const db = new Database(path.join(dir, '.data', 'config.db'));
    const expireIn = (email: string, modifier: string) =>
      db.prepare(`UPDATE agent_access SET expires_at = datetime('now', ?) WHERE agent_id = 'research' AND email = ?`).run(modifier, email);
    const share = (email: string, modifier = '+2 days') => {
      configStore.addAgentAccess('research', email, 'admin@contoso.com');
      assert.ok(configStore.acceptAgentInvite('research', email));
      expireIn(email, modifier);
    };
    const runOnce = async () => { const start = posts.length; const result = await sendShareReminders(config); return { result, posts: posts.slice(start) }; };

    // The bridge remembers 1:1 chats with allowed people, but not group chats.
    const message = (from: string, conversationType: string, conversationId: string) => ({
      type: 'message', id: `in-${conversationId}`, serviceUrl: SERVICE_URL, text: '/help', entities: [],
      conversation: { id: conversationId, conversationType, tenantId: TENANT }, channelData: { tenant: { id: TENANT } },
      from: { id: from, name: from.slice(3), aadObjectId: `aad-${from}` }, recipient: { id: '28:bot-app', name: 'agent-xujx' },
    });
    await handleActivity(message('29:bob', 'groupChat', 'group-1'), config);
    assert.equal(configStore.getTeamsConversation('bob@contoso.com'), null, 'group chats are not stored');
    await handleActivity(message('29:alice', 'personal', 'dm-alice'), config);
    assert.equal(configStore.getTeamsConversation('alice@contoso.com')?.conversationId, 'dm-alice');
    assert.equal(configStore.getTeamsConversation('alice@contoso.com')?.serviceUrl, SERVICE_URL);
    posts.length = 0;

    // Alice (reachable) is reminded once; Bob has no 1:1 chat; Carol is not in TEAMS_ALLOWED_USERS; Dave expires later.
    share('alice@contoso.com');
    share('bob@contoso.com');
    share('carol@contoso.com');
    configStore.saveTeamsConversation('carol@contoso.com', personalChat('carol@contoso.com'));
    share('dave@contoso.com', '+10 days');
    configStore.saveTeamsConversation('dave@contoso.com', personalChat('dave@contoso.com'));
    let r = await runOnce();
    assert.deepEqual(r.posts.map((p) => p.conversationId), ['dm-alice']);
    assert.match(r.posts[0].text, /Your access to the \*\*Research\*\* agent expires in 2 days/);
    assert.match(r.posts[0].text, /\[agents-chat\]\(https:\/\/chat\.contoso\.com\)/);
    r = await runOnce();
    assert.equal(r.posts.length, 0, 'each expiry is reminded only once');

    // An approved extension moves the expiry; the new expiry is reminded when it comes close.
    assert.ok(configStore.extendAgentAccess('research', 'alice@contoso.com', 30));
    r = await runOnce();
    assert.equal(r.posts.length, 0, 'no reminder right after an extension');
    expireIn('alice@contoso.com', '+1 days');
    r = await runOnce();
    assert.deepEqual(r.posts.map((p) => p.conversationId), ['dm-alice']);
    assert.match(r.posts[0].text, /expires in 1 day \(/);

    // Extension requests reach reachable admins (ADMIN_EMAILS and admin roles) once; no expiry reminder while pending.
    configStore.setUserRole('boss@contoso.com', 'admin', 'admin@contoso.com');
    configStore.saveTeamsConversation('admin@contoso.com', personalChat('admin@contoso.com'));
    configStore.saveTeamsConversation('boss@contoso.com', personalChat('boss@contoso.com'));
    expireIn('alice@contoso.com', '+2 days');
    db.prepare(`UPDATE agent_access SET expiry_reminded_for = NULL WHERE email = 'alice@contoso.com'`).run();
    assert.ok(configStore.requestAgentAccessExtension('research', 'alice@contoso.com', 30));
    r = await runOnce();
    assert.deepEqual(r.posts.map((p) => p.conversationId).sort(), ['dm-admin', 'dm-boss']);
    assert.match(r.posts[0].text, /\*\*alice@contoso\.com\*\* asked for 30 more days on the \*\*Research\*\* agent/);
    r = await runOnce();
    assert.equal(r.posts.length, 0, 'admins are told once per request');

    // No reachable admin: the notice waits for a later run.
    assert.ok(configStore.denyAgentAccessExtension('research', 'alice@contoso.com'));
    goneConversations.add('dm-admin');
    goneConversations.add('dm-boss');
    db.prepare(`UPDATE agent_access SET extension_requested_at = datetime('now', '+1 seconds'), extension_days = 30 WHERE email = 'alice@contoso.com'`).run();
    db.prepare(`UPDATE agent_access SET expiry_reminded_for = expires_at WHERE email = 'alice@contoso.com'`).run();
    r = await runOnce();
    assert.deepEqual([r.posts.length, r.result.failed], [0, 2]);
    // A 403 means the person removed the bot; their chat is forgotten until they message it again.
    assert.equal(configStore.getTeamsConversation('admin@contoso.com'), null);
    assert.equal(configStore.getTeamsConversation('boss@contoso.com'), null);
    goneConversations.clear();
    configStore.saveTeamsConversation('admin@contoso.com', personalChat('admin@contoso.com'));
    r = await runOnce();
    assert.deepEqual(r.posts.map((p) => p.conversationId), ['dm-admin'], 'retried once an admin is reachable');

    // Teams commands: /extend (recipients), /approve and /deny (admins), and the decision sent to the recipient.
    const say = async (email: string, text: string, conversationType = 'personal') => {
      const name = email.split('@')[0];
      const conversationId = conversationType === 'personal' ? `dm-${name}` : 'group-1';
      const activity = message(`29:${name}`, conversationType, conversationId);
      const start = posts.length;
      await handleActivity({ ...activity, id: `in-${posts.length}-${text}`, text: conversationType === 'personal' ? text : `<at>agent-xujx</at> ${text}`,
        entities: conversationType === 'personal' ? [] : [{ type: 'mention', mentioned: { id: '28:bot-app', name: 'agent-xujx' }, text: '<at>agent-xujx</at>' }] }, config);
      await new Promise((resolve) => setTimeout(resolve, 50)); // let background notices finish
      return posts.slice(start);
    };
    const reply = async (email: string, text: string, conversationType?: string) =>
      (await say(email, text, conversationType)).find((p) => p.conversationId === (conversationType ? 'group-1' : `dm-${email.split('@')[0]}`))?.text || '';
    assert.ok(configStore.denyAgentAccessExtension('research', 'alice@contoso.com'));
    configStore.saveTeamsConversation('boss@contoso.com', personalChat('boss@contoso.com'));
    configStore.saveTeamsConversation('bob@contoso.com', personalChat('bob@contoso.com'));
    configStore.saveTeamsConversation('dave@contoso.com', personalChat('dave@contoso.com'));

    assert.match(await reply('bob@contoso.com', '/extend', 'groupChat'), /1:1 chat/);
    assert.match(await reply('alice@contoso.com', '/extend'), /1\. \*\*Research\*\* – expires/);
    let sent = await say('alice@contoso.com', '/extend 1');
    assert.match(sent.find((p) => p.conversationId === 'dm-alice')!.text, /Asked for 30 more days on \*\*Research\*\*/);
    assert.deepEqual(sent.filter((p) => /^dm-(admin|boss)$/.test(p.conversationId)).map((p) => p.conversationId).sort(), ['dm-admin', 'dm-boss'], 'admins notified');
    assert.match(sent.find((p) => p.conversationId === 'dm-admin')!.text, /`\/approve`/);
    assert.match(await reply('alice@contoso.com', '/extend research'), /already asked/);
    assert.equal(configStore.listAgentAccessExtensionRequests().length, 1);

    assert.match(await reply('bob@contoso.com', '/approve'), /Only admins/);
    assert.match(await reply('admin@contoso.com', '/approve 1'), /Send `\/approve` first/);
    assert.match(await reply('admin@contoso.com', '/approve'), /1\. \*\*alice@contoso\.com\*\* – 30 more days on \*\*Research\*\*/);
    // Handled elsewhere (e.g. the web UI) after the list was shown: the stale number is refused.
    assert.ok(configStore.denyAgentAccessExtension('research', 'alice@contoso.com'));
    assert.match(await reply('admin@contoso.com', '/approve 1'), /already handled or changed/);

    const before = configStore.getAgentAccess('research', 'alice@contoso.com')!.expiresAt;
    await say('alice@contoso.com', '/extend 1');
    await reply('admin@contoso.com', '/approve');
    sent = await say('admin@contoso.com', '/approve 1');
    assert.match(sent.find((p) => p.conversationId === 'dm-admin')!.text, /Approved: \*\*alice@contoso\.com\*\* can use \*\*Research\*\* until/);
    assert.match(sent.find((p) => p.conversationId === 'dm-alice')!.text, /approved: you can use the \*\*Research\*\* agent until/);
    assert.ok(configStore.getAgentAccess('research', 'alice@contoso.com')!.expiresAt > before);
    assert.match(await reply('alice@contoso.com', '/extend 1'), /No matching agent|expires/);

    await say('bob@contoso.com', '/extend 1');
    await reply('boss@contoso.com', '/deny');
    sent = await say('boss@contoso.com', '/deny 1');
    assert.match(sent.find((p) => p.conversationId === 'dm-boss')!.text, /Denied the request from \*\*bob@contoso\.com\*\*/);
    assert.match(sent.find((p) => p.conversationId === 'dm-bob')!.text, /was denied/);
    assert.equal(configStore.listAgentAccessExtensionRequests().length, 0);

    // Dave's access is not close to expiring yet.
    assert.match(await reply('dave@contoso.com', '/extend research'), /from 3 days before/);

    db.close();
    console.log('teams share reminders: ok');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
