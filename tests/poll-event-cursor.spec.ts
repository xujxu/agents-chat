import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { deleteAgent, login, startBusyChat, waitForSignedIn } from './followupQueueHelpers';

type PolledTurn = { id: string; events: unknown[]; eventsFrom: number; totalEvents: number; done: boolean };

// Real server + tests/fixtures/streaming-acp-agent.mjs: polls after the first ask only for new
// turn events, and the reply still renders and saves every tool call and all of its text.
test('streaming polls fetch only new turn events and keep the full reply', async ({ page }) => {
  await login(page);
  const api = page.request;
  const agentId = `stream-agent-${randomUUID().slice(0, 8)}`;
  expect((await api.post('/api/acp', { data: { action: 'create-agent', agent: {
    id: agentId, command: 'node', args: [path.resolve('tests/fixtures/streaming-acp-agent.mjs')],
    cwd: process.cwd(), yolo: false, env: { STREAM_AGENT_TOOLS: '12', STREAM_AGENT_GAP_MS: '250' },
  } } })).ok()).toBeTruthy();

  let chatId = '';
  const polls: { request: Record<string, unknown>; turn: PolledTurn | null }[] = [];
  page.on('response', async response => {
    if (!response.url().endsWith('/api/acp') || response.request().method() !== 'POST') return;
    const request = response.request().postDataJSON();
    if (request?.agentId !== agentId) return;
    if (request.action === 'send') chatId = request.chatId;
    if (request.action === 'poll') polls.push({ request, turn: (await response.json().catch(() => null))?.activeTurn ?? null });
  });
  const poll = async (cursor: Record<string, unknown>) =>
    (await (await api.post('/api/acp', { data: { action: 'poll', agentId, chatId, ...cursor } })).json()).activeTurn as PolledTurn;

  try {
    await startBusyChat(page, agentId);
    await expect.poll(() => polls.some(entry => (entry.turn?.totalEvents ?? 0) > 2), { timeout: 15_000 }).toBe(true);

    const full = await poll({});
    expect(full.eventsFrom).toBe(0);
    expect(full.events).toHaveLength(full.totalEvents);
    const tail = await poll({ turnId: full.id, sinceEvent: 2 });
    expect(tail.eventsFrom).toBe(2);
    expect(tail.events).toEqual((await poll({})).events.slice(2, 2 + tail.events.length));
    // Cursors for another turn, past the end, or malformed fall back to the full list.
    for (const cursor of [
      { turnId: 'other-turn', sinceEvent: 2 },
      { turnId: full.id, sinceEvent: 100_000 },
      { turnId: full.id, sinceEvent: -1 },
      { turnId: full.id, sinceEvent: 1.5 },
      { sinceEvent: 2 },
    ]) {
      const turn = await poll(cursor);
      expect(turn.eventsFrom, JSON.stringify(cursor)).toBe(0);
      expect(turn.events).toHaveLength(turn.totalEvents);
    }

    const reply = page.locator('.message.agent').last();
    await expect(reply).toContainText('Step 12 ok. Stream done', { timeout: 30_000 });
    await expect(reply.locator('.toolCallItem')).toHaveCount(12);
    await expect(reply.locator('.toolCallSummary.complete')).toHaveCount(12);

    const cursorPolls = polls.filter(entry => typeof entry.request.sinceEvent === 'number');
    expect(polls[0].request.sinceEvent).toBeUndefined();
    expect(cursorPolls.length).toBeGreaterThan(2);
    for (const { request, turn } of cursorPolls) {
      expect(turn?.eventsFrom).toBe(request.sinceEvent);
      expect(turn!.events.length).toBe(turn!.totalEvents - turn!.eventsFrom);
    }

    await expect.poll(async () => {
      const chat = (await (await api.get(`/api/chats?id=${chatId}`)).json()).chat;
      const saved = chat.messages.filter((message: { type: string }) => message.type === 'agent').at(-1);
      return { pending: saved.pending, tools: saved.parts.filter((part: { kind: string }) => part.kind === 'tool').length, content: saved.content };
    }, { timeout: 15_000 }).toEqual({ pending: false, tools: 12, content: expect.stringContaining('Step 12 ok. Stream done') });
  } finally {
    await deleteAgent(api, agentId);
    if (chatId) await api.delete(`/api/chats?id=${chatId}`);
  }
});

