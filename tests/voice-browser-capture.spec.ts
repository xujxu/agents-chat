import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { encodeVoiceWav, validateVoiceWav } from '../lib/voice/audio';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { armBrowserCapture, installBrowserCapture, playBrowserCapture, snapshotBrowserCapture } from './helpers/voiceBrowserCapture';

const transcript = 'Captured fixture text';
function audio(seconds = 1) {
  const second = Buffer.from(encodeVoiceWav(Float32Array.from(
    { length: 16000 }, (_, index) => .1 * Math.sin(index * .1))));
  // The automatic-stop fixture needs an input longer than the product's recording cap.
  const pcm = Buffer.concat(Array.from({ length: Math.ceil(seconds) }, () => second.subarray(44)))
    .subarray(0, Math.floor(seconds * 16000) * 2);
  const wav = Buffer.concat([second.subarray(0, 44), pcm]);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(pcm.length, 40);
  return wav;
}

async function prepare(page: Page, response = 200) {
  await installMobileChatFixture(page);
  await installBrowserCapture(page);
  await page.route('**/api/voice', route => route.request().method() !== 'POST'
    ? route.fulfill({ json: { ok: true, enabled: true, model: 'sensevoice-small-q8', threads: 2, resourcePolicy: 'standard' } })
    : response === 0 ? route.abort('timedout')
      : route.fulfill({ status: response, json: response === 200
        ? { ok: true, text: transcript, elapsedMs: 1 }
        : { ok: false, error: 'voice_process_failed' } }));
  await loginMobileFixture(page);
}

async function start(page: Page, seconds = 1) {
  await armBrowserCapture(page, audio(seconds).toString('base64'));
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await playBrowserCapture(page);
}

test('capture observer preserves upload bytes and stop-to-composer milestones', async ({ page }) => {
  let actual: Buffer | null = null;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 960044) chunks.push(chunk);
    });
    request.on('end', () => {
      if (request.method !== 'POST' || size > 960044) {
        response.writeHead(400).end();
        return;
      }
      actual = Buffer.concat(chunks);
      response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify({ ok: true, text: transcript, elapsedMs: 1 }));
    });
    request.on('error', error => response.destroy(error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Upload fixture did not bind TCP');
    await prepare(page);
    await page.route('**/api/voice', route => route.request().method() === 'POST'
      ? route.continue({ url: `http://127.0.0.1:${address.port}/upload` }) : route.fallback());
    await start(page);
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(page.locator('textarea.composerTextarea')).toHaveValue(transcript);
    await expect.poll(async () => (await snapshotBrowserCapture(page)).timing.composerAt).not.toBeNull();
    await expect.poll(async () => (await snapshotBrowserCapture(page)).capture.contextClosed).toBe(true);
    const snapshot = await snapshotBrowserCapture(page, true);
    expect(snapshot.observerError).toBeNull();
    expect(actual).not.toBeNull();
    expect(Buffer.from(snapshot.uploadBase64!, 'base64')).toEqual(actual);
    expect(validateVoiceWav(Buffer.from(snapshot.uploadBase64!, 'base64')).durationSeconds).toBeGreaterThanOrEqual(1);
    expect(snapshot.timing.stopKind).toBe('manual');
    expect(snapshot.timing.fetchAt!).toBeGreaterThanOrEqual(snapshot.timing.workletStopAt!);
    expect(snapshot.timing.composerAt!).toBeGreaterThan(snapshot.timing.stopAt!);
    expect(snapshot.capture).toMatchObject({ sourceRate: 48000, sourceCompleted: true, tracksStopped: true, contextClosed: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const status of [500, 0]) {
  test(`capture retains API or transport failure ${status} and cleanup`, async ({ page }) => {
    await prepare(page, status);
    await start(page);
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(page.getByRole('alert', { name: 'Voice input error' })).toBeVisible();
    await expect.poll(async () => (await snapshotBrowserCapture(page)).capture.contextClosed).toBe(true);
    const snapshot = await snapshotBrowserCapture(page, true);
    expect(snapshot.timing.composerAt).toBeNull();
    expect(snapshot.uploadBase64).not.toBeNull();
    expect(snapshot.capture.contextClosed).toBe(true);
    if (status === 0) expect(snapshot.fetchFailure).toBe('transport_error');
    else expect(snapshot.status).toBe(500);
  });
}

test('early stop and cancellation never claim complete source capture', async ({ page }) => {
  await prepare(page);
  await start(page, 5);
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toBeEnabled();
  await expect.poll(async () => (await snapshotBrowserCapture(page)).capture.contextClosed).toBe(true);
  const snapshot = await snapshotBrowserCapture(page, true);
  expect(snapshot.capture.sourceCompleted).toBe(false);
  expect(snapshot.capture.tracksStopped).toBe(true);
  expect(snapshot.capture.contextClosed).toBe(true);
  expect(snapshot.uploadBase64).toBeNull();
});

test('API success without composer delivery stays observable as missing UI evidence', async ({ page }) => {
  await page.addInitScript(text => {
    for (const name of ['value', 'defaultValue']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, name);
      if (!descriptor?.set || !descriptor.get) throw new Error('Native textarea descriptor missing');
      const setter = descriptor.set;
      Object.defineProperty(HTMLTextAreaElement.prototype, name, {
        ...descriptor,
        set(value: string) { if (value !== text) setter.call(this, value); },
      });
    }
  }, transcript);
  await prepare(page);
  await start(page);
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect.poll(async () => (await snapshotBrowserCapture(page)).timing.bodyAt).not.toBeNull();
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toBeEnabled();
  const snapshot = await snapshotBrowserCapture(page, true);
  expect(snapshot.status).toBe(200);
  expect(snapshot.timing.composerAt).toBeNull();
  expect(snapshot.composerText).toBeNull();
});

test('real recorder automatic limit is observed without extending it', async ({ page }) => {
  await prepare(page);
  await start(page, 32);
  await expect(page.locator('textarea.composerTextarea')).toHaveValue(transcript, { timeout: 35000 });
  const snapshot = await snapshotBrowserCapture(page, true);
  expect(snapshot.timing.stopKind).toBe('automatic');
  expect(snapshot.timing.stopAt).toBe(snapshot.timing.workletStopAt);
  expect(snapshot.capture.sourceCompleted).toBe(false);
  expect(validateVoiceWav(Buffer.from(snapshot.uploadBase64!, 'base64')).durationSeconds).toBeLessThanOrEqual(30);
});
