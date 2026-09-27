import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

test('real selected model transcribes through the authenticated application API', async ({ page }) => {
  test.skip(!process.env.VOICE_REAL_SAMPLE, 'Runs only with the pinned native runtime in Actions');
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  expect(await (await page.context().request.get('/api/voice')).json()).toMatchObject({
    enabled: true, model: process.env.VOICE_EXPECT_MODEL || 'base-q5_1',
  });
  const audio = await readFile(process.env.VOICE_REAL_SAMPLE!);
  const response = await page.context().request.post('/api/voice', {
    headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local' },
    data: audio, timeout: 125_000,
  });
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.ok).toBe(true);
  expect(result.text).toMatch(/country/i);
  expect(result.elapsedMs).toBeGreaterThan(0);
  expect(result.elapsedMs).toBeLessThan(120_000);
});
