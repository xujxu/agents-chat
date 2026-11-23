/**
 * E2E tests for agent filter persistence, chat sort order,
 * input history backfill, and scroll-to-bottom on chat switch.
 *
 * Requires: dev server running on localhost:3010
 * Run: npx playwright test --config tests/playwright.config.ts tests/test-filter-scroll-history.spec.ts
 */

import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[placeholder="Admin username"]').fill(ADMIN_USER);
  await page.locator('input[placeholder="Password"]').fill(ADMIN_PASS);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
  await page.waitForTimeout(500);
}

async function deleteAllChats(page: Page) {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/chats');
    return r.json();
  });
  if (res?.ok && Array.isArray(res.chats)) {
    for (const chat of res.chats) {
      await page.evaluate(async (id: string) => {
        await fetch(`/api/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      }, chat.id);
    }
  }
  await page.evaluate(async () => {
    await fetch('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set-last-chat', chatId: '' }) });
  });
}

async function mockTwoAgentsAcp(page: Page) {
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents: [
            { id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true },
            { id: 'beta', name: 'Beta Agent', command: 'mock', args: [], cwd: '', running: true },
          ],
        }),
      });
      return;
    }
    if (body?.action === 'send') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, phase: 'thinking', sessionId: `session-${body.agentId}`, turn: { id: `turn-${body.agentId}` } }),
      });
      return;
    }
    if (body?.action === 'poll') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          phase: 'idle',
          ready: true,
          booting: false,
          activeTurn: {
            id: `turn-${body.agentId}`,
            fullText: `reply from ${body.agentId}`,
            done: true,
            phase: 'done',
            events: [{ type: 'text_chunk', ts: Date.now(), text: `reply from ${body.agentId}` }],
          },
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

async function ensureActiveChat(page: Page) {
  const isEmpty = await page.locator('.emptyHomepage').isVisible({ timeout: 2000 }).catch(() => false);
  if (isEmpty) {
    await page.click('button.newChatButton, button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
  }
}

function chatAgentFilterTrigger(page: Page) {
  return page.getByRole('button', { name: 'Filter chats by primary agent' });
}

async function selectChatAgentFilter(page: Page, agentId: string) {
  await chatAgentFilterTrigger(page).click();
  const listbox = page.getByRole('listbox', { name: 'Filter chats by primary agent' });
  await expect(listbox).toBeVisible();
  await listbox.locator(`[role="option"][data-value="${agentId}"]`).click();
  await expect(listbox).toHaveCount(0);
}

async function sendMessage(page: Page, text: string) {
  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill(text);
  await page.click('button[aria-label="Send message"]');
  // Wait for generation to complete
  await expect(page.locator('button[aria-label="Stop generation"]')).toBeHidden({ timeout: 30000 });
  await page.waitForTimeout(500);
}

test.describe('Agent Filter Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await mockTwoAgentsAcp(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.emptyHomepage', { timeout: 10000 });
  });

  test('selecting an agent lists a chat created on another device without a reload', async ({ page }) => {
    // Saved through the API after this page loaded, as another browser would.
    const chat = { id: `other-device-${Date.now()}`, name: 'Created elsewhere', ts: Date.now(), agentId: 'beta', agentSessions: {},
      messages: [{ id: 'u1', type: 'user', content: '@beta hi', ts: Date.now() }] };
    expect((await page.context().request.post(`${BASE}/api/chats`, { data: { chat } })).ok()).toBeTruthy();
    await expect(page.locator('.chatHistoryName', { hasText: 'Created elsewhere' })).toHaveCount(0);

    await selectChatAgentFilter(page, 'beta');
    await expect(page.locator('.chatHistoryName', { hasText: 'Created elsewhere' })).toBeVisible({ timeout: 10000 });
  });

  test('reopening a cached chat shows and keeps replies added on another device', async ({ page }) => {
    const request = page.context().request;
    const msg = (id: string, type: 'user' | 'agent', content: string, ts: number) => ({ id, type, content, ts, ...(type === 'agent' ? { agentId: 'beta' } : {}) });
    const chatA = { id: `reopen-a-${Date.now()}`, name: 'Reopen A', ts: Date.now(), agentId: 'beta', agentSessions: {},
      messages: [msg('a-u1', 'user', '@beta first question', 1), msg('a-r1', 'agent', 'first answer', 2)] };
    const chatB = { id: `reopen-b-${Date.now()}`, name: 'Reopen B', ts: Date.now() - 1000, agentId: 'beta', agentSessions: {},
      messages: [msg('b-u1', 'user', '@beta other', 1), msg('b-r1', 'agent', 'other answer', 2)] };
    for (const chat of [chatA, chatB]) expect((await request.post(`${BASE}/api/chats`, { data: { chat } })).ok()).toBeTruthy();

    await selectChatAgentFilter(page, 'beta');
    const open = async (name: string, text: string) => {
      await page.locator('.chatHistoryName', { hasText: name }).click();
      await expect(page.locator('.message', { hasText: text }).first()).toBeVisible({ timeout: 10000 });
    };
    await open('Reopen A', 'first answer');
    await open('Reopen B', 'other answer');

    // Another device continues chat A while this browser holds it in memory.
    const continued = { ...chatA, ts: Date.now(), messages: [...chatA.messages, msg('a-u2', 'user', '@beta second question', 3), msg('a-r2', 'agent', 'second answer from laptop', 4)] };
    expect((await request.post(`${BASE}/api/chats`, { data: { chat: continued } })).ok()).toBeTruthy();

    await open('Reopen A', 'second answer from laptop');
    await open('Reopen B', 'other answer');
    const saved = (await (await request.get(`${BASE}/api/chats?id=${chatA.id}`)).json()).chat;
    expect(saved.messages.map((m: { id: string }) => m.id)).toEqual(['a-u1', 'a-r1', 'a-u2', 'a-r2']);
  });

  test('should preserve agent filter when creating new chat', async ({ page }) => {
    const select = chatAgentFilterTrigger(page);
    await selectChatAgentFilter(page, 'alpha');
    await page.waitForTimeout(500);

    // Should show empty homepage for alpha (no chats yet)
    await expect(page.locator('.emptyHomepage')).toBeVisible();

    // Create a new chat — filter should remain on alpha
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });

    await expect(select).toHaveAttribute('data-value', 'alpha');
  });

  test('should preserve agent filter when selecting an existing chat', async ({ page }) => {
    // First create a chat under "All"
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await sendMessage(page, '@alpha hello');

    // Create a second chat
    await page.click('button.newChatButton');
    await page.waitForTimeout(1000);

    // Now switch to alpha filter
    const select = chatAgentFilterTrigger(page);
    await selectChatAgentFilter(page, 'alpha');
    await page.waitForTimeout(500);

    // There should be at least one chat under alpha (the first one we created)
    const chatRows = page.locator('.chatHistoryRow');
    const count = await chatRows.count();
    if (count > 0) {
      // Click on the chat
      await chatRows.first().click();
      await page.waitForTimeout(500);

      // Filter should still be on alpha
      await expect(select).toHaveAttribute('data-value', 'alpha');
    }
  });

  test('should preserve agent filter when deleting a chat', async ({ page }) => {
    const select = chatAgentFilterTrigger(page);
    await selectChatAgentFilter(page, 'alpha');
    await page.waitForTimeout(500);

    // Create a chat
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Delete it via the chat menu
    const chatRow = page.locator('.chatHistoryRow').first();
    await chatRow.hover();
    const moreBtn = chatRow.locator('.chatMoreBtn');
    if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(300);
      const deleteBtn = page.locator('button:has-text("Delete"), .chatActionMenuItem:has-text("Delete")').first();
      if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await deleteBtn.click();
        await page.waitForTimeout(500);

        // Filter should still be on alpha
        await expect(select).toHaveAttribute('data-value', 'alpha');
      }
    }
  });

  test('restored chat still shows agent replies when the persisted filter is a different agent', async ({ page }) => {
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await sendMessage(page, '@alpha hello');
    await expect(page.locator('.chatContainer')).toContainText('reply from alpha');

    // Simulate another tab (or an earlier session) leaving the filter on beta,
    // then the tab reloading, e.g. after the machine resumes from hibernate.
    await page.evaluate(() => window.localStorage.setItem('acp_agent_filter_v1', 'beta'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    await expect(chatAgentFilterTrigger(page)).toHaveAttribute('data-value', 'beta');
    await expect(page.locator('.chatContainer')).toContainText('@alpha hello');
    await expect(page.locator('.chatContainer')).toContainText('reply from alpha');
  });

  test('restoring a chat owned by another agent switches the filter to that agent', async ({ page }) => {
    await selectChatAgentFilter(page, 'alpha');
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await sendMessage(page, '@alpha owned by alpha');

    // Another browser/device left this browser's filter on beta while the
    // server-side last chat is alpha's.
    await page.evaluate(() => window.localStorage.setItem('acp_agent_filter_v1', 'beta'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chatContainer', { timeout: 30000 });

    await expect(page.locator('.chatContainer')).toContainText('@alpha owned by alpha');
    await expect(chatAgentFilterTrigger(page)).toHaveAttribute('data-value', 'alpha');
    await expect(page.locator('.chatHistoryRow.active')).toHaveCount(1);
  });
});

test.describe('Chat List Sort Order', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await mockTwoAgentsAcp(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.emptyHomepage', { timeout: 10000 });
  });

  test('should sort chats by creation time with newest first', async ({ page }) => {
    // Create first chat and send a message
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await sendMessage(page, '@alpha first chat message');

    // Wait a moment to ensure different timestamps
    await page.waitForTimeout(500);

    // Create second chat and send a message
    await page.click('button.newChatButton');
    await page.waitForTimeout(1000);
    await sendMessage(page, '@alpha second chat message');

    // The sidebar should have 2 chats, with the newer one at the top
    const chatRows = page.locator('.chatHistoryRow');
    await expect(chatRows).toHaveCount(2);

    // The active/current chat (second, newer) should be first in the list
    const firstRow = chatRows.first();
    const isActive = await firstRow.evaluate((el) => el.classList.contains('active'));
    expect(isActive).toBe(true);
  });
});

test.describe('Scroll to Bottom on Chat Switch', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    await mockTwoAgentsAcp(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.emptyHomepage', { timeout: 10000 });
  });

  test('should scroll to bottom when switching between chats', async ({ page }) => {
    // Create first chat with many messages to make it scrollable
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });

    for (let i = 0; i < 8; i++) {
      await sendMessage(page, `@alpha message ${i + 1} - this is a longer message in chat A with extra padding text to help fill the viewport and ensure the content exceeds the visible area`);
    }

    // Scroll up to move away from the bottom
    await page.evaluate(() => {
      const el = document.querySelector('.chatContainer');
      if (el) el.scrollTop = 0;
    });
    await page.waitForTimeout(500);

    // Create second chat
    await page.click('button.newChatButton');
    await page.waitForTimeout(1000);
    await sendMessage(page, '@alpha hello from chat B');

    // Switch back to first chat
    const chatRows = page.locator('.chatHistoryRow');
    await chatRows.last().click();
    await page.waitForTimeout(2000);

    // Check that the container is scrolled to bottom
    const scrollInfo = await page.evaluate(() => {
      const el = document.querySelector('.chatContainer');
      if (!el) return { exists: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0, distance: 0 };
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      return { exists: true, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight, distance };
    });
    // Should be within a reasonable distance from bottom
    expect(scrollInfo.distance).toBeLessThanOrEqual(50);
  });
});

test.describe('Input History Backfill', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await deleteAllChats(page);
    // Clear stored input history
    await page.evaluate(() => window.localStorage.removeItem('acp_input_history_v2'));
    await mockTwoAgentsAcp(page);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.emptyHomepage', { timeout: 10000 });
  });

  test('should recall sent messages with ArrowUp', async ({ page }) => {
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });

    // Send a couple of messages
    await sendMessage(page, '@alpha first command');
    await sendMessage(page, '@alpha second command');

    // Press ArrowUp — should recall "second command"
    const textarea = page.locator('textarea.composerTextarea');
    await textarea.click();
    await textarea.press('Home');
    await textarea.press('ArrowUp');
    await page.waitForTimeout(300);

    const value = await textarea.inputValue();
    expect(value).toContain('second command');

    // Press ArrowUp again — should recall "first command"
    await textarea.press('Home');
    await textarea.press('ArrowUp');
    await page.waitForTimeout(300);
    const value2 = await textarea.inputValue();
    expect(value2).toContain('first command');
  });

  test('should backfill history from loaded messages on chat switch', async ({ page }) => {
    // Create chat and send messages
    await page.click('button.emptyHomepageNewChat');
    await page.waitForSelector('.chatContainer', { timeout: 10000 });
    await sendMessage(page, '@alpha backfill test message');

    // Clear the localStorage history to simulate pre-existing chat
    await page.evaluate(() => window.localStorage.removeItem('acp_input_history_v2'));

    // Create a new chat, then switch back to the first
    await page.click('button.newChatButton');
    await page.waitForTimeout(1000);

    const chatRows = page.locator('.chatHistoryRow');
    await chatRows.last().click();
    await page.waitForTimeout(1000);

    // Press ArrowUp — should have backfilled "backfill test message"
    const textarea = page.locator('textarea.composerTextarea');
    await textarea.click();
    await textarea.press('ArrowUp');
    await page.waitForTimeout(200);

    const value = await textarea.inputValue();
    expect(value).toContain('backfill test message');
  });
});
