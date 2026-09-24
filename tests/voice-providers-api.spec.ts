import { expect, test } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

test('invalid provider configuration fails explicitly instead of advertising Whisper', async ({ page }) => {
  test.skip(process.env.VOICE_EXPECT_INVALID !== '1', 'Invalid-configuration Actions phase');
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  for (const response of [
    await api.get('/api/voice'),
    await api.post('/api/voice', {
      headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local' }, data: Buffer.alloc(46),
    }),
  ]) {
    expect(response.status()).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'voice_not_configured' });
  }
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toHaveCount(0);
});
