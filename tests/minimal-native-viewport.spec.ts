import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  authenticateViewportDiagnostic, DIAGNOSTIC_ORIGIN, readSavedViewportLog,
} from './helpers/viewportDiagnosticFixture';
import {
  dispatchViewportTouches, installTestVisualViewport, setTestVisualViewport,
} from './helpers/visualViewport';

const URL = '/diagnostics/viewport-minimal';
const ENDPOINT = '/api/diagnostics/viewport/minimal';
const start = (page: Page) => page.getByRole('button', { name: 'Start recording', exact: true });
const stop = (page: Page) => page.getByRole('button', { name: 'Stop recording', exact: true });
const upload = (page: Page) => page.getByRole('button', { name: /^(Upload diagnostic log|Retry upload)$/ });

async function open(page: Page) {
  await authenticateViewportDiagnostic(page.context());
  await installTestVisualViewport(page);
  await page.clock.install();
  await page.goto(URL);
  await expect(start(page)).toBeEnabled();
}

async function captured(page: Page) {
  let body = '';
  await page.route(`**${ENDPOINT}`, route => {
    body = route.request().postData() || '';
    return route.fulfill({ status: 201, json: { ok: true, id: '00000000-0000-4000-8000-000000000001' } });
  });
  await upload(page).click();
  await expect(page.locator('#status')).toContainText('Saved log:');
  return JSON.parse(body);
}

test('minimal route serves isolated HTML without framework bootstrap', async ({ page, context }) => {
  await authenticateViewportDiagnostic(context);
  const requests: string[] = [];
  page.on('request', request => requests.push(new globalThis.URL(request.url()).pathname));
  const response = await page.goto('/diagnostics/viewport-minimal');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeVisible();
  await expect(page.locator('script[src], link[rel="stylesheet"]')).toHaveCount(0);
  expect(requests).toEqual(['/diagnostics/viewport-minimal']);
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute('content', /minimum-scale|maximum-scale/);
  expect(await page.locator('#reference').evaluate(element => element.getBoundingClientRect().width)).toBe(100);
  expect(await page.locator('#specimen').evaluate(element => getComputedStyle(element).fontSize)).toBe('16px');
  const html = await response!.text();
  expect(html).not.toMatch(/__next|\/_next\/|react|<link/i);
});

test('passive recording preserves DOM, history and viewport while retaining raw anomalous values', async ({ page }) => {
  await open(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const state = { calls: [] as string[], mutations: 0 };
    Object.assign(window, { minimalTestState: state });
    for (const name of ['pushState', 'replaceState', 'back', 'forward', 'go'] as const) {
      Object.defineProperty(history, name, { value: () => { state.calls.push(name); } });
    }
    const observer = new MutationObserver(records => { state.mutations += records.length; });
    Object.assign(window, { observeMinimal: () => observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true }) });
  });
  const historyLength = await page.evaluate(() => history.length);
  const documentHandle = await page.evaluateHandle(() => document);
  await start(page).click();
  await page.evaluate(() => {
    (window as typeof window & { observeMinimal: () => void }).observeMinimal();
  });
  const activeHtml = await page.locator('body').innerHTML();
  await dispatchViewportTouches(page, 2);
  await setTestVisualViewport(page, 300, 0, 2);
  await page.clock.runFor(450);
  await setTestVisualViewport(page, 600, 0, 1);
  await dispatchViewportTouches(page, 0);
  await page.clock.runFor(400);
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await setTestVisualViewport(page, 600, 0, 2.018817186355591);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'width', { get: () => document.documentElement.clientWidth });
  });
  await page.clock.runFor(1000);
  expect(await page.locator('body').innerHTML()).toBe(activeHtml);
  expect(await page.evaluate(() =>
    (window as typeof window & { minimalTestState: { calls: string[]; mutations: number } }).minimalTestState,
  )).toEqual({ calls: [], mutations: 0 });
  await stop(page).click();
  const log = await captured(page);
  expect(log.version).toBe(1);
  expect(log.experiment).toBe('native-viewport-minimal');
  expect(log.samples.some((s: { touches: number; metrics: { scale: number } }) => s.touches === 2 && s.metrics.scale === 2)).toBe(true);
  expect(log.samples.at(-1).metrics.scale).toBe(2.018817186355591);
  expect(log.samples.at(-1).metrics.visualWidth).toBe(log.samples.at(-1).metrics.clientWidth);
  expect(log.stopReason).toBe('manual');
  expect(log.dropped).toBe(0);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await page.evaluate(doc => doc === document, documentHandle)).toBe(true);
  expect(errors).toEqual([]);
});

