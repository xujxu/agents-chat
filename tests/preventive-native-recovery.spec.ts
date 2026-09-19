import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { validateDiagnosticLog } from '../lib/viewportDiagnostics';
import {
  DIAGNOSTIC_ENDPOINT, DIAGNOSTIC_ORIGIN, openViewportDiagnostic, readSavedViewportLog,
} from './helpers/viewportDiagnosticFixture';
import { dispatchViewportTouches as touch, installTestVisualViewport, setTestVisualViewport } from './helpers/visualViewport';

const PREVENTIVE_PATH = '/diagnostics/viewport-preventive';
const panel = (page: Page) => page.getByLabel('Native rotation prevention', { exact: true });

async function enable(page: Page, mocked = true) {
  await page.setViewportSize({ width: 428, height: 926 });
  if (mocked) await installTestVisualViewport(page);
  const fixture = await openViewportDiagnostic(page, 'baseline', PREVENTIVE_PATH);
  expect(await page.evaluate(() => history.length)).toBe(1);
  await page.evaluate(() => history.replaceState({ ...history.state, preventionOpaque: 'retained' }, ''));
  await page.getByRole('button', { name: 'Enable rotation prevention' }).click();
  await expect(panel(page)).toHaveAttribute('data-phase', 'watching');
  expect(await page.evaluate(() => history.length)).toBe(2);
  return fixture;
}

async function pinch(page: Page, finalScale = 1) {
  await touch(page, 2);
  await setTestVisualViewport(page, 390, 0, 2);
  await setTestVisualViewport(page, 390, 0, finalScale);
  await touch(page, 0);
}

async function expectPreparation(page: Page, cycle: number) {
  await expect(panel(page)).toHaveAttribute('data-preparations', String(cycle));
  await expect(panel(page)).toHaveAttribute('data-phase', 'watching');
  expect(await page.evaluate(() => ({
    length: history.length, role: history.state.viewportHistoryProbe.role,
    cycle: history.state.viewportHistoryProbe.cycle, opaque: history.state.preventionOpaque,
  }))).toEqual({ length: 2, role: 'working', cycle, opaque: 'retained' });
}

test('three pre-rotation preparations preserve live chat and upload distinct private evidence', async ({ page }) => {
  const fixture = await enable(page);
  const documentHandle = await page.evaluateHandle(() => document);
  const shell = await page.locator('.chatPageRoot .page').elementHandle();
  const composerHandle = await page.locator('.composerTextarea').elementHandle();
  let navigations = 0;
  const actions: string[] = [];
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
    if (new URL(request.url()).pathname === '/api/acp' && request.method() === 'POST') {
      actions.push(request.postDataJSON().action);
    }
  });
  const composer = page.locator('.composerTextarea');
  await composer.fill('@alpha Preventive continuity');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.agent.streamingMessage')).toBeVisible();
  await composer.fill('PRIVATE_PREVENTION_DRAFT');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'private-prevention.txt', mimeType: 'text/plain', buffer: Buffer.from('PRIVATE_PREVENTION_ATTACHMENT'),
  });
  await composer.blur();
  const resumeCount = actions.filter(action => action === 'resume-session').length;
  for (let cycle = 1; cycle <= 3; cycle++) {
    await pinch(page);
    await expectPreparation(page, cycle);
    await page.setViewportSize(cycle % 2 ? { width: 832, height: 390 } : { width: 428, height: 926 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expect(composer).toHaveValue('PRIVATE_PREVENTION_DRAFT');
    await expect(page.locator('.attachmentChip')).toContainText('private-prevention.txt');
  }
  fixture.append();
  await expect(page.locator('.message.agent:last-child')).toContainText('Additional streaming paragraph.');
  expect(await page.evaluate(doc => doc === document, documentHandle)).toBe(true);
  expect(await shell!.evaluate(node => node === document.querySelector('.chatPageRoot .page'))).toBe(true);
  expect(await composerHandle!.evaluate(node => node === document.querySelector('.composerTextarea'))).toBe(true);
  expect(navigations).toBe(0);
  expect(actions.filter(action => action === 'send')).toHaveLength(1);
  expect(actions.filter(action => action === 'resume-session')).toHaveLength(resumeCount);
  fixture.finish();
  await expect(page.locator('.message.agent:last-child')).not.toHaveClass(/streamingMessage/);
  const responsePromise = page.waitForResponse(response => response.url().includes(DIAGNOSTIC_ENDPOINT));
  await page.getByRole('button', { name: 'Upload diagnostic log' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const log = (await readSavedViewportLog((await response.json()).id)).log;
  expect(validateDiagnosticLog(log)).toBe(true);
  expect(log.version).toBe(5);
  expect(log.experiment).toBe('native-history-preventive');
  expect(log.samples.at(-1).probe).toMatchObject({ cycle: 3, preparations: 3, owned: true, pendingAck: false });
  expect(JSON.stringify(log)).not.toMatch(/PRIVATE_PREVENTION|private-prevention.txt|viewportHistoryProbe/);
  for (const invalid of [
    { ...log, experiment: 'native-history-auto' },
    { ...log, experiment: 'native-history' },
    { ...log, version: 4 },
  ]) expect((await page.request.post(DIAGNOSTIC_ENDPOINT, {
    data: invalid, headers: { Origin: DIAGNOSTIC_ORIGIN },
  })).status()).toBe(400);
});

test('near-original full-width geometry prepares only after released stability', async ({ page }) => {
  await enable(page);
  await page.setViewportSize({ width: 832, height: 390 });
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await touch(page, 2);
  await setTestVisualViewport(page, 390, 0, 2);
  await page.evaluate(() => {
    if (!visualViewport) throw new Error('Test viewport is missing');
    Object.defineProperty(visualViewport, 'width', {
      configurable: true, get: () => document.documentElement.clientWidth,
    });
  });
  await setTestVisualViewport(page, 390, 0, 1.004727);
  await touch(page, 1);
  await page.waitForTimeout(450);
  await expect(panel(page)).toHaveAttribute('data-preparations', '0');
  await touch(page, 0);
  await expectPreparation(page, 1);
});

test('contacts without zoom, keyboard focus and intentional nonunit zoom never prepare', async ({ page }) => {
  await enable(page);
  await touch(page, 2); await touch(page, 0);
  await page.waitForTimeout(450);
  await expect(panel(page)).toHaveAttribute('data-preparations', '0');
  await pinch(page, 2);
  await expect(panel(page)).toHaveAttribute('data-intent', 'intentional-nonunit');
  await page.locator('.composerTextarea').focus();
  await setTestVisualViewport(page, 180, 0, 1);
  await page.locator('.composerTextarea').blur();
  await page.waitForTimeout(450);
  await expect(panel(page)).toHaveAttribute('data-preparations', '0');
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.cycle)).toBe(0);
});

