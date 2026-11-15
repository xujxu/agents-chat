import { expect, test, type Page } from '@playwright/test';
import { chatSaveAcknowledgement } from './helpers/chatSaveFixture';
import { installMobileChatFixture } from './helpers/mobileChatFixture';

const TOTAL = 130;
const label = (index: number) => `Window message ${String(index).padStart(3, '0')}`;

function longChat() {
  return {
    id: 'window-long-chat',
    name: 'Long window chat',
    ts: 2_000,
    agentSessions: {},
    messages: Array.from({ length: TOTAL }, (_, index) => index % 2 === 0
      ? { id: `m-${index}`, type: 'user', content: label(index), ts: 10_000 + index }
      : {
        id: `m-${index}`, type: 'agent', agentId: 'alpha', content: label(index), ts: 10_000 + index,
        parts: [{ kind: 'text', text: `${label(index)}\n\n${'Body line for scrolling. '.repeat(12)}` }],
      }),
  };
}

const shortChat = {
  id: 'window-short-chat',
  name: 'Short window chat',
  ts: 1_000,
  agentSessions: {},
  messages: [{ id: 'short-1', type: 'user', content: 'Short chat only message', ts: 1_001 }],
};

async function openLongChat(page: Page) {
  await installMobileChatFixture(page);
  const chat = longChat();
  await page.route('**/api/chats**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: body.action === 'save-sync' ? chatSaveAcknowledgement(body) : { ok: true } });
    }
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id) return route.fulfill({ json: { ok: true, chat: id === shortChat.id ? shortChat : chat } });
    return route.fulfill({ json: {
      ok: true,
      chats: [{ id: chat.id, name: chat.name, ts: chat.ts }, { id: shortChat.id, name: shortChat.name, ts: shortChat.ts }],
      lastChatId: chat.id,
    } });
  });
  await page.goto('/login');
  await page.getByPlaceholder('Admin username').fill(process.env.ADMIN_USERNAME || 'admin');
  await page.getByPlaceholder('Password').fill(process.env.ADMIN_PASSWORD || 'admin123');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText(label(TOTAL - 1), { exact: true })).toBeVisible({ timeout: 30_000 });
}

const rendered = (page: Page) => page.locator('.chatContainer [data-message-id]');

test('renders the newest messages first and keeps the reading position when older ones load', async ({ page }) => {
  await openLongChat(page);
  const bar = page.locator('.olderMessagesBar');
  await expect(rendered(page)).toHaveCount(40);
  await expect(bar).toContainText('90 earlier messages not shown');
  await expect(page.getByText(label(TOTAL - 41), { exact: true })).toHaveCount(0);

  // Read the oldest rendered message, then load more with the button: it must not move.
  const anchor = page.locator('[data-message-id="m-95"]');
  await anchor.evaluate((element) => {
    const container = element.closest('.chatContainer') as HTMLElement;
    container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - 200;
  });
  const before = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  // DOM click: Playwright's click would first scroll the bar into view and move the anchor.
  await bar.getByRole('button', { name: 'Show earlier' }).evaluate((button: HTMLElement) => button.click());
  await expect(bar).toContainText('50 earlier messages not shown');
  await expect(rendered(page)).toHaveCount(80);
  const after = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);

  // Scrolling up loads older messages automatically, one batch per approach to the top.
  await expect(async () => {
    await page.locator('.chatContainer').evaluate((element) => { element.scrollTop = 0; });
    await expect(rendered(page)).toHaveCount(TOTAL, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(bar).toHaveCount(0);
  await expect(page.getByText(label(0), { exact: true })).toBeAttached();
});

test('Show all renders every message and switching chats resets the window', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Chat switching uses the desktop sidebar.');
  await openLongChat(page);
  await page.locator('.olderMessagesBar').getByRole('button', { name: 'Show all' }).click();
  await expect(rendered(page)).toHaveCount(TOTAL);

  await page.getByTitle(shortChat.name).first().click();
  await expect(page.getByText('Short chat only message', { exact: true })).toBeVisible();
  await expect(page.locator('.olderMessagesBar')).toHaveCount(0);

  await page.getByTitle('Long window chat').first().click();
  await expect(page.getByText(label(TOTAL - 1), { exact: true })).toBeVisible();
  await expect(rendered(page)).toHaveCount(40);
  await expect(page.locator('.olderMessagesBar')).toContainText('90 earlier messages not shown');
});

test('opening browser find renders every message so find can match older ones', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Find-in-page shortcuts are desktop only.');
  await openLongChat(page);
  await expect(rendered(page)).toHaveCount(40);
  await page.keyboard.press('ControlOrMeta+f');
  await expect(rendered(page)).toHaveCount(TOTAL);
  await expect(page.getByText(label(0), { exact: true })).toBeAttached();
  await expect(page.getByText(label(TOTAL - 1), { exact: true })).toBeInViewport();
});
