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
const turnedExternal = new Set<string>();
let sendDelayMs = 0;

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
    if (id === '29:external' || turnedExternal.has(id)) return json({ id, email: 'x@other.com', tenantId: 'other-tenant' });
    if (id === '29:anon') return json({ id, userRole: 'anonymous', tenantId: TENANT });
    if (id === '29:noemail') return json({ id, name: 'No Email', tenantId: TENANT });
    if (id === '29:broken') return json({ error: 'boom' }, 500);
    return json({ id, email: `${id.slice(3)}@contoso.com`, name: id.slice(3), tenantId: TENANT, aadObjectId: `aad-${id}` });
  }
  if (url.startsWith(SERVICE_URL)) return json({ id: `act-${calls.length}` });
  if (url.endsWith('/api/acp')) {
    const { action, chatId } = body;
    if (action === 'send') { if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs)); sentMessageIds.set(chatId, body.messageId); return json({ ok: true }); }
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
    const { handleActivity, SLOW_START_STATUS } = await import('../lib/channels/teams/bridge');
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
    // Replies say which agent answered (its id when the agent has no record).
    const finals = (posts: any[]) => posts.filter((p) => p.type === 'message').map((p) => p.text as string); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(finals(r.posts), ['*🤖 teams*\n\nanswer']);

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
    assert.match(prompt.text, /^<at>alice<\/at> \*🤖 teams\*\n\n/, 'question labeled with the agent name');
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

    // /agent lists the agents this user may talk to (same rule as the web UI) and switches the
    // agent for this conversation only. Each agent keeps its own chat.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    configStore.createAgent({ id: 'mcagent', name: 'MC Agent', owner: 'carol@contoso.com', public: true });
    await pause();
    configStore.createAgent({ id: 'secret', name: 'secret', owner: 'carol@contoso.com' });
    await pause();
    configStore.createAgent({ id: 'shared', name: 'shared', owner: 'carol@contoso.com' });
    configStore.addAgentAccess('shared', 'alice@contoso.com', 'carol@contoso.com');
    await pause();
    configStore.createAgent({ id: 'scheduler', name: 'scheduler', owner: 'alice@contoso.com' });
    const chatStore = await import('../lib/chatStore');
    const { conversationAgentKey } = await import('../lib/channels/teams/util');
    const say = async (text: string, from = '29:alice', conversation = 'personal-1') => run(activity(from, text, [], 'personal', conversation));
    const command = async (text: string) => { const res = await say(text); assert.equal(res.acp.length, 0, text); return res.posts[0].text as string; };
    const sendOf = (res: { acp: any[] }) => res.acp.find((a) => a.action === 'send'); // eslint-disable-line @typescript-eslint/no-explicit-any

    const teamsChatId = sendOf(await say('before switching')).chatId;
    reply = await command('/agent');
    assert.match(reply, /1\. `teams` – default ✅\n2\. MC Agent \(`mcagent`\)\n3\. `shared`\n/);
    assert.doesNotMatch(reply, /secret|scheduler/);
    reply = await command('/agent mc');
    assert.match(reply, /Now talking to MC Agent \(`mcagent`\)/);
    assert.match(reply, /next message starts a new conversation/);
    let sent = sendOf(await say('analyze the connector failure'));
    assert.equal(sent.agentId, 'mcagent');
    assert.notEqual(sent.chatId, teamsChatId);
    assert.equal(sent.modelId, undefined, 'models are per agent');
    const mcChatId = sent.chatId;
    assert.equal((await chatStore.getChat('alice@contoso.com', mcChatId))?.agentId, 'mcagent', 'web chat belongs to the agent');
    r = await say('follow-up');
    assert.equal(sendOf(r).chatId, mcChatId, 'agent chat continues');
    assert.deepEqual(finals(r.posts), ['*🤖 MC Agent*\n\nanswer'], 'reply labeled with the agent name');
    assert.match(await command('/whoami'), /Agent: \*\*mcagent\*\*/);
    assert.match(await command('/model'), /\*\*mcagent\*\* agent has no model list/);
    reply = await command('/agent');
    assert.match(reply, /1\. `teams` – default\n2\. MC Agent \(`mcagent`\) ✅/);

    // Other conversations and other people keep their own agent.
    assert.equal(sendOf(await say('elsewhere', '29:alice', 'personal-fast')).agentId, 'teams');
    r = await run(activity('29:bob', '<at>agent-xujx</at> /agent', [botMention]));
    assert.match(r.posts[0].text, /1\. MC Agent \(`mcagent`\)$/m);
    assert.doesNotMatch(r.posts[0].text, /`teams`|`shared`/, 'Bob sees only agents he may use');
    r = await run(activity('29:bob', '<at>agent-xujx</at> /agent shared', [botMention]));
    assert.match(r.posts[0].text, /No agent you can use matches "shared"/);
    r = await run(activity('29:bob', '<at>agent-xujx</at> hi', [botMention]));
    assert.equal(sendOf(r).agentId, 'teams');

    // Lookups that fail keep the current agent.
    assert.match(await command('/agent secret'), /No agent you can use matches "secret"/);
    assert.match(await command('/agent scheduler'), /No agent you can use matches/);
    assert.match(await command('/agent 9'), /No agent you can use matches "9"/);
    assert.match(await command('/agent a'), /matches several agents/);
    assert.equal(sendOf(await say('still mc')).agentId, 'mcagent');

    // /stop reaches the agent that is running the turn.
    holdOpen.add(mcChatId);
    const stopStart = calls.length;
    const mcTurn = handleActivity(activity('29:alice', 'long task', [], 'personal', 'personal-1'), config);
    await waitFor(() => since(stopStart).acp.some((a) => a.action === 'send'), 'mcagent send');
    r = await say('/stop');
    assert.deepEqual(r.acp.map((a) => [a.action, a.agentId, a.chatId]), [['interrupt', 'mcagent', mcChatId]]);
    await mcTurn;

    // Switching back resumes the earlier chat; /new only resets the current agent's chat.
    assert.match(await command('/agent 1'), /Now talking to `teams` – default .*earlier conversation with it continues/);
    r = await say('back to teams');
    assert.deepEqual(finals(r.posts), ['*🤖 teams*\n\nanswer']);
    sent = sendOf(r);
    assert.deepEqual([sent.agentId, sent.chatId], ['teams', teamsChatId]);
    assert.match(await command('/agent shared'), /Now talking to `shared`/);
    assert.match(await command('/new'), /Started a new conversation/);
    assert.equal(sendOf(await say('shared hi')).agentId, 'shared');
    await command('/agent mcagent');
    assert.equal(sendOf(await say('mc again')).chatId, mcChatId);

    // A removed agent falls back to the default.
    configStore.setUserSetting('alice@contoso.com', conversationAgentKey('personal-1'), 'removed-agent');
    sent = sendOf(await say('fallback'));
    assert.deepEqual([sent.agentId, sent.chatId], ['teams', teamsChatId]);

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

    // Latency: the "Thinking…" indicator is the first thing posted, before the agent is asked to start.
    const informatives = (posts: any[]) => posts.filter((p) => p.entities?.[0]?.streamType === 'informative').map((p) => p.text as string); // eslint-disable-line @typescript-eslint/no-explicit-any
    let start = calls.length;
    await handleActivity(activity('29:alice', 'quick', [], 'personal', 'personal-fast'), config);
    const fastCalls = calls.slice(start);
    assert.ok(fastCalls.findIndex((c) => c.url.startsWith(SERVICE_URL)) < fastCalls.findIndex((c) => c.body?.action === 'send'), 'indicator before send');
    assert.equal(informatives(since(start).posts)[0], 'teams is thinking…');

    // UX: while a cold agent starts (slow `send`), the status line explains the wait.
    const defaults = SLOW_START_STATUS.map((s) => s.afterMs);
    SLOW_START_STATUS[0].afterMs = 1600;
    SLOW_START_STATUS[1].afterMs = 3200;
    try {
      sendDelayMs = 3600;
      r = await run(activity('29:alice', 'slow', [], 'personal', 'personal-fast'));
      assert.deepEqual(informatives(r.posts), ['teams is thinking…', SLOW_START_STATUS[0].text, SLOW_START_STATUS[1].text]);
      // A fast send cancels the pending status lines.
      sendDelayMs = 0;
      start = calls.length;
      await handleActivity(activity('29:alice', 'fast', [], 'personal', 'personal-fast'), config);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.deepEqual(informatives(since(start).posts), ['teams is thinking…']);
    } finally {
      sendDelayMs = 0;
      SLOW_START_STATUS.forEach((s, i) => { s.afterMs = defaults[i]; });
    }

    // Identity cache: a known user is served from cache without waiting on the roster, and
    // re-checked in the background once due; someone who has left is then dropped.
    const identities = (globalThis as any).__teamsIdentities as Map<string, { refreshAt: number }>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const refreshes = (globalThis as any).__teamsIdentityRefreshes as Map<string, Promise<unknown>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const memberCalls = (from: number) => calls.slice(from).filter((c) => c.url.includes('/members/')).length;
    start = calls.length;
    r = await run(activity('29:bob', 'cached', [], 'personal', 'personal-bob'));
    assert.equal(memberCalls(start), 0, 'fresh identity: no roster lookup');
    turnedExternal.add('29:bob');
    identities.get('aad-29:bob')!.refreshAt = 0;
    start = calls.length;
    r = await run(activity('29:bob', 'still cached', [], 'personal', 'personal-bob'));
    assert.ok(r.acp.some((a) => a.action === 'send'), 'stale identity is still served');
    await waitFor(() => refreshes.size === 0, 'background identity refresh');
    assert.equal(memberCalls(start), 1, 'one background roster lookup');
    r = await run(activity('29:bob', 'after leaving', [], 'personal', 'personal-bob'));
    assert.deepEqual([r.posts.length, r.acp.length], [0, 0], 'user dropped after the background refresh');
    turnedExternal.delete('29:bob');
    r = await run(activity('29:bob', 'back', [], 'personal', 'personal-bob'));
    assert.ok(r.acp.some((a) => a.action === 'send'), 'looked up again on demand');

    // Long replies are split; only the first message carries the agent label.
    const { TeamsStreamer } = await import('../lib/channels/teams/stream');
    start = calls.length;
    const longReply = new TeamsStreamer(config, { serviceUrl: SERVICE_URL, conversationId: 'personal-long', botId: BOT_ID, userId: '29:alice' }, 12, '*🤖 teams*');
    await longReply.update('first part.');
    await longReply.finish('first part.\n\nsecond part');
    assert.deepEqual(finals(since(start).posts), ['*🤖 teams*\n\nfirst part.', 'second part']);

    // Warm-up fetches the bot token once, so the first message does not wait for it.
    const auth = await import('../lib/channels/teams/auth');
    auth.resetTeamsAuthForTests();
    try {
      start = calls.length;
      const errors: string[] = [];
      await auth.warmUpTeams(config, { inboundKeys: false, onError: (stage) => errors.push(stage) });
      assert.deepEqual(errors, []);
      assert.equal(calls.slice(start).filter((c) => c.url.startsWith('https://login.microsoftonline.com/')).length, 1, 'token fetched by warm-up');
      start = calls.length;
      r = await run(activity('29:alice', 'warm', [], 'personal', 'personal-fast'));
      assert.equal(calls.slice(start).filter((c) => c.url.startsWith('https://login.microsoftonline.com/')).length, 0, 'message reuses the warm token');
    } finally {
      auth.resetTeamsAuthForTests();
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
