import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function login(page: Page) {
  await page.goto('/login');
  const username = page.getByPlaceholder('Admin username');
  const password = page.getByPlaceholder('Password');
  const submit = page.locator('button[type="submit"]');
  await expect(async () => {
    await username.fill(process.env.ADMIN_USERNAME || 'admin');
    await password.fill(process.env.ADMIN_PASSWORD || 'admin123');
    await expect(submit).toBeEnabled();
  }).toPass({ timeout: 30_000 });
  await submit.click();
  await waitForSignedIn(page);
}

const anyNewChatButton = (page: Page) => page.locator('button.newChatButton:visible, button.emptyHomepageNewChat:visible').first();

// Phones keep the sidebar's button in an off-screen drawer, so use the homepage one or open the drawer.
async function clickNewChat(page: Page) {
  const home = page.locator('button.emptyHomepageNewChat');
  if (await home.isVisible()) return home.click();
  const openNavigation = page.getByRole('button', { name: 'Open navigation' });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.locator('button.newChatButton:visible').first().click();
  const closePanel = page.getByRole('button', { name: 'Close active panel' });
  if (await closePanel.isVisible()) {
    await closePanel.click({ position: { x: page.viewportSize()!.width - 10, y: 100 } });
    await expect(page.locator('.participantsSidebar')).not.toHaveClass(/mobilePanelVisible/);
  }
}

// The page saves new chats as 'anonymous' until the session loads; the avatar renders in the same pass.
export async function waitForSignedIn(page: Page) {
  await expect(page.locator('.userAvatar:visible').first()).toBeVisible({ timeout: 30_000 });
  await expect(anyNewChatButton(page)).toBeVisible({ timeout: 30_000 });
}

/** Registers tests/fixtures/slow-acp-agent.mjs under a unique id. */
export async function createSlowAgent(api: APIRequestContext, env: Record<string, string>): Promise<string> {
  const agentId = `queue-agent-${randomUUID().slice(0, 8)}`;
  const response = await api.post('/api/acp', { data: {
    action: 'create-agent', agent: {
      id: agentId, command: 'node', args: [path.resolve('tests/fixtures/slow-acp-agent.mjs')],
      cwd: process.cwd(), yolo: false, env,
    },
  } });
  expect(response.ok()).toBeTruthy();
  return agentId;
}

export async function deleteAgent(api: APIRequestContext, agentId: string) {
  // Swallow teardown errors so they don't mask the real test failure.
  await api.post('/api/acp', { data: { action: 'delete-agent', agentId } }).catch(() => undefined);
}

/** Opens a fresh chat and starts a long-running turn on the agent; returns once the Queue button shows. */
export async function startBusyChat(page: Page, agentId: string) {
  await page.reload();
  await waitForSignedIn(page);
  await clickNewChat(page);
  await expect(page.locator('.chatToast', { hasText: 'New chat' })).toBeVisible({ timeout: 10_000 });
  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill(`@${agentId} start the long task`);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Queue follow-up' })).toBeVisible({ timeout: 15_000 });
  return textarea;
}
