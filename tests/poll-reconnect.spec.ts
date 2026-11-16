import { expect, test, type Page } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import type { ChatMessage } from '../app/features/chat/chatTypes';

const PARTIAL = 'First half of the reply';
const FULL = 'First half of the reply. Second half written while the browser was offline.';

type ServerState = { offline: boolean; failedPolls: number; turnReleased: boolean; saved: ChatMessage | null };

async function setup(page: Page) {
  await installMobileChatFixture(page);
  const state: ServerState = { offline: false, failedPolls: 0, turnReleased: false, saved: null };
  let messageId = '';
  // Registered after the fixture so these handlers run first.
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === 'send') {
      messageId = String(body.messageId);
      return route.fulfill({ json: { ok: true, sessionId: 'session-alpha', turn: { id: 'turn-alpha' } } });
    }
    if (body.action === 'poll') {
      if (state.offline) {
        state.failedPolls++;
        return route.abort('internetdisconnected');
      }
      const activeTurn = state.turnReleased ? null : {
        id: 'turn-alpha', messageId, fullText: PARTIAL, done: false, phase: 'replying',
        events: [
          { type: 'tool_start', toolCallId: 't1', toolName: 'read_powershell', toolArgs: '{}' },
          { type: 'text_chunk', text: PARTIAL },
        ],
      };
      return route.fulfill({ json: { ok: true, phase: 'replying', ready: true, activeTurn } });
    }
    return route.fallback();
  });
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (route.request().method() !== 'GET' || id !== 'mobile-chat' || !state.saved) return route.fallback();
    return route.fulfill({ json: { ok: true, chat: {
      id: 'mobile-chat', name: 'Mobile coverage', ts: 1_000, agentSessions: {},
      messages: [{ id: 'welcome', type: 'user', content: 'hello', ts: 1_001 }, { ...state.saved, id: messageId }],
    } } });
  });
  await loginMobileFixture(page);
  await page.locator('textarea.composerTextarea').fill('@alpha write a long reply');
  await page.locator('button[aria-label="Send message"]').click();
  const reply = page.locator('.message.agent').last();
  await expect(reply).toContainText(PARTIAL);
  return { state, reply };
}

/** Drives the client's retry loop without waiting out its backoff. */
async function failPolls(page: Page, state: ServerState, count: number) {
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect(state.failedPolls).toBeGreaterThanOrEqual(count);
  }).toPass({ timeout: 30_000, intervals: [100] });
}

test('a reply keeps waiting through a long disconnect and shows the server copy afterwards', async ({ page }) => {
  const { state, reply } = await setup(page);

  state.offline = true;
  await failPolls(page, state, 3);
  await expect(reply).toContainText('Reconnecting…');
  // More failures than the old 10-error limit must not end the reply with partial text.
  await failPolls(page, state, 12);
  await expect(reply).toHaveClass(/streamingMessage/);

  // While offline the server finished the turn, saved it and released it.
  state.saved = {
    id: '', type: 'agent', agentId: 'alpha', ts: Date.now(), content: FULL, pending: false,
    version: 4, serverManaged: true,
    parts: [
      { kind: 'tool', toolName: 'read_powershell', args: '{}', result: 'failed: invalid delay', done: true },
      { kind: 'text', text: FULL },
    ],
  };
  state.turnReleased = true;
  state.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect(reply).toContainText('Second half written while the browser was offline.');
  await expect(reply).not.toContainText('Reconnecting…');
  await expect(reply).not.toHaveClass(/streamingMessage/);
});

test('a reply whose final poll was missed is recovered from the saved chat instead of timing out', async ({ page }) => {
  const { state, reply } = await setup(page);

  state.saved = {
    id: '', type: 'agent', agentId: 'alpha', ts: Date.now(), content: FULL, pending: false,
    version: 2, serverManaged: true, parts: [{ kind: 'text', text: FULL }],
  };
  state.turnReleased = true;

  await expect(reply).toContainText('Second half written while the browser was offline.', { timeout: 10_000 });
  await expect(reply).not.toHaveClass(/streamingMessage/);
});
