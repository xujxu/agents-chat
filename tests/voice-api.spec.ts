import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { encodeVoiceWav, MAX_VOICE_BYTES } from '../lib/voice/audio';

test.beforeEach(() => {
  test.skip(process.env.VOICE_API_FIXTURE !== '1', 'Runs in the voice-enabled native fixture phase');
});

async function activeFixturePid(): Promise<number> {
  const directories = (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-'));
  for (const directory of directories) {
    try {
      return Number(await readFile(path.join(tmpdir(), directory, 'child.pid'), 'utf8'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return 0;
}

test('voice API enforces authentication, ownership, origin, size and WAV format', async ({ page, request }) => {
  expect((await request.get('/api/voice')).status()).toBe(401);
  expect((await request.post('/api/voice', { data: 'audio' })).status()).toBe(401);
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const capability = await api.get('/api/voice');
  expect(capability.status()).toBe(200);
  expect(await capability.json()).toMatchObject({
    enabled: true, maxSeconds: 30, model: process.env.VOICE_EXPECT_MODEL || 'base-q5_1',
    ...(process.env.VOICE_EXPECT_POLICY ? { resourcePolicy: process.env.VOICE_EXPECT_POLICY } : {}),
  });
  const audio = Buffer.from(encodeVoiceWav(new Float32Array(16_000).fill(0.2)));
  const headers = { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local' };
  expect((await api.post('/api/voice', { headers: { ...headers, origin: 'https://other.example' }, data: audio })).status()).toBe(403);
  expect((await api.post('/api/voice', { headers: { ...headers, 'x-voice-user-id': 'different-account' }, data: audio })).status()).toBe(403);
  expect((await api.post('/api/voice', { headers: { ...headers, 'content-type': 'text/plain' }, data: audio })).status()).toBe(415);
  expect((await api.post('/api/voice', { headers, data: Buffer.alloc(MAX_VOICE_BYTES + 1) })).status()).toBe(413);
  expect((await api.post('/api/voice', { headers, data: Buffer.from('not a wav') })).status()).toBe(400);
  const silence = Buffer.from(encodeVoiceWav(new Float32Array(16_000)));
  expect((await api.post('/api/voice', { headers, data: silence })).status()).toBe(422);
  const result = await api.post('/api/voice', { headers, data: audio });
  expect(result.status()).toBe(200);
  expect(await result.json()).toMatchObject({ ok: true, text: '你好，voice PoC.' });
});

test('one global inference slot rejects concurrent work and recovers after completion', async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const data = Buffer.from(encodeVoiceWav(new Float32Array(16_000).fill(0.3)));
  const headers = { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local' };
  const responses = await Promise.all([
    api.post('/api/voice', { headers, data }),
    api.post('/api/voice', { headers, data }),
  ]);
  expect(responses.map(response => response.status()).sort()).toEqual([200, 429]);
  expect((await api.post('/api/voice', { headers, data })).status()).toBe(200);
});

test('normally exiting native processes consistently deliver through the authenticated API', async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const data = Buffer.from(encodeVoiceWav(new Float32Array(16_000).fill(0.2)));
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await api.post('/api/voice', {
      headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local',
        'x-voice-request-id': randomUUID() },
      data,
    });
    const result = await response.json();
    expect(response.status(), JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ ok: true, text: '你好，voice PoC.' });
  }
});

test('explicit cancellation works before upload and releases an active native process', async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const data = Buffer.from(encodeVoiceWav(new Float32Array(16_000).fill(0.2)));
  const earlyHeaders = { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local', 'x-voice-request-id': randomUUID() };
  expect((await api.delete('/api/voice', { headers: earlyHeaders })).status()).toBe(200);
  expect((await api.post('/api/voice', { headers: earlyHeaders, data })).status()).toBe(499);
  const headers = { ...earlyHeaders, 'x-voice-request-id': randomUUID() };
  const pending = api.post('/api/voice', {
    headers, data: Buffer.from(encodeVoiceWav(new Float32Array(16_000).fill(0.4))),
  });
  let childPid: number | undefined;
  await expect.poll(async () => {
    childPid = await activeFixturePid();
    return childPid;
  }).toBeGreaterThan(0);
  const cancelled = await api.delete('/api/voice', { headers });
  expect(cancelled.status()).toBe(200);
  expect((await pending).status()).toBe(499);
  const killedPid = childPid;
  if (!killedPid) throw new Error('Native fixture did not start');
  expect(() => process.kill(killedPid, 0)).toThrow();
  expect((await api.post('/api/voice', { headers: { ...headers, 'x-voice-request-id': randomUUID() }, data })).status()).toBe(200);
});

test('HTTP disconnection kills native inference even without an explicit cancellation request', async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const controller = new AbortController();
  const id = randomUUID();
  const cookies = (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const pending = fetch(new URL('/api/voice', process.env.PLAYWRIGHT_BASE_URL), {
    method: 'POST', signal: controller.signal,
    headers: { cookie: cookies, 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local', 'x-voice-request-id': id },
    body: encodeVoiceWav(new Float32Array(16_000).fill(0.4)),
  }).then(response => String(response.status), error => error instanceof Error ? error.name : String(error));
  try {
    await expect.poll(activeFixturePid).toBeGreaterThan(0);
    controller.abort();
    expect(await pending).toBe('AbortError');
    await expect.poll(activeFixturePid).toBe(0);
  } finally {
    controller.abort();
    await page.context().request.delete('/api/voice', {
      headers: { 'x-voice-user-id': 'admin@local', 'x-voice-request-id': id },
    });
  }
});

test('RSS watchdog terminates an oversized native process and releases admission', async ({ page }) => {
  test.skip(process.env.VOICE_EXPECT_POLICY === 'standard', 'Legacy watchdog is not a standard-mode quota');
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const headers = { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local' };
  const response = await api.post('/api/voice', {
    headers, data: Buffer.from(encodeVoiceWav(new Float32Array(16_000).fill(0.5))),
  });

  test('standard mode does not apply the historical 384 MiB watchdog', async ({ page }) => {
    test.skip(process.env.VOICE_EXPECT_POLICY !== 'standard', 'Explicit new-model configuration only');
    await installMobileChatFixture(page);
    await loginMobileFixture(page);
    const response = await page.context().request.post('/api/voice', {
      headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local' },
      data: Buffer.from(encodeVoiceWav(new Float32Array(16_000).fill(0.5))),
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, text: '你好，voice PoC.' });
  });
  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'voice_memory_limit' });
  expect((await api.post('/api/voice', {
    headers, data: Buffer.from(encodeVoiceWav(new Float32Array(16_000).fill(0.2))),
  })).status()).toBe(200);
});
