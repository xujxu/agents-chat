import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { validateDiagnosticLog } from '../lib/viewportDiagnostics';
import {
  DIAGNOSTIC_ENDPOINT, DIAGNOSTIC_ORIGIN, openViewportDiagnostic, readSavedViewportLog,
} from './helpers/viewportDiagnosticFixture';
import { installTestVisualViewport, setTestVisualViewport } from './helpers/visualViewport';

const AUTO_PATH = '/diagnostics/viewport-auto';
const panel = (page: Page) => page.getByLabel('Automatic native recovery', { exact: true });
async function enable(page: Page, mocked = true) {
  await page.setViewportSize({ width: 428, height: 926 });
  if (mocked) await installTestVisualViewport(page);
  const fixture = await openViewportDiagnostic(page, 'baseline', AUTO_PATH);
  expect(await page.evaluate(() => history.length)).toBe(1);
  await page.evaluate(() => history.replaceState({ ...history.state, autoOpaque: 'preserved' }, ''));
  await page.getByRole('button', { name: 'Enable automatic recovery' }).click();
  await expect(panel(page)).toHaveAttribute('data-phase', 'watching');
  expect(await page.evaluate(() => history.length)).toBe(2);
  return fixture;
}
async function touch(page: Page, count: number) {
  await page.evaluate(value => {
    const event = new Event(value ? 'touchstart' : 'touchend');
    Object.defineProperty(event, 'touches', { value: Array.from({ length: value }, () => ({})) });
    window.dispatchEvent(event);
  }, count);
}
async function pinch(page: Page, scale: number) {
  await touch(page, 2);
  await setTestVisualViewport(page, 300, 0, scale);
  await touch(page, 0);
  await expect(panel(page)).toHaveAttribute('data-intent', scale === 1 ? 'original' : 'intentional-nonunit');
}
async function rotateEnlarged(page: Page, landscape: boolean) {
  await setTestVisualViewport(page, 180, 0, 2.16);
  await page.setViewportSize(landscape ? { width: 832, height: 390 } : { width: 428, height: 926 });
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
}
async function mockCorrection(page: Page, cycle: number, landscape: boolean) {
  await rotateEnlarged(page, landscape);
  await page.waitForFunction(() => history.state?.viewportHistoryProbe?.role === 'checkpoint');
  await setTestVisualViewport(page, landscape ? 390 : 926, 0, 1);
  await expect(panel(page)).toHaveAttribute('data-phase', 'watching');
  await expect(panel(page)).toHaveAttribute('data-corrections', String(cycle));
  const state = await page.evaluate(() => ({
    length: history.length, marker: history.state.viewportHistoryProbe, opaque: history.state.autoOpaque,
  }));
  expect(state.length).toBe(2);
  expect(state.marker).toMatchObject({ role: 'working', cycle });
  expect(state.opaque).toBe('preserved');
  return state;
}

test('three automatic cycles preserve live chat and state with a fixed-size history pair', async ({ page }) => {
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
  await composer.fill('@alpha Automatic native continuity');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.agent.streamingMessage')).toBeVisible();
  await composer.fill('PRIVATE_AUTO_DRAFT');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'private-auto.txt', mimeType: 'text/plain', buffer: Buffer.from('PRIVATE_AUTO_ATTACHMENT'),
  });
  await composer.blur();
  const resumeCount = actions.filter(action => action === 'resume-session').length;
  for (let cycle = 1; cycle <= 3; cycle++) {
    await pinch(page, 1);
    await mockCorrection(page, cycle, cycle % 2 === 1);
    await expect(composer).toHaveValue('PRIVATE_AUTO_DRAFT');
    await expect(page.locator('.attachmentChip')).toContainText('private-auto.txt');
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
  expect(log.version).toBe(4);
  expect(log.experiment).toBe('native-history-auto');
  expect(log.samples.at(-1).probe).toMatchObject({
    phase: 'watching', corrections: 3, cycle: 3, pendingAck: false, owned: true,
  });
  expect(JSON.stringify(log)).not.toMatch(/PRIVATE_AUTO_DRAFT|PRIVATE_AUTO_ATTACHMENT|private-auto.txt|viewportHistoryProbe/);
  const invalid = structuredClone(log);
  invalid.samples.at(-1).probe.intent = 'not-an-intent';
  expect((await page.request.post(DIAGNOSTIC_ENDPOINT, {
    data: invalid, headers: { Origin: DIAGNOSTIC_ORIGIN },
  })).status()).toBe(400);
});