test('invalid starting geometry and active contacts are refused without scale changes', async ({ page }) => {
  await open(page);
  await setTestVisualViewport(page, 300, 0, 2);
  await start(page).click();
  await expect(page.locator('#status')).toContainText('original scale');
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(2);
  await setTestVisualViewport(page, 600, 0, 1);
  await dispatchViewportTouches(page, 2);
  await start(page).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('#status')).toContainText('Release');
  await dispatchViewportTouches(page, 0);
  await page.evaluate(() => {
    const input = document.createElement('textarea');
    input.id = 'test-editable';
    document.body.append(input);
    input.focus();
  });
  await start(page).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('#status')).toContainText('editable');
  await page.locator('#test-editable').evaluate(element => element.remove());
  await page.evaluate(() => { document.body.style.width = '2000px'; });
  await start(page).click();
  await expect(page.locator('#status')).toContainText('overflow');
  await page.evaluate(() => { document.body.style.width = ''; });
  await start(page).click();
  await expect(stop(page)).toBeEnabled();
});

test('missing VisualViewport is explicit rather than fabricated scale one', async ({ page, context }) => {
  await authenticateViewportDiagnostic(context);
  await page.addInitScript(() => Object.defineProperty(window, 'visualViewport', { value: undefined }));
  await page.goto(URL);
  await start(page).click();
  await expect(page.locator('#status')).toContainText('VisualViewport');
  await expect(upload(page)).toBeDisabled();
});

for (const reason of ['timeout', 'hidden', 'pagehide'] as const) {
  test(`${reason} freezes a bounded record and does not automatically upload`, async ({ page }) => {
    await open(page);
    let posts = 0;
    page.on('request', request => { if (request.url().endsWith(ENDPOINT)) posts++; });
    await start(page).click();
    if (reason === 'timeout') await page.clock.runFor(30_100);
    else {
      await page.clock.runFor(500);
      await page.evaluate(kind => {
        if (kind === 'hidden') {
          Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        } else window.dispatchEvent(new Event('pagehide'));
      }, reason);
    }
    await expect(stop(page)).toBeDisabled();
    expect(posts).toBe(0);
    const log = await captured(page);
    expect(log.stopReason).toBe(reason);
    expect(log.samples.at(-1).events).toContain(reason);
    expect(log.samples.length).toBeLessThanOrEqual(255);
    if (reason === 'timeout') {
      expect(log.samples.at(-1).t).toBeGreaterThanOrEqual(30_000);
      expect(log.samples.filter((s: { events: string[] }) => s.events.includes('periodic')).length).toBeGreaterThanOrEqual(140);
    }
  });
}

test('event bursts are coalesced and overwritten measurements are counted', async ({ page }) => {
  await open(page);
  await start(page).click();
  for (let i = 0; i < 300; i++) {
    await page.evaluate(() => {
      for (let j = 0; j < 20; j++) window.dispatchEvent(new Event('resize'));
    });
    await page.clock.runFor(20);
  }
  await stop(page).click();
  const log = await captured(page);
  expect(log.samples.length).toBe(255);
  expect(log.dropped).toBeGreaterThan(0);
  expect(log.samples.length + log.dropped).toBeLessThan(1000);
  expect(log.initial.t).toBe(0);
  expect(log.samples.at(-1).events).toContain('stop');
});

