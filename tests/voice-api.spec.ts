import { expect, test } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { encodeVoiceWav, MAX_VOICE_BYTES } from '../lib/voice/audio';

test('voice API enforces authentication, ownership, origin, size and WAV format', async ({ page, request }) => {
  expect((await request.get('/api/voice')).status()).toBe(401);
  expect((await request.post('/api/voice', { data: 'audio' })).status()).toBe(401);
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const capability = await api.get('/api/voice');
  expect(capability.status()).toBe(200);
  expect(await capability.json()).toMatchObject({ enabled: true, maxSeconds: 30, model: 'base-q5_1' });
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