// The saved partial reply (a draft while it streams) is what a reload shows; the reply then finishes once.
test('reloading mid-reply restores the saved partial reply and finishes it once', async ({ page }) => {
  await login(page);
  const api = page.request;
  const agentId = `stream-agent-${randomUUID().slice(0, 8)}`;
  expect((await api.post('/api/acp', { data: { action: 'create-agent', agent: {
    id: agentId, command: 'node', args: [path.resolve('tests/fixtures/streaming-acp-agent.mjs')],
    cwd: process.cwd(), yolo: false, env: { STREAM_AGENT_TOOLS: '12', STREAM_AGENT_GAP_MS: '400' },
  } } })).ok()).toBeTruthy();

  let chatId = '';
  page.on('request', request => {
    if (request.url().endsWith('/api/acp') && request.method() === 'POST' && request.postDataJSON()?.action === 'send') chatId = request.postDataJSON().chatId;
  });
  const savedReply = async () => {
    const chat = (await (await api.get(`/api/chats?id=${chatId}`)).json()).chat;
    return chat?.messages.filter((message: { type: string }) => message.type === 'agent').at(-1) as { pending?: boolean; content: string; parts?: { kind: string }[] } | undefined;
  };

  try {
    await startBusyChat(page, agentId);
    await expect.poll(async () => {
      const saved = chatId ? await savedReply() : undefined;
      return saved?.pending === true && saved.content.includes('Step 2 ok.');
    }, { timeout: 20_000 }).toBe(true);
    const partial = (await savedReply())!;
    expect(partial.content).not.toContain('Stream done');

    await page.reload();
    await waitForSignedIn(page);
    const reply = page.locator('.message.agent');
    await expect(reply.last()).toContainText('Step 2 ok.', { timeout: 15_000 });
    await expect(reply.last()).toContainText('Step 12 ok. Stream done', { timeout: 30_000 });
    await expect(reply).toHaveCount(1);
    await expect(reply.locator('.toolCallItem')).toHaveCount(12);

    await expect.poll(async () => {
      const saved = await savedReply();
      return { pending: saved?.pending, tools: saved?.parts?.filter(part => part.kind === 'tool').length, content: saved?.content };
    }, { timeout: 15_000 }).toEqual({ pending: false, tools: 12, content: expect.stringContaining('Step 12 ok. Stream done') });
  } finally {
    await deleteAgent(api, agentId);
    if (chatId) await api.delete(`/api/chats?id=${chatId}`);
  }
});
// Copilot CLI streams a background sub-agent's thoughts, reply and tool calls on the parent session,
// tagged with _meta agentId; they must not be spliced into the parent's reply.
test('a sub-agent streamed on the same session stays out of the reply', async ({ page }) => {
  await login(page);
  const api = page.request;
  const agentId = `stream-agent-${randomUUID().slice(0, 8)}`;
  expect((await api.post('/api/acp', { data: { action: 'create-agent', agent: {
    id: agentId, command: 'node', args: [path.resolve('tests/fixtures/streaming-acp-agent.mjs')],
    cwd: process.cwd(), yolo: false, env: { STREAM_AGENT_TOOLS: '3', STREAM_AGENT_GAP_MS: '50', STREAM_AGENT_SUBAGENT: '1' },
  } } })).ok()).toBeTruthy();

  let chatId = '';
  page.on('request', request => {
    if (request.url().endsWith('/api/acp') && request.method() === 'POST' && request.postDataJSON()?.action === 'send') chatId = request.postDataJSON().chatId;
  });
  try {
    await startBusyChat(page, agentId);
    const reply = page.locator('.message.agent').last();
    await expect(reply).toContainText('Step 3 ok. Stream done', { timeout: 30_000 });
    await expect(reply).not.toContainText('SUBAGENT');
    await expect(reply.locator('.toolCallItem')).toHaveCount(3);
    await expect.poll(async () => {
      const chat = (await (await api.get(`/api/chats?id=${chatId}`)).json()).chat;
      const saved = chat?.messages.filter((message: { type: string }) => message.type === 'agent').at(-1);
      return { pending: saved?.pending, content: saved?.content, leaked: JSON.stringify(saved?.parts ?? []).includes('SUBAGENT') };
    }, { timeout: 15_000 }).toEqual({ pending: false, content: 'Step 1 ok. Step 2 ok. Step 3 ok. Stream done', leaked: false });
  } finally {
    await deleteAgent(api, agentId);
    if (chatId) await api.delete(`/api/chats?id=${chatId}`);
  }
});