test('network, storage and malformed responses retain identical frozen retry data', async ({ page }) => {
  await open(page);
  await start(page).click();
  await page.clock.runFor(500);
  await stop(page).click();
  const requests: string[] = [];
  await page.route(`**${ENDPOINT}`, route => {
    requests.push(route.request().postData() || '');
    if (requests.length === 1) return route.abort();
    if (requests.length === 2) return route.fulfill({ status: 500, json: { ok: false, message: 'Temporary storage failure' } });
    if (requests.length === 3) return route.fulfill({ status: 201, json: { ok: true } });
    return route.fulfill({ status: 201, json: { ok: true, id: '00000000-0000-4000-8000-000000000001' } });
  });
  for (const message of ['Upload failed', 'Temporary storage failure', 'Invalid upload response', 'Saved log:']) {
    await upload(page).click();
    await expect(page.locator('#status')).toContainText(message);
    await setTestVisualViewport(page, 300, 0, 2);
    await page.clock.runFor(500);
  }
  expect(new Set(requests).size).toBe(1);
});

test('minimal HTTP admission and private persistence preserve existing diagnostic policy', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'HTTP contract runs once on the compiled server.');
  const anonymous = await page.request.get(URL, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);
  expect((await page.request.post(ENDPOINT, { data: {}, headers: { Origin: DIAGNOSTIC_ORIGIN } })).status()).toBe(401);
  await open(page);
  await start(page).click();
  await page.clock.runFor(400);
  await stop(page).click();
  const payload = await captured(page);
  await page.unroute(`**${ENDPOINT}`);
  const post = (data: unknown, headers = { Origin: DIAGNOSTIC_ORIGIN }) =>
    page.request.post(ENDPOINT, { data, headers });
  await authenticateViewportDiagnostic(context, 'user');
  expect((await post(payload)).status()).toBe(403);
  await authenticateViewportDiagnostic(context);
  expect((await post(payload, {})).status()).toBe(403);
  expect((await post(payload, { Origin: 'https://foreign.example' })).status()).toBe(403);
  expect((await post({ ...payload, arbitrary: 'private' })).status()).toBe(400);
  expect((await post({ ...payload, experiment: 'native-history' })).status()).toBe(400);
  expect((await page.request.post('/api/diagnostics/viewport', { data: payload, headers: { Origin: DIAGNOSTIC_ORIGIN } })).status()).toBe(400);
  for (const [data, contentType, status] of [
    ['{}', 'text/plain', 415], ['{broken', 'application/json', 400],
    [' '.repeat(256 * 1024 + 1), 'application/json', 413],
  ] as const) {
    expect((await page.request.post(ENDPOINT, {
      data, headers: { Origin: DIAGNOSTIC_ORIGIN, 'Content-Type': contentType },
    })).status()).toBe(status);
  }
  const response = await post(payload);
  expect(response.status()).toBe(201);
  expect(response.headers()['cache-control']).toBe('no-store');
  const saved = await readSavedViewportLog((await response.json()).id);
  expect(saved.log).toEqual(payload);
  expect(saved.serverBuildId).toBeTruthy();
});

test('native Chromium scale remains uncorrected and is recorded as raw evidence', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'android-chromium', 'CDP is not physical iOS validation.');
  await authenticateViewportDiagnostic(context);
  await page.goto(URL);
  await start(page).click();
  await dispatchViewportTouches(page, 2);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBe(2);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(2);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await dispatchViewportTouches(page, 0);
  await page.waitForTimeout(500);
  await stop(page).click();
  const responsePromise = page.waitForResponse(response => response.url().endsWith(ENDPOINT));
  await upload(page).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const saved = await readSavedViewportLog((await response.json()).id);
  expect(saved.log.samples.some((s: { metrics: { scale: number } }) => s.metrics.scale === 2)).toBe(true);
  expect(saved.log.samples.at(-1).metrics.scale).toBe(1);
  const file = info.outputPath('native-minimal-viewport.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    ...saved, limitation: 'Actual Chromium CDP scale with synthetic contacts; not physical iOS rotation evidence.',
  }));
  await info.attach('native-minimal-viewport.json', { path: file, contentType: 'application/json' });
});
