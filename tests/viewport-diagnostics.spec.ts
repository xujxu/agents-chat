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
  const token = await encode({ secret, token: { sub: 'viewport-ci', email: 'viewport-ci@example.test', role } });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
}

async function open(page: Page, mode?: string) {
  await installTypographyFixture(page);
  await authenticate(page.context());
  await page.goto(mode ? `/?viewportDiagnostics=${mode}` : '/');
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
}

function payload() {
  return {
    version: 1, mode: 'baseline', browser: 'chrome', browserVersion: '153.0.8010.24',
    osVersion: '18.7.8', clientRevision: null, assets: ['/_next/static/chunks/test.css'], dropped: 0, samples: [],
    initial: {
      t: 0, event: 'initial', gesture: false, focus: 'none', orientation: 'portrait', mobile: true,
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
  expect(stored.log.samples.some((sample: { event: string }) => sample.event === 'orientation')).toBe(true);
  expect(stored.serverBuildId).toBeTruthy();
  expect(stored.log.clientRevision).toBe(process.env.GITHUB_SHA);
  expect(JSON.stringify(stored)).not.toContain('PRIVATE_DIAGNOSTIC_SENTINEL');
  expect(JSON.stringify(stored)).not.toContain('Stable prose');
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
