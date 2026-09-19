import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { encode } from 'next-auth/jwt';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { METRIC_KEYS, validateDiagnosticLog } from '../lib/viewportDiagnostics';
import { installTypographyFixture } from './helpers/typographyFixture';
import { installTestVisualViewport, setTestVisualViewport } from './helpers/visualViewport';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ORIGIN = new URL(BASE).origin;
const ENDPOINT = '/api/diagnostics/viewport';

async function authenticate(context: BrowserContext, role = 'admin') {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('Diagnostic API tests require the isolated CI NEXTAUTH_SECRET.');
  const token = await encode({
    secret,
    token: {
      sub: role === 'admin' ? 'admin' : 'viewport-ci',
      email: role === 'admin' ? 'admin@local' : 'viewport-ci@example.test',
      name: 'Viewport CI', role,
    },
  });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
}

async function open(page: Page, mode?: string, pathname = '/') {
  const fixture = await installTypographyFixture(page);
  await authenticate(page.context());
  await page.goto(mode ? `${pathname}?viewportDiagnostics=${mode}` : pathname);
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.user.role).toBe('admin');
  return fixture;
}

function payload() {
  return {
    version: 3, experiment: null, mode: 'baseline', browser: 'chrome', browserVersion: '153.0.8010.24',
    osVersion: '18.7.8', clientRevision: null, assets: ['/_next/static/chunks/test.css'], dropped: 0, samples: [],
    initial: {
      t: 0, event: 'initial', gesture: false, focus: 'none', orientation: 'portrait', mobile: true, probe: null,
      metrics: Object.fromEntries(METRIC_KEYS.map(key => [key, key === 'scale' ? 1 : null])),
    },
  };
}

