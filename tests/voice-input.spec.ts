import { expect, test, type Page } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

async function prepare(page: Page, enabled = true) {
  const fixture = await installMobileChatFixture(page);
  await page.route('**/api/voice', async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { ok: true, enabled, maxSeconds: 30, model: 'base-q5_1' } });
    }
    return route.fulfill({ json: { ok: true, text: '你好，voice PoC.' } });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator();
        oscillator.connect(destination);
        oscillator.start();
        await context.resume();
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); oscillator.stop(); void context.close(); };
        }
        return destination.stream;
      },
    });
  });
  await loginMobileFixture(page);
  return fixture;
}

async function record(page: Page) {
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await expect(page.getByText('Recording 0:01 / 0:30', { exact: true })).toBeVisible();
}

test('voice is absent when runtime capability is disabled', async ({ page }) => {
  await prepare(page, false);
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toHaveCount(0);
});

test('recording uploads bounded WAV, appends to latest draft, and never sends automatically', async ({ page }) => {
  const fixture = await prepare(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let upload: Buffer | null = null;
  await page.route('**/api/voice', async route => {
    if (route.request().method() === 'GET') return route.fallback();
    upload = route.request().postDataBuffer();
    await gate;
    await route.fulfill({ json: { ok: true, text: '你好，voice PoC.' } });
  });
  const input = page.locator('textarea.composerTextarea');
  await input.fill('Original draft');
  await record(page);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.getByText('Transcribing…', { exact: true })).toBeVisible();
  await input.fill('Edited while waiting');
  await expect.poll(() => upload?.length ?? 0).toBeGreaterThan(44);
  expect(upload!.length).toBeLessThan(1024 * 1024);
  expect(upload!.subarray(0, 4).toString()).toBe('RIFF');
  release();
  await expect(input).toHaveValue('Edited while waiting\n你好，voice PoC.');
  expect(fixture.acpRequests.filter(request => request.action === 'prompt')).toHaveLength(0);
  const button = await page.getByRole('button', { name: 'Start voice input', exact: true }).boundingBox();
  expect(button).not.toBeNull();
  expect(button!.x).toBeGreaterThanOrEqual(0);
  expect(button!.x + button!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('cancel discards recording without upload and preserves the draft', async ({ page }) => {
  await prepare(page);
  let uploads = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/voice') && request.method() === 'POST') uploads++;
  });
  await page.locator('textarea.composerTextarea').fill('Keep this draft');
  await record(page);
  await page.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toBeVisible();
  expect(uploads).toBe(0);
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('Keep this draft');
});

test('microphone denial and backend failures are visible without clearing text', async ({ page }) => {
  await prepare(page);
  await page.locator('textarea.composerTextarea').fill('Preserve text');
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
    });
  });
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone permission');
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('Preserve text');
});

test('server busy is explicit and leaves the composer editable', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/voice', route => route.request().method() === 'GET'
    ? route.fallback()
    : route.fulfill({ status: 429, json: { ok: false, error: 'voice_busy' } }));
  await page.locator('textarea.composerTextarea').fill('Preserve text');
  await record(page);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('busy');
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('Preserve text');
});
