import { expect, test, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { registerVoiceCleanupDiagnostics } from './helpers/voiceCleanupDiagnostics';

registerVoiceCleanupDiagnostics();

async function prepare(page: Page, enabled = true, nativeBackend = false) {
  const fixture = await installMobileChatFixture(page);
  if (!nativeBackend) await page.route('**/api/voice', async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { ok: true, enabled, maxSeconds: 30, model: 'base-q5_1' } });
    }
    return route.fulfill({ json: { ok: true, text: '你好，voice PoC.' } });
  });
  await page.addInitScript(() => {
    const state = window as typeof window & {
      __voiceFixtureCalls?: number;
      __voiceUpload?: { bytes: number; header: string };
    };
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (input === '/api/voice' && init?.method === 'POST' && init.body instanceof Blob) {
        const bytes = new Uint8Array(await init.body.arrayBuffer());
        state.__voiceUpload = { bytes: bytes.length, header: new TextDecoder().decode(bytes.subarray(0, 4)) };
      }
      return originalFetch.call(window, input, init);
    };
    // WebKit may recreate native object wrappers; override the shared prototype.
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {
      configurable: true,
      value: async () => {
        state.__voiceFixtureCalls = (state.__voiceFixtureCalls ?? 0) + 1;
        let stage = 'context';
        try {
          const context = new AudioContext();
          stage = 'destination';
          const destination = context.createMediaStreamDestination();
          stage = 'oscillator';
          const oscillator = context.createOscillator();
          oscillator.connect(destination);
          oscillator.start();
          stage = 'resume';
          await context.resume();
          for (const track of destination.stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => { stop(); oscillator.stop(); void context.close(); };
          }
          return destination.stream;
        } catch (error) {
          console.error('Voice fixture microphone failed', stage, error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });
  });
  await loginMobileFixture(page);
  return fixture;
}

test('selected native provider delivers through recording and the real voice API', async ({ page }) => {
  test.skip(process.env.VOICE_API_FIXTURE !== '1', 'Requires the Actions native fixture server');
  const fixture = await prepare(page, true, true);
  const capabilities = await (await page.context().request.get('/api/voice')).json();
  expect(capabilities.model).toBe(process.env.VOICE_EXPECT_MODEL || 'base-q5_1');
  const input = page.locator('textarea.composerTextarea');
  await input.fill('Keep my draft');
  await record(page);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(input).toHaveValue('Keep my draft\n你好，voice PoC.');
  expect(fixture.acpRequests.filter(request => request.action === 'send')).toHaveLength(0);
});

async function record(page: Page) {
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __voiceFixtureCalls?: number }).__voiceFixtureCalls)).toBeGreaterThan(0);
  await expect(page.getByText('Recording 0:01 / 0:30', { exact: true })).toBeVisible();
}

test('voice is absent when runtime capability is disabled', async ({ page }) => {
  await prepare(page, false);
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toHaveCount(0);
});

test('recording uploads bounded WAV, appends to latest draft, and never sends automatically', async ({ page }, testInfo) => {
  const fixture = await prepare(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let uploaded = false;
  await page.route('**/api/voice', async route => {
    if (route.request().method() === 'GET') return route.fallback();
    uploaded = true;
    await gate;
    await route.fulfill({ json: { ok: true, text: '你好，voice PoC.' } });
  });
  const input = page.locator('textarea.composerTextarea');
  await input.fill('Original draft');
  await record(page);
  await page.screenshot({ path: testInfo.outputPath('voice-recording.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.getByText('Transcribing…', { exact: true })).toBeVisible();
  await input.fill('Edited while waiting');
  await expect.poll(() => uploaded).toBe(true);
  const upload = await page.evaluate(() => (window as typeof window & {
    __voiceUpload?: { bytes: number; header: string };
  }).__voiceUpload);
  expect(upload?.bytes).toBeGreaterThan(44);
  expect(upload?.bytes).toBeLessThan(1024 * 1024);
  expect(upload?.header).toBe('RIFF');
  release();
  await expect(input).toHaveValue('Edited while waiting\n你好，voice PoC.');
  expect(fixture.acpRequests.filter(request => request.action === 'send')).toHaveLength(0);
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
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
    });
  });
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Voice input error' })).toContainText('Microphone permission');
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('Preserve text');
});