test('intentional zoom and keyboard/toolbar resizes do not invoke automatic history navigation', async ({ page }) => {
  await enable(page);
  await pinch(page, 2);
  await rotateEnlarged(page, true);
  await page.waitForTimeout(650);
  await expect(panel(page)).toHaveAttribute('data-corrections', '0');
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('working');
  const composer = page.locator('.composerTextarea');
  await composer.focus();
  await setTestVisualViewport(page, 180, 0, 2);
  await page.waitForTimeout(650);
  await expect(panel(page)).toHaveAttribute('data-corrections', '0');
  await composer.blur();
  await setTestVisualViewport(page, 390, 0, 1);
  await pinch(page, 1);
  await setTestVisualViewport(page, 180, 0, 2);
  await page.waitForTimeout(650);
  await expect(panel(page)).toHaveAttribute('data-corrections', '0');
});

test('Back stops automatic recovery and is not followed by a compensating push', async ({ page }) => {
  await enable(page);
  await page.goBack();
  await expect(panel(page)).toHaveAttribute('data-phase', 'stopped');
  await page.waitForTimeout(450);
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('checkpoint');
  expect(await page.evaluate(() => history.length)).toBe(2);
});

test('a mobile overlay owns its navigation and invalidates the recovery experiment', async ({ page }) => {
  await enable(page);
  await page.getByRole('button', { name: 'Open navigation' }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(panel(page)).toHaveAttribute('data-phase', 'stopped');
  expect(await page.evaluate(() => history.length)).toBe(3);
  expect(await page.evaluate(() => history.state.agentsChatMobileOverlay)).toBe(true);
  await page.getByRole('button', { name: 'Close active panel' }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('.chatPageRoot .page')).toHaveAttribute('data-mobile-overlay', 'none');
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('working');
  await expect(panel(page)).toHaveAttribute('data-phase', 'stopped');
  expect(await page.evaluate(() => history.length)).toBe(3);
});

test('Stop during an in-flight restoration allows acknowledgment but never rearms', async ({ page }) => {
  await enable(page);
  await rotateEnlarged(page, true);
  await page.waitForFunction(() => history.state?.viewportHistoryProbe?.role === 'checkpoint');
  await page.getByRole('button', { name: 'Stop automatic recovery' }).click();
  await setTestVisualViewport(page, 390, 0, 1);
  await page.waitForTimeout(450);
  await expect(panel(page)).toHaveAttribute('data-phase', 'stopped');
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('checkpoint');
  expect(await page.evaluate(() => history.length)).toBe(2);
});

test('manual and ordinary URLs cannot enable automatic navigation', async ({ page }) => {
  for (const url of [
    '/', '/?viewportDiagnostics=baseline',
    '/diagnostics/viewport-history?viewportDiagnostics=baseline',
    '/diagnostics/viewport-minimum?viewportDiagnostics=baseline',
    AUTO_PATH, `${AUTO_PATH}?viewportDiagnostics=isolated`,
  ]) {
    await openViewportDiagnostic(page, undefined, url);
    await expect(panel(page)).toHaveCount(0);
    expect(await page.evaluate(() => history.state.viewportHistoryProbe)).toBeUndefined();
  }
});

test('three real Chromium native correction cycles produce durable mechanism evidence', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-chromium', 'Native CDP observation is not iOS WKWebView acceptance.');
  await enable(page, false);
  const cdp = await context.newCDPSession(page);
  const outcomes: unknown[] = [];
  for (let cycle = 1; cycle <= 3; cycle++) {
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await page.setViewportSize(cycle % 2
      ? { width: 832, height: 390 } : { width: 428, height: 926 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expect(panel(page)).toHaveAttribute('data-corrections', String(cycle));
    await expect(panel(page)).toHaveAttribute('data-phase', 'watching');
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
  const file = testInfo.outputPath('native-automatic-cycles.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ outcomes, limitation: 'Chromium CDP, not physical iOS Chrome.' }));
  await testInfo.attach('native-automatic-cycles.json', { path: file, contentType: 'application/json' });
});
