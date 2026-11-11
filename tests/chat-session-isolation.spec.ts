import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

test('a new chat gets its own ACP session instead of reusing the last active one', async ({ page }) => {
  await installMobileChatFixture(page);
  await page.route('**/api/chats**', route => route.fulfill({ json: { ok: true, chats: [], lastChatId: '' } }));
  await loginMobileFixture(page, { emptyHistory: true });
  await page.goto('about:blank');
  const api = page.context().request;
  const agentId = `session-isolation-${randomUUID()}`;
  const chatIds = [`isolation-a-${randomUUID()}`, `isolation-b-${randomUUID()}`];

  const sendAndGetSession = async (chatId: string) => {
    expect((await api.post('/api/chats', { data: {
      action: 'save-sync', operation: {
        operationId: randomUUID(), expectedVersions: {},
        chat: { id: chatId, name: chatId, ts: 1, agentSessions: {}, messages: [] },
      },
    } })).ok()).toBeTruthy();
    const response = await api.post('/api/acp', { data: { action: 'send', agentId, chatId, messageId: randomUUID(), text: 'hello' } });
    expect(await response.json()).toMatchObject({ ok: true });
    let sessionId = '';
    await expect.poll(async () => {
      const stored = await (await api.get(`/api/chats?id=${chatId}`)).json();
      const message = stored.chat.messages.find((m: { type: string; pending?: boolean }) => m.type === 'agent' && !m.pending);
      const saved: string | string[] | undefined = stored.chat.agentSessions?.[agentId];
      sessionId = (Array.isArray(saved) ? saved[saved.length - 1] : saved) || '';
      return !!message && !!sessionId;
    }, { timeout: 15_000 }).toBe(true);
    return sessionId;
  };

  try {
    expect((await api.post('/api/acp', { data: {
      action: 'create-agent', agent: {
        id: agentId, command: 'node', args: [path.resolve('tests/fixtures/persistence-acp-agent.mjs')],
        cwd: process.cwd(), yolo: false,
      },
    } })).ok()).toBeTruthy();
    const first = await sendAndGetSession(chatIds[0]);
    const second = await sendAndGetSession(chatIds[1]);
    expect(second).not.toBe(first);
  } finally {
    await api.post('/api/acp', { data: { action: 'delete-agent', agentId } });
    for (const chatId of chatIds) await api.delete(`/api/chats?id=${chatId}`);
  }
});