async function savedLog(id: string) {
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  const file = path.join(process.cwd(), '.next/standalone/.data/tmp/viewport-diagnostics', `${id}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } finally {
    await unlink(file);
  }
}

test('normal and unknown-mode pages do not expose diagnostics or upload', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes(ENDPOINT)) requests.push(request.url()); });
  await open(page);
  await expect(page.getByLabel('Viewport diagnostics')).toHaveCount(0);
  await page.goto('/?viewportDiagnostics=unknown');
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
  await expect(page.getByLabel('Viewport diagnostics')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('native history candidate exposes an explicit probe without changing viewport policy', async ({ page }) => {
  await open(page, 'baseline', '/diagnostics/viewport-history');
  await expect(page.getByRole('button', { name: 'Establish 100% checkpoint' })).toBeVisible();
  await expect(page.locator('meta[name="viewport"]'))
    .not.toHaveAttribute('content', /minimum-scale|maximum-scale/);
});

const HISTORY_PATH = '/diagnostics/viewport-history';
const historyProbe = (page: Page) => page.getByLabel('Native history probe', { exact: true });

async function armHistoryProbe(page: Page) {
  expect(await page.evaluate(() => history.length)).toBe(1);
  await page.getByRole('button', { name: 'Establish 100% checkpoint' }).click();
  await expect(historyProbe(page)).toHaveAttribute('data-phase', 'armed');
  expect(await page.evaluate(() => history.length)).toBe(2);
}

async function enlargeHistoryProbe(page: Page) {
  await page.setViewportSize({ width: 832, height: 390 });
  await setTestVisualViewport(page, 180, 0, 2.16);
  await expect(page.getByLabel('Recorded scale')).toHaveText('2.16x');
  // Match the controller's real 300 ms stability requirement, not just one event.
  await page.waitForTimeout(450);
}

test('history traversal preserves chat, draft, attachments and a live response without reloading', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 926 });
  await installTestVisualViewport(page);
  const fixture = await open(page, 'baseline', HISTORY_PATH);
  await page.evaluate(() => history.replaceState({ ...history.state, probeTestOpaque: 'retained' }, ''));
  const documentHandle = await page.evaluateHandle(() => document);
  const shellHandle = await page.locator('.chatPageRoot .page').elementHandle();
  const composerHandle = await page.locator('.composerTextarea').elementHandle();
  const originalUrl = page.url();
  await armHistoryProbe(page);

  const requests: string[] = [];
  let documentRequests = 0;
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests++;
    if (new URL(request.url()).pathname === '/api/acp' && request.method() === 'POST') {
      requests.push(request.postDataJSON().action);
    }
  });
  const composer = page.locator('.composerTextarea');
  await composer.fill('@alpha History continuity check');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.agent.streamingMessage')).toBeVisible();
  await composer.fill('PRIVATE_HISTORY_DRAFT');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'history-private.txt', mimeType: 'text/plain', buffer: Buffer.from('PRIVATE_ATTACHMENT_CONTENT'),
  });
  await expect(page.locator('.attachmentChip')).toContainText('history-private.txt');
  await composer.blur();
  const resumeCount = requests.filter(action => action === 'resume-session').length;
  await enlargeHistoryProbe(page);
  await page.getByRole('button', { name: 'Restore native scale' }).click();
  await page.waitForFunction(() => history.state?.viewportHistoryProbe?.role === 'checkpoint');
  await setTestVisualViewport(page, 390, 0, 1);
  await expect(historyProbe(page)).toHaveAttribute('data-phase', 'restored');
  expect(page.url()).toBe(originalUrl);
  expect(await page.evaluate(doc => doc === document, documentHandle)).toBe(true);
  expect(await shellHandle!.evaluate(node => node === document.querySelector('.chatPageRoot .page'))).toBe(true);
  expect(await composerHandle!.evaluate(node => node === document.querySelector('.composerTextarea'))).toBe(true);
  expect(await page.evaluate(() => history.state.probeTestOpaque)).toBe('retained');
  await expect(composer).toHaveValue('PRIVATE_HISTORY_DRAFT');
  await expect(page.locator('.attachmentChip')).toContainText('history-private.txt');
  await expect(page.locator('.message.user').first()).toContainText('Stable heading');
  fixture.append();
  await expect(page.locator('.message.agent:last-child')).toContainText('Additional streaming paragraph.');
  expect(requests.filter(action => action === 'send')).toHaveLength(1);
  expect(requests.filter(action => action === 'resume-session')).toHaveLength(resumeCount);
  expect(documentRequests).toBe(0);
  fixture.finish();
  await expect(page.locator('.message.agent:last-child')).not.toHaveClass(/streamingMessage/);

  const responsePromise = page.waitForResponse(response => response.url().includes(ENDPOINT));
  await page.getByRole('button', { name: 'Upload diagnostic log' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const stored = await savedLog((await response.json()).id);
  expect(validateDiagnosticLog(stored.log)).toBe(true);
  expect(stored.log.experiment).toBe('native-history');
  const phases = stored.log.samples.filter((sample: { event: string }) => sample.event === 'probe')
    .map((sample: { probe: { phase: string } }) => sample.probe.phase);
  expect(phases).toEqual(expect.arrayContaining(['arming', 'armed', 'restoring', 'restored']));
  expect(JSON.stringify(stored)).not.toMatch(/PRIVATE_HISTORY_DRAFT|PRIVATE_ATTACHMENT_CONTENT|history-private.txt|probeTestOpaque|viewportHistoryProbe/);
});

test('history probe records failure if native scale does not recover and keeps controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 926 });
  await installTestVisualViewport(page);
  await open(page, 'baseline', HISTORY_PATH);
  await armHistoryProbe(page);
  await enlargeHistoryProbe(page);
  await page.getByRole('button', { name: 'Restore native scale' }).click();
  await expect(historyProbe(page)).toHaveAttribute('data-phase', 'not-restored');
  await expect(page.getByTestId('native-history-status')).toContainText('did not return to 100%');
  await expect(page.getByLabel('Recorded scale')).toHaveText('2.16x');
  const panel = await page.getByLabel('Viewport diagnostics').boundingBox();
  expect(panel).not.toBeNull();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.y).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(832 / 2.16 + 1);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(181);
  await page.getByRole('button', { name: 'Upload diagnostic log' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Restore native scale' })).toBeDisabled();
});

test('user Back invalidates the probe without intercepting navigation or automatically retrying', async ({ page }) => {
  await installTestVisualViewport(page);
  await open(page, 'baseline', HISTORY_PATH);
  await armHistoryProbe(page);
  await page.goBack();
  await expect(historyProbe(page)).toHaveAttribute('data-phase', 'invalidated');
  expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('checkpoint');
  await expect(page.getByRole('button', { name: 'Restore native scale' })).toBeDisabled();
  expect(await page.evaluate(() => history.length)).toBe(2);
});

test('existing history and non-probe URLs never acquire a probe checkpoint', async ({ page }) => {
  await installTestVisualViewport(page);
  await open(page, 'baseline', HISTORY_PATH);
  await page.evaluate(() => history.pushState({ ...history.state, unrelated: true }, ''));
  await page.getByRole('button', { name: 'Establish 100% checkpoint' }).click();
  await expect(page.getByTestId('native-history-status')).toContainText('fresh tab');
  expect(await page.evaluate(() => history.length)).toBe(2);
  expect(await page.evaluate(() => history.state.viewportHistoryProbe)).toBeUndefined();
  for (const url of [
    '/?viewportDiagnostics=baseline', '/?viewportDiagnostics=isolated',
    '/diagnostics/viewport-minimum?viewportDiagnostics=baseline',
    HISTORY_PATH, `${HISTORY_PATH}?viewportDiagnostics=isolated`,
  ]) {
    await page.goto(url);
    await expect(page.locator('.composerTextarea')).toBeVisible();
    await expect(historyProbe(page)).toHaveCount(0);
    expect(await page.evaluate(() => history.state.viewportHistoryProbe)).toBeUndefined();
  }
});

test('real Chromium native page-scale history outcome is recorded separately from mocked policy', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-chromium', 'Native CDP experiment uses mobile Chromium, not iOS.');
  await page.setViewportSize({ width: 428, height: 926 });
  await open(page, 'baseline', HISTORY_PATH);
  await armHistoryProbe(page);
  await page.setViewportSize({ width: 832, height: 390 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBe(2);
  await page.waitForTimeout(450);
  // CDP changes native scale, but automated click coordinates differ by engine.
  // This case probes the mechanism, not the physical iPhone touch target.
  await page.getByRole('button', { name: 'Restore native scale' }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(historyProbe(page)).toHaveAttribute('data-phase', /^(restored|not-restored)$/);
  await testInfo.attach('native-chromium-history-outcome.json', {
    body: JSON.stringify({
      phase: await historyProbe(page).getAttribute('data-phase'),
      metrics: await page.evaluate(() => ({
        scale: visualViewport?.scale, width: visualViewport?.width,
        clientWidth: document.documentElement.clientWidth,
      })),
      limitation: 'Chromium CDP observation, not physical iOS Chrome acceptance.',
    }),
    contentType: 'application/json',
  });
});

for (const mode of ['baseline', 'isolated']) {
  test(`${mode} preserves its declared pinch gate and resumes at scale 1`, async ({ page }) => {
    await installTestVisualViewport(page);
    await open(page, mode);
    await expect(page.getByLabel('Viewport diagnostics')).toHaveAttribute('data-mode', mode);
    const shell = page.locator('.chatPageRoot .page');
    const height = () => shell.evaluate(element => element.style.getPropertyValue('--app-viewport-height'));
    await setTestVisualViewport(page, 700, 0);
    await expect.poll(height).toBe('700px');
    await page.evaluate(() => {
      const event = new Event('touchstart');
      Object.defineProperty(event, 'touches', { value: [{}, {}] });
      window.dispatchEvent(event);
    });
    await setTestVisualViewport(page, 350, 20, 2);
    await expect(page.getByLabel('Recorded scale')).toHaveText('2x');
    await expect.poll(height).toBe(mode === 'isolated' ? '700px' : '350px');
    await setTestVisualViewport(page, 360, 24, 1);
    await expect.poll(height).toBe(mode === 'isolated' ? '700px' : '360px');
    await page.evaluate(() => {
      const event = new Event('touchend');
      Object.defineProperty(event, 'touches', { value: [] });
      window.dispatchEvent(event);
    });
    await expect.poll(height).toBe('360px');
    await page.setViewportSize({ width: 844, height: 390 });
    await setTestVisualViewport(page, 390, 0);
    await expect.poll(height).toBe('390px');
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*(?:no|0)/);
  });
}

test('manual upload saves actual diagnostic data without chat or input content', async ({ page }) => {
  await open(page, 'baseline');
  await expect(page.getByLabel('Viewport diagnostics')).toBeVisible();
  await page.locator('textarea.composerTextarea').fill('PRIVATE_DIAGNOSTIC_SENTINEL');
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  const responsePromise = page.waitForResponse(response => response.url().includes(ENDPOINT));
  await page.getByRole('button', { name: 'Upload diagnostic log' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  await expect(page.locator('.viewportDiagnosticsStatus')).toContainText(`Saved log: ${id}`);
  const stored = await savedLog(id);
  expect(validateDiagnosticLog(stored.log)).toBe(true);
  expect(stored.log.mode).toBe('baseline');
  expect(stored.log.version).toBe(3);
  expect(stored.log.initial.metrics.viewportMinimumScale).toBeNull();
  expect(stored.log.samples.some((sample: { event: string }) => sample.event === 'orientation')).toBe(true);
  expect(stored.serverBuildId).toBeTruthy();
  expect(stored.log.clientRevision).toBe(process.env.GITHUB_SHA);
  expect(JSON.stringify(stored)).not.toContain('PRIVATE_DIAGNOSTIC_SENTINEL');
  expect(JSON.stringify(stored)).not.toContain('Stable prose');
});

for (const pathname of ['/', '/diagnostics/viewport-minimum']) {
  test(`${pathname} serves the intended viewport before and after hydration`, async ({ page, context }) => {
    await authenticate(context);
    const response = await page.request.get(pathname);
    expect(response.status()).toBe(200);
    expect(new URL(response.url()).pathname).toBe(pathname);
    const html = await response.text();
    const viewportTags = html.match(/<meta\b[^>]*name="viewport"[^>]*>/g) || [];
    expect(viewportTags).toHaveLength(1);
    const content = viewportTags[0].match(/content="([^"]+)"/)?.[1];
    expect(content).toContain('width=device-width');
    expect(content).toContain('initial-scale=1');
    expect(content).toContain('interactive-widget=resizes-content');
    expect(content).not.toMatch(/maximum-scale|user-scalable\s*=\s*(no|0)/);
    if (pathname === '/') expect(content).not.toContain('minimum-scale');
    else expect(content).toMatch(/(?:^|,)\s*minimum-scale=1(?:,|$)/);
    await open(page, 'baseline', pathname);
    await expect(page.locator('meta[name="viewport"]')).toHaveCount(1);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', content!);
    await expect(page.getByLabel('Viewport diagnostics')).toContainText(
      pathname === '/' ? 'Minimum: unspecified' : 'Minimum: 1',
    );
  });
}

test('candidate upload records the actual minimum and leaves the ordinary policy unchanged', async ({ page }) => {
  await open(page, 'baseline', '/diagnostics/viewport-minimum');
  const responsePromise = page.waitForResponse(response => response.url().includes(ENDPOINT));
  await page.getByRole('button', { name: 'Upload diagnostic log' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  await expect(page.locator('.viewportDiagnosticsStatus')).toContainText(`Saved log: ${id}`);
  const stored = await savedLog(id);
  expect(stored.log.version).toBe(3);
  expect(validateDiagnosticLog(stored.log)).toBe(true);
  expect(stored.log.initial.metrics.viewportMinimumScale).toBe(1);
  expect(stored.log.samples.length).toBeGreaterThan(0);
  expect(stored.log.samples.every((sample: { metrics: { viewportMinimumScale: number } }) =>
    sample.metrics.viewportMinimumScale === 1)).toBe(true);
  await page.goto('/?viewportDiagnostics=baseline');
  await expect(page.getByLabel('Viewport diagnostics')).toContainText('Minimum: unspecified');
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute('content', /minimum-scale/);
});

test('failed upload is explicit and retries the same frozen snapshot', async ({ page }) => {
  await open(page, 'baseline');
  const requests: unknown[] = [];
  await page.route(`**${ENDPOINT}`, route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: requests.length === 1 ? 500 : 201,
      json: requests.length === 1
        ? { ok: false, message: 'Temporary storage failure' }
        : { ok: true, id: '00000000-0000-4000-8000-000000000001' },
    });
  });
  await page.getByRole('button', { name: 'Upload diagnostic log' }).click();
  await expect(page.locator('.viewportDiagnosticsStatus')).toContainText('Temporary storage failure');
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await page.getByRole('button', { name: 'Retry upload' }).click();
  await expect(page.locator('.viewportDiagnosticsStatus')).toContainText('Saved log:');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('permission and network failures never look like successful uploads', async ({ page }) => {
  await open(page, 'isolated');
  await page.route(`**${ENDPOINT}`, route => route.fulfill({
    status: 403, json: { ok: false, message: 'Only administrators can upload diagnostics.' },
  }));
  await page.getByRole('button', { name: 'Upload diagnostic log' }).click();
  await expect(page.locator('.viewportDiagnosticsStatus')).toContainText('Only administrators');
  await page.unroute(`**${ENDPOINT}`);
  await page.route(`**${ENDPOINT}`, route => route.abort());
  await page.getByRole('button', { name: 'Retry upload' }).click();
  await expect(page.locator('.viewportDiagnosticsStatus')).toHaveAttribute('data-error', 'true');
  await expect(page.locator('.viewportDiagnosticsStatus')).not.toContainText('Saved log:');
});

test('real API enforces authentication, administrator access, origin, and schema', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'HTTP contract runs once against the built server.');
  const post = (data: unknown, headers = { Origin: ORIGIN }) =>
    page.request.post(ENDPOINT, { data, headers });
  expect((await post(payload())).status()).toBe(401);
  await authenticate(context, 'user');
  expect((await post(payload())).status()).toBe(403);
  await authenticate(context);
  expect((await post(payload(), { Origin: 'https://foreign.example' })).status()).toBe(403);
  expect((await post(payload(), {})).status()).toBe(403);
  expect((await post({ ...payload(), chat: 'not permitted' })).status()).toBe(400);
  const outdated = await post({ ...payload(), version: 1 });
  expect(outdated.status()).toBe(400);
  expect((await outdated.json()).message).toMatch(/fresh diagnostic tab/);
  expect((await post({ ...payload(), version: 2 })).status()).toBe(400);
  expect((await page.request.post(ENDPOINT, {
    data: '{broken', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
  })).status()).toBe(400);
  expect((await page.request.post(ENDPOINT, {
    data: '{}', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
  })).status()).toBe(415);
  expect((await page.request.post(ENDPOINT, {
    data: ' '.repeat(256 * 1024 + 1), headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
  })).status()).toBe(413);
  const response = await post(payload());
  expect(response.status()).toBe(201);
  expect(response.headers()['cache-control']).toBe('no-store');
  const { id } = await response.json();
  expect((await savedLog(id)).log).toEqual(payload());
});