test('server busy is explicit and leaves the composer editable', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/voice', route => route.request().method() !== 'POST'
    ? route.fallback()
    : route.fulfill({ status: 429, json: { ok: false, error: 'voice_busy' } }));
  await page.locator('textarea.composerTextarea').fill('Preserve text');
  await record(page);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Voice input error' })).toContainText('busy');
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('Preserve text');
});

for (const action of ['cancel', 'chat change', 'account change']) {
  test(`${action} cancels pending transcription and rejects its late result`, async ({ page }) => {
    await prepare(page);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let uploaded = false;
    let cancelled = false;
    let finished = false;
    let uploadedId: string | undefined;
    await page.route('**/api/voice', async route => {
      if (route.request().method() === 'GET') return route.fallback();
      if (route.request().method() === 'DELETE') {
        expect(route.request().headers()['x-voice-request-id']).toBe(uploadedId);
        cancelled = true;
        return route.fulfill({ json: { ok: true } });
      }
      uploadedId = route.request().headers()['x-voice-request-id'];
      uploaded = true;
      await gate;
      await route.fulfill({ json: { ok: true, text: 'Late private transcript' } });
      finished = true;
    });
    try {
      await page.locator('textarea.composerTextarea').fill('Keep original draft');
      await record(page);
      await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
      await expect.poll(() => uploaded).toBe(true);
      if (action === 'cancel') {
        await page.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
      } else if (action === 'chat change') {
        const navigation = page.getByRole('button', { name: 'Open navigation' });
        if (await navigation.isVisible()) await navigation.click();
        else if (!await page.getByRole('button', { name: 'Second mobile chat' }).isVisible()) {
          await page.getByRole('button', { name: 'More actions' }).click();
          await page.getByRole('menuitem', { name: 'Chats', exact: true }).click();
        }
        await page.getByRole('button', { name: 'Second mobile chat' }).click();
        await expect(page.getByText('Second chat message', { exact: true })).toBeVisible();
      } else {
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret) throw new Error('NEXTAUTH_SECRET is required');
        const cookie = (await page.context().cookies()).find(item => item.name === 'next-auth.session-token');
        if (!cookie) throw new Error('Missing session cookie');
        const token = await encode({ secret, token: { sub: 'bob', name: 'Bob', email: 'bob@local', role: 'admin' } });
        await page.context().addCookies([{ ...cookie, value: token }]);
        const session = page.waitForResponse(response => response.url().includes('/api/auth/session'));
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        expect((await (await session).json()).user.email).toBe('bob@local');
      }
      await expect.poll(() => cancelled).toBe(true);
      release();
      await expect.poll(() => finished).toBe(true);
      await expect(page.locator('textarea.composerTextarea')).not.toHaveValue(/Late private transcript/);
      if (action === 'cancel') await expect(page.locator('textarea.composerTextarea')).toHaveValue('Keep original draft');
    } finally { release(); }
  });
}

test('recording stops automatically at 30 seconds and keeps the WAV within the limit', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/voice', async route => {
    if (route.request().method() === 'GET') return route.fallback();
    return route.fulfill({ json: { ok: true, text: 'Automatically stopped recording' } });
  });
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('Automatically stopped recording', { timeout: 38_000 });
  const uploadBytes = await page.evaluate(() => (window as typeof window & { __voiceUpload?: { bytes: number } }).__voiceUpload?.bytes);
  expect(uploadBytes).toBeGreaterThan(44);
  expect(uploadBytes).toBeLessThanOrEqual(960_044);
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toBeEnabled();
});

test('browser-recorded WAV is accepted by the real authenticated API', async ({ page }) => {
  test.skip(process.env.VOICE_API_FIXTURE !== '1', 'Requires the bounded native fixture server');
  await prepare(page);
  await page.route('**/api/voice', route => route.request().method() === 'POST' ? route.continue() : route.fallback());
  await record(page);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.locator('textarea.composerTextarea')).toHaveValue('你好，voice PoC.');
});
