import { expect, test } from '@playwright/test';
import { createSlowAgent, deleteAgent, login, startBusyChat } from './followupQueueHelpers';

// Runs in the android-chromium and iphone-webkit projects: the queue must stay usable by touch
// on a phone-sized composer without overflowing it.

test('follow-up queue fits and is touch-friendly on phones', async ({ page }) => {
  await login(page);
  const api = page.context().request;
  const agentId = await createSlowAgent(api, { SLOW_AGENT_DELAY_MS: '15000' });

  try {
    const textarea = await startBusyChat(page, agentId);
    const tray = page.locator('.followupTray');
    const queueButton = page.getByRole('button', { name: 'Queue follow-up' });
    const stopButton = page.getByRole('button', { name: 'Stop generation' });

    await textarea.fill('queued-item-1 a deliberately long follow-up that must ellipsize instead of widening the composer on a narrow phone screen');
    await queueButton.tap();
    await textarea.fill('queued-item-2 short');
    await queueButton.tap();
    await expect(tray.locator('.followupItem')).toHaveCount(2);

    const viewport = page.viewportSize()!;
    const [queueBox, stopBox, trayBox] = await Promise.all([queueButton.boundingBox(), stopButton.boundingBox(), tray.boundingBox()]);
    expect(queueBox!.x + queueBox!.width).toBeLessThanOrEqual(stopBox!.x + 0.5);
    expect(stopBox!.x + stopBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(trayBox!.x).toBeGreaterThanOrEqual(0);
    expect(trayBox!.x + trayBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    for (const button of await tray.locator('button').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    }

    // Editing must not trigger iOS focus zoom (inputs under 16px do).
    await tray.getByRole('button', { name: 'Edit follow-up 2' }).tap();
    const editor = tray.locator('textarea.followupEditInput');
    await expect(editor).toHaveCSS('font-size', '16px');
    await editor.fill('queued-item-2 edited on phone');
    await tray.getByRole('button', { name: 'Save' }).tap();
    await expect(tray.locator('.followupItem').nth(1)).toContainText('queued-item-2 edited on phone');

    await expect(page.locator('.chatContainer .message.agent', { hasText: 'Turn 2 done; saw 2 queued items' })).toBeVisible({ timeout: 45_000 });
    await expect(tray).toHaveCount(0);
  } finally {
    await deleteAgent(api, agentId);
  }
});
