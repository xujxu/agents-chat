import { expect, test } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

test('disabled voice API has no capability and refuses transcription', async ({ page }) => {
  test.skip(process.env.VOICE_EXPECT_DISABLED !== '1', 'Runs in the explicitly voice-disabled regression phase');
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  expect(await (await api.get('/api/voice')).json()).toMatchObject({ ok: true, enabled: false, model: null, provider: null });
  expect((await api.post('/api/voice', {
    headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local' }, data: Buffer.alloc(46),
  })).status()).toBe(503);
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toHaveCount(0);
});
