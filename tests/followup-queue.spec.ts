import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Real server, real ACP process, no route mocks: queue follow-ups while the agent works and
// check the server sends them together as one turn when the first turn finishes.

async function login(page: Page) {
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

// The page saves new chats as 'anonymous' until the session loads; the avatar renders in the same pass.
async function waitForSignedIn(page: Page) {
  await expect(page.locator('.userAvatar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('button.newChatButton').first()).toBeVisible({ timeout: 30_000 });
}

test('queued follow-ups are sent together after the running turn ends', async ({ page }) => {
  await login(page);
  const api = page.context().request;
  const agentId = `queue-agent-${randomUUID().slice(0, 8)}`;
  expect((await api.post('/api/acp', { data: {
    action: 'create-agent', agent: {
      id: agentId, command: 'node', args: [path.resolve('tests/fixtures/slow-acp-agent.mjs')],
      cwd: process.cwd(), yolo: false, env: { SLOW_AGENT_DELAY_MS: '8000', SLOW_AGENT_INIT_DELAY_MS: '5000' },
    },
  } })).ok()).toBeTruthy();

  try {
    await page.reload();
    await waitForSignedIn(page);
    await page.locator('button.newChatButton').first().click();
    await expect(page.locator('.chatToast', { hasText: 'New chat' })).toBeVisible({ timeout: 10_000 });
    const textarea = page.locator('textarea.composerTextarea');
    const tray = page.locator('.followupTray');
    const chatArea = page.locator('.chatContainer');

    await textarea.fill(`@${agentId} start the long task`);
    await page.getByRole('button', { name: 'Send message' }).click();
    const queueButton = page.getByRole('button', { name: 'Queue follow-up' });
    await expect(queueButton).toBeVisible({ timeout: 15_000 });

    // Enter queues while the agent is still booting/running; so does the Queue button. The slow boot checks
    // that items queued before the first turn exists wait for it instead of jumping ahead of it.
    await textarea.fill('queued-item-1 check the tests');
    await textarea.press('Enter');
    await expect(tray.locator('.followupItem')).toHaveCount(1);
    await expect(textarea).toHaveValue('');
    await textarea.fill('queued-item-2 draft');
    await queueButton.click();
    await textarea.fill('queued-item-3 update the docs');
    await textarea.press('Enter');

    await expect(tray.locator('.followupItem')).toHaveCount(3);
    await expect(tray).toContainText('Queued follow-ups (3)');
    await expect(tray.getByRole('button', { name: 'Interrupt & send now' })).toBeVisible();

    await tray.getByRole('button', { name: 'Edit follow-up 2' }).click();
    await tray.locator('textarea.followupEditInput').fill('queued-item-2 also check lint');
    await tray.getByRole('button', { name: 'Save' }).click();
    await expect(tray.locator('.followupItem').nth(1)).toContainText('queued-item-2 also check lint');

    // First turn ends -> one combined user message, queue drops from 3 to 0.
    await expect(chatArea.locator('.message.agent', { hasText: 'Turn 1 done; saw 0 queued items' })).toBeVisible({ timeout: 30_000 });
    await expect(tray).toHaveCount(0, { timeout: 15_000 });
    const combined = chatArea.locator('.message.user', { hasText: 'Follow-ups queued while you were working' });
    await expect(combined).toHaveCount(1);
    for (const text of ['queued-item-1 check the tests', 'queued-item-2 also check lint', 'queued-item-3 update the docs']) {
      await expect(combined).toContainText(text);
    }
    await expect(chatArea.locator('.message.agent', { hasText: 'Turn 2 done; saw 3 queued items' })).toBeVisible({ timeout: 30_000 });
    await expect(chatArea.locator('.message.agent', { hasText: /Turn 3/ })).toHaveCount(0);
  } finally {
    await api.post('/api/acp', { data: { action: 'delete-agent', agentId } });
  }
});
