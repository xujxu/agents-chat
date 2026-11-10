import { expect, test } from '@playwright/test';
import { createSlowAgent, deleteAgent, login, startBusyChat } from './followupQueueHelpers';

// Real server, real ACP process, no route mocks: queue follow-ups while the agent works and
// check the server sends them together as one turn when the first turn finishes.

test('queued follow-ups are sent together after the running turn ends', async ({ page }) => {
  await login(page);
  const api = page.context().request;
  const agentId = await createSlowAgent(api, { SLOW_AGENT_DELAY_MS: '8000', SLOW_AGENT_INIT_DELAY_MS: '5000' });

  try {
    const textarea = await startBusyChat(page, agentId);
    const tray = page.locator('.followupTray');
    const chatArea = page.locator('.chatContainer');
    const queueButton = page.getByRole('button', { name: 'Queue follow-up' });

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
    await expect(tray).not.toContainText('paused');
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
    await deleteAgent(api, agentId);
  }
});

test('interrupt & send now waits for the cancelled turn before sending the queue', async ({ page }) => {
  await login(page);
  const api = page.context().request;
  // The fixture takes 1.5 s to unwind a cancel and rejects prompts that arrive before that.
  const agentId = await createSlowAgent(api, { SLOW_AGENT_DELAY_MS: '30000', SLOW_AGENT_CANCEL_DELAY_MS: '1500' });

  try {
    const textarea = await startBusyChat(page, agentId);
    const tray = page.locator('.followupTray');
    const chatArea = page.locator('.chatContainer');

    await textarea.fill('queued-item-1 rerun the build');
    await textarea.press('Enter');
    await textarea.fill('queued-item-2 then summarize');
    await textarea.press('Enter');
    await expect(tray.locator('.followupItem')).toHaveCount(2);

    await tray.getByRole('button', { name: 'Interrupt & send now' }).click();
    await expect(tray).toHaveCount(0, { timeout: 15_000 });
    const combined = chatArea.locator('.message.user', { hasText: 'Follow-ups queued while you were working' });
    await expect(combined).toHaveCount(1);
    await expect(combined).toContainText('queued-item-1 rerun the build');
    await expect(combined).toContainText('queued-item-2 then summarize');
    // The follow-up turn is accepted on the first try: no "overlapping prompts rejected" suffix.
    await expect(chatArea.locator('.message.agent', { hasText: 'Turn 2 done; saw 2 queued items' })).toBeVisible({ timeout: 45_000 });
    await expect(chatArea).not.toContainText('overlapping prompts rejected');
    await expect(chatArea.locator('.message.agent', { hasText: 'Turn 1 done' })).toHaveCount(0);
  } finally {
    await deleteAgent(api, agentId);
  }
});
