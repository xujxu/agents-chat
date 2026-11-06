// Teams bridge behavior with Bot Connector, Entra ID and /api/acp mocked; data is written to a temp dir.
// Runs in CI (.github/workflows/teams-bot.yml). Locally: npx --yes --package=tsx@4.20.6 tsx --test tests/teams-bot-bridge.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Call = { url: string; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const TENANT = 'tenant-1';
const BOT_ID = '28:bot-app';
const SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
const botMention = { type: 'mention', text: '<at>agent-xujx</at>', mentioned: { id: BOT_ID, name: 'agent-xujx' } };
const bobMention = { type: 'mention', text: '<at>Bob</at>', mentioned: { id: '29:bob', name: 'Bob' } };

const calls: Call[] = [];
const sentMessageIds = new Map<string, string>();
const pendingRequests = new Map<string, { id: string; options: { optionId: string; label: string }[] }>();
const holdOpen = new Set<string>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
  calls.push({ url, body });
  if (url.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'test-token', expires_in: 3600 });
  if (url.includes('/members/')) {
    const id = decodeURIComponent(url.split('/members/')[1]);
    if (id === '29:external') return json({ id, email: 'x@other.com', tenantId: 'other-tenant' });
    if (id === '29:anon') return json({ id, userRole: 'anonymous', tenantId: TENANT });
    if (id === '29:noemail') return json({ id, name: 'No Email', tenantId: TENANT });
    if (id === '29:broken') return json({ error: 'boom' }, 500);
    return json({ id, email: `${id.slice(3)}@contoso.com`, name: id.slice(3), tenantId: TENANT, aadObjectId: `aad-${id}` });
  }
  if (url.startsWith(SERVICE_URL)) return json({ id: `act-${calls.length}` });
  if (url.endsWith('/api/acp')) {
    const { action, chatId } = body;
    if (action === 'send') { sentMessageIds.set(chatId, body.messageId); return json({ ok: true }); }
    if (action === 'poll') {
      const userRequest = pendingRequests.get(chatId);
      const done = !holdOpen.has(chatId);
      return json({ ok: true, activeTurn: { messageId: sentMessageIds.get(chatId), fullText: 'answer', done, ...(userRequest ? { userRequest } : {}) } });
    }
    if (action === 'respond-user-request') { pendingRequests.delete(chatId); holdOpen.delete(chatId); }
    if (action === 'interrupt') holdOpen.delete(chatId);
    return json({ ok: true });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const config = {
  appId: 'bot-app', appSecret: 'test-secret', tokenVault: '', tokenSecretName: 'teams-bot-token',
  tenantId: TENANT, authTenant: TENANT, agentId: 'teams', allowedUsers: ['alice@contoso.com', 'bob@contoso.com'], internalBaseUrl: 'http://127.0.0.1:9',
};

let seq = 0;
function activity(from: string, text: string, entities: unknown[], conversationType = 'groupChat', conversationId = 'group-1') {
  return {
    type: 'message', id: `in-${++seq}`, serviceUrl: SERVICE_URL, text, entities,
    conversation: { id: conversationId, conversationType, tenantId: TENANT }, channelData: { tenant: { id: TENANT } },
    from: { id: from, name: from.slice(3), aadObjectId: `aad-${from}` }, recipient: { id: BOT_ID, name: 'agent-xujx' },
  };
}

function since(start: number) {
  const slice = calls.slice(start);
  return {
    posts: slice.filter((c) => c.url.startsWith(SERVICE_URL) && !c.url.includes('/members/')).map((c) => c.body),
    acp: slice.filter((c) => c.url.endsWith('/api/acp')).map((c) => c.body),
  };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main() {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-chat-teams-'));
  process.env.NEXTAUTH_SECRET = 'test-only-nextauth-secret-0123456789';
  try {
    process.chdir(dir);
    const { handleActivity } = await import('../lib/channels/teams/bridge');
    const run = async (act: ReturnType<typeof activity>) => { const start = calls.length; await handleActivity(act, config); return since(start); };

    // Group chat: messages that do not @mention the bot are ignored entirely.
    let r = await run(activity('29:alice', 'just chatting', []));
    assert.deepEqual([r.posts.length, r.acp.length], [0, 0], 'no mention');
    r = await run(activity('29:alice', '<at>Bob</at> hi', [bobMention]));
    assert.deepEqual([r.posts.length, r.acp.length], [0, 0], 'mention of someone else');
    r = await run(activity('29:alice', '<at>agent-xujx</at> hi', [{ type: 'mention', text: '<at>agent-xujx</at>', mentioned: { id: '28:other-bot' } }]));
    assert.deepEqual([r.posts.length, r.acp.length], [0, 0], 'mention text without the bot id');

    // Group chat: an @mention runs a turn with the bot mention stripped and other names kept.
    r = await run(activity('29:alice', '<at>agent-xujx</at> what is up with <at>Bob</at>?', [botMention, bobMention]));
    assert.deepEqual(r.acp.map((a) => a.action), ['send', 'poll', 'turn-clear']);
    assert.equal(r.acp[0].text, 'what is up with Bob?');
    assert.ok(r.posts.length > 0 && r.posts.every((p) => typeof p.replyToId === 'string'), 'group replies thread to the asker message');
    const aliceChatId = r.acp[0].chatId;

    // Plain replies in a group @mention the asker.
    r = await run(activity('29:bob', '<at>agent-xujx</at> /help', [botMention]));
    assert.equal(r.acp.length, 0);
    assert.equal(r.posts.length, 1);
    assert.match(r.posts[0].text, /^<at>bob<\/at> In this group chat I only respond/);
    assert.deepEqual(r.posts[0].entities, [{ type: 'mention', text: '<at>bob</at>', mentioned: { id: '29:bob', name: 'bob' } }]);

    // A bare @mention shows the group help.
    r = await run(activity('29:bob', '<at>agent-xujx</at>', [botMention]));
    assert.equal(r.posts.length, 1);
    assert.match(r.posts[0].text, /only respond when you \*\*@mention\*\* me/);

    // Per-user state: Bob cannot answer Alice's pending question; Alice can.
    holdOpen.add(aliceChatId);
    pendingRequests.set(aliceChatId, { id: 'req-1', options: [{ optionId: 'allow', label: 'Allow' }, { optionId: 'deny', label: 'Deny' }] });
    const aliceStart = calls.length;
    const aliceTurn = handleActivity(activity('29:alice', '<at>agent-xujx</at> deploy it', [botMention]), config);
    await waitFor(() => since(aliceStart).posts.some((p) => p.type === 'message' && /Allow/.test(p.text || '')), 'Alice permission prompt');
    const prompt = since(aliceStart).posts.find((p) => p.type === 'message' && /Allow/.test(p.text || ''));
    assert.match(prompt.text, /^<at>alice<\/at> /);
    assert.match(prompt.text, /@mention me with your reply/);

    r = await run(activity('29:bob', '<at>agent-xujx</at> 1', [botMention]));
    assert.ok(!r.acp.some((a) => a.action === 'respond-user-request'), 'Bob must not answer Alice\'s request');
    assert.ok(r.acp.some((a) => a.action === 'send' && a.chatId !== aliceChatId && a.text === '1'), 'Bob gets his own chat');

    r = await run(activity('29:alice', '<at>agent-xujx</at> 1', [botMention]));
    assert.deepEqual(r.acp.map((a) => [a.action, a.chatId, a.optionId]), [['respond-user-request', aliceChatId, 'allow']]);
    await aliceTurn;

    // Anyone who may not use the bot gets no reply at all, so the bot does not reveal itself:
    // other organizations, anonymous users, accounts without an email, failed roster lookups,
    // and users not in TEAMS_ALLOWED_USERS, in group chats and 1:1 chats.
    for (const from of ['29:external', '29:anon', '29:noemail', '29:broken', '29:carol']) {
      r = await run(activity(from, '<at>agent-xujx</at> hi', [botMention]));
      assert.deepEqual([r.posts.length, r.acp.length], [0, 0], `${from} (group)`);
      r = await run(activity(from, 'hi', [], 'personal', `personal-${from}`));
      assert.deepEqual([r.posts.length, r.acp.length], [0, 0], `${from} (1:1)`);
    }

    // Deny by default: an empty allow-list ignores everyone, including previously allowed users.
    r = await (async () => { const start = calls.length; await handleActivity(activity('29:alice', 'hi', [], 'personal', 'personal-1'), { ...config, allowedUsers: [] }); return since(start); })();
    assert.deepEqual([r.posts.length, r.acp.length], [0, 0], 'empty allow-list');

    // Team channels: silent unless an allowed user mentions the bot, then a short notice.
    r = await run(activity('29:alice', 'hi', [], 'channel', 'channel-1'));
    assert.deepEqual([r.posts.length, r.acp.length], [0, 0]);
    r = await run(activity('29:carol', '<at>agent-xujx</at> hi', [botMention], 'channel', 'channel-1'));
    assert.deepEqual([r.posts.length, r.acp.length], [0, 0], 'unlisted user in a channel');
    r = await run(activity('29:alice', '<at>agent-xujx</at> hi', [botMention], 'channel', 'channel-1'));
    assert.equal(r.acp.length, 0);
    assert.equal(r.posts[0].text, 'I only work in 1:1 chats and group chats.');

    // 1:1 chats are unchanged: no mention needed, and replies do not @mention the user.
    r = await run(activity('29:alice', 'hello', [], 'personal', 'personal-1'));
    assert.deepEqual(r.acp.map((a) => a.action), ['send', 'poll', 'turn-clear']);
    assert.equal(r.acp[0].text, 'hello');
    assert.ok(r.posts.every((p) => !(p.entities || []).some((e: { type?: string }) => e.type === 'mention')));
    r = await run(activity('29:alice', '/help', [], 'personal', 'personal-1'));
    assert.doesNotMatch(r.posts[0].text, /group chat|<at>/);

    // Turns use the same model as the web UI: the user's saved choice, else the agent default.
    // Without a configured agent no model is sent (the line above ran before any agent existed).
    const configStore = await import('../lib/configStore');
    const sendModel = async () => (await run(activity('29:alice', 'model?', [], 'personal', 'personal-1'))).acp.find((a) => a.action === 'send')?.modelId;
    assert.equal(await sendModel(), undefined, 'no agent configured');
    configStore.createAgent({ id: 'teams', name: 'teams', owner: 'alice@contoso.com', models: [{ modelId: 'claude-sonnet-5.5' }, { modelId: 'claude-opus-5.5' }], defaultModelId: 'claude-sonnet-5.5' });
    assert.equal(await sendModel(), 'claude-sonnet-5.5', 'agent default');
    configStore.setUserAgentModelPref('alice@contoso.com', 'teams', 'claude-opus-5.5');
    assert.equal(await sendModel(), 'claude-opus-5.5', 'user model choice');
    r = await run(activity('29:alice', '/whoami', [], 'personal', 'personal-1'));
    assert.match(r.posts[0].text, /Model: `claude-opus-5\.5`/);
    configStore.setUserAgentModelPref('alice@contoso.com', 'teams', 'retired-model');
    assert.equal(await sendModel(), 'claude-sonnet-5.5', 'unknown saved model falls back to the default');

    // /model lists models and switches the user's saved choice (shared with the web UI).
    configStore.updateAgent('teams', { models: [{ modelId: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' }, { modelId: 'claude-opus-5.5', name: 'Claude Opus 5.5' }, { modelId: 'gpt-6.1-sol' }] });
    const model = async (text: string) => { const res = await run(activity('29:alice', text, [], 'personal', 'personal-1')); assert.equal(res.acp.length, 0, text); return res.posts[0].text as string; };
    let reply = await model('/model');
    assert.match(reply, /1\. Claude Sonnet 5\.5 \(`claude-sonnet-5\.5`\) ✅\n2\. Claude Opus 5\.5 \(`claude-opus-5\.5`\)\n3\. `gpt-6\.1-sol`/);
    assert.match(await model('/model 2'), /Model set to Claude Opus 5\.5/);
    assert.equal(configStore.getUserAgentModelPref('alice@contoso.com', 'teams'), 'claude-opus-5.5');
    assert.equal(await sendModel(), 'claude-opus-5.5', 'switched by number');
    assert.match(await model('/model GPT'), /Model set to `gpt-6\.1-sol`/);
    assert.equal(await sendModel(), 'gpt-6.1-sol', 'switched by unique partial name');
    reply = await model('/model claude');
    assert.match(reply, /matches several models/);
    assert.match(await model('/model nope'), /No model matches "nope"/);
    assert.match(await model('/model 9'), /No model matches "9"/);
    assert.equal(configStore.getUserAgentModelPref('alice@contoso.com', 'teams'), 'gpt-6.1-sol', 'failed lookups keep the choice');
    assert.match(await model('/model Claude Sonnet 5.5'), /Model set to Claude Sonnet 5\.5/);
    // Bob's choice is his own, even in the same group chat.
    r = await run(activity('29:bob', '<at>agent-xujx</at> /model opus', [botMention]));
    assert.match(r.posts[0].text, /Model set to Claude Opus 5\.5/);
    assert.equal(configStore.getUserAgentModelPref('alice@contoso.com', 'teams'), 'claude-sonnet-5.5');
    assert.equal(configStore.getUserAgentModelPref('bob@contoso.com', 'teams'), 'claude-opus-5.5');

    // Welcome messages go only to allowed users who install the bot or add it to a group chat.
    const welcomeFor = async (from: string, conversationType: string, conversationId: string) => {
      const start = calls.length;
      await handleActivity({ ...activity(from, '', [], conversationType, conversationId), type: 'conversationUpdate', membersAdded: [{ id: BOT_ID }] }, config);
      return since(start).posts;
    };
    let welcome = await welcomeFor('29:alice', 'groupChat', 'group-1');
    assert.equal(welcome.length, 1);
    assert.match(welcome[0].text, /@mention me with your question/);
    assert.equal(welcome[0].replyToId, undefined);
    welcome = await welcomeFor('29:alice', 'personal', 'personal-1');
    assert.equal(welcome.length, 1);
    assert.match(welcome[0].text, /I connect you to the/);
    for (const from of ['29:carol', '29:external']) {
      assert.equal((await welcomeFor(from, 'groupChat', 'group-2')).length, 0, `${from} adds bot to a group`);
      assert.equal((await welcomeFor(from, 'personal', `personal-${from}`)).length, 0, `${from} installs bot`);
    }

    console.log('teams bot bridge checks passed');
  } finally {
    process.chdir(originalCwd);
    try { (await import('../lib/chatStore')).getDb().close(); } catch { /* not opened */ }
    // configStore keeps its SQLite handle open, so Windows may refuse to delete the temp dir.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