test('a later rotation anomaly is recorded, not hidden by reactive correction', async ({ page }) => {
  await enable(page);
  await pinch(page);
  await expectPreparation(page, 1);
  await setTestVisualViewport(page, 180, 0, 2.16);
  await page.setViewportSize({ width: 832, height: 390 });
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await page.waitForTimeout(3500);
  await expect(panel(page)).toHaveAttribute('data-preparations', '1');
  await expect(page.getByLabel('Recorded scale')).toHaveText('2.16x');
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('working');
});

test('a new contact or editable focus cancels the released gesture assessment', async ({ page }) => {
  await enable(page);
  await pinch(page);
  await touch(page, 1);
  await touch(page, 0);
  await page.waitForTimeout(450);
  await expect(panel(page)).toHaveAttribute('data-preparations', '0');
  await pinch(page);
  await page.locator('.composerTextarea').focus();
  await page.locator('.composerTextarea').blur();
  await page.waitForTimeout(450);
  await expect(panel(page)).toHaveAttribute('data-preparations', '0');
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('working');
});

test('Stop during a pending preparation forbids rearm', async ({ page }) => {
  await enable(page);
  await pinch(page);
  await page.waitForFunction(() => history.state?.viewportHistoryProbe?.role === 'checkpoint');
  await page.getByRole('button', { name: 'Stop rotation prevention' }).click();
  await page.waitForTimeout(450);
  await expect(panel(page)).toHaveAttribute('data-phase', 'stopped');
  await expect(panel(page)).toHaveAttribute('data-preparations', '0');
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('checkpoint');
});

test('browser Back stops the preventive controller without a compensating push', async ({ page }) => {
  await enable(page);
  await page.goBack();
  await expect(panel(page)).toHaveAttribute('data-phase', 'stopped');
  await page.waitForTimeout(450);
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('checkpoint');
  expect(await page.evaluate(() => history.length)).toBe(2);
});

test('mobile overlay navigation stays owned by the overlay', async ({ page }) => {
  await enable(page);
  await page.getByRole('button', { name: 'Open navigation' }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(panel(page)).toHaveAttribute('data-phase', 'stopped');
  expect(await page.evaluate(() => history.state.agentsChatMobileOverlay)).toBe(true);
  await page.goBack();
  await expect(page.locator('.chatPageRoot .page')).toHaveAttribute('data-mobile-overlay', 'none');
  await expect(panel(page)).toHaveAttribute('data-phase', 'stopped');
  expect(await page.evaluate(() => history.length)).toBe(3);
});

test('ordinary and existing diagnostic URLs never enable prevention', async ({ page }) => {
  for (const url of [
    '/', '/?viewportDiagnostics=baseline', '/diagnostics/viewport-history?viewportDiagnostics=baseline',
    '/diagnostics/viewport-auto?viewportDiagnostics=baseline', PREVENTIVE_PATH,
    `${PREVENTIVE_PATH}?viewportDiagnostics=isolated`,
  ]) {
    await openViewportDiagnostic(page, undefined, url);
    await expect(panel(page)).toHaveCount(0);
    expect(await page.evaluate(() => history.state.viewportHistoryProbe)).toBeUndefined();
  }
});

test('three actual Chromium native-scale preparation transactions retain mechanism evidence', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-chromium', 'CDP preparation does not prove physical iOS prevention.');
  await enable(page, false);
  const cdp = await context.newCDPSession(page);
  const outcomes: unknown[] = [];
  for (let cycle = 1; cycle <= 3; cycle++) {
    await touch(page, 2);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBe(2);
    await page.waitForTimeout(150);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBe(1);
    await touch(page, 0);
    await expectPreparation(page, cycle);
    const outcome = await page.evaluate(() => ({
      scale: visualViewport?.scale, width: visualViewport?.width,
      clientWidth: document.documentElement.clientWidth,
      historyLength: history.length, cycle: history.state.viewportHistoryProbe.cycle,
    }));
    expect(outcome.scale).toBe(1);
    expect(outcome.width).toBeCloseTo(outcome.clientWidth, 0);
    expect(outcome.historyLength).toBe(2);
    outcomes.push(outcome);
  }
  const file = testInfo.outputPath('native-preventive-transactions.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    outcomes, limitation: 'Synthetic touch notifications and actual Chromium page scale. Not iOS rotation prevention.',
  }));
  await testInfo.attach('native-preventive-transactions.json', { path: file, contentType: 'application/json' });
});
