import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { validateVoiceWav } from '../lib/voice/audio';

type Sample = {
  id: string; reference: string; category: string; dataset: string;
  duration: number; split: string; audio_sha256: string;
};

test('installed model transcribes frozen100 through authenticated API', async ({ page }) => {
  test.skip(process.env.INSTALLED_VOICE_ACCEPTANCE !== '1', 'Actions-only installed corpus');
  test.setTimeout(1800000);
  const samples: Sample[] = JSON.parse(await readFile('corpus/samples.json', 'utf8'));
  expect(samples).toHaveLength(100);
  await mkdir('installed-evidence', { recursive: true });
  await writeFile('installed-evidence/results.jsonl', '');
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const model = process.env.INSTALLED_MODEL!;
  expect(await (await api.get('/api/voice')).json()).toMatchObject({
    enabled: true, model: model === 'whisper-base-q5_1' ? 'base-q5_1' : model,
    resourcePolicy: 'standard', threads: model === 'sensevoice-small-q8' ? 2 : 1,
  });
  for (const sample of samples) {
    const audio = await readFile(`corpus/audio/${sample.id}.wav`);
    expect(createHash('sha256').update(audio).digest('hex')).toBe(sample.audio_sha256);
    validateVoiceWav(audio);
    let text: string | null = null;
    let failure: string | null = null;
    let status: number | null = null;
    let apiElapsedMs: number | null = null;
    const started = performance.now();
    let response;
    try {
      response = await api.post('/api/voice', {
        headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local', 'x-voice-request-id': randomUUID() },
        data: audio, timeout: 130000,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = 'transport_error';
    }
    const seconds = (performance.now() - started) / 1000;
    if (response) {
      status = response.status();
      expect([200, 422, 500, 502, 503, 504]).toContain(status);
      const body = await response.json();
      if (status === 200) {
        expect(body.ok).toBe(true);
        expect(typeof body.text).toBe('string');
        expect(Number.isFinite(body.elapsedMs)).toBe(true);
        expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
        text = body.text;
        apiElapsedMs = body.elapsedMs;
        if (!text?.trim()) failure = 'empty_transcript';
      } else {
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe('string');
        failure = body.error;
      }
    }
    await appendFile('installed-evidence/results.jsonl', JSON.stringify({
      ...sample, variant: model, text, failure, seconds, status, apiElapsedMs, peak_rss_kib: null,
    }) + '\n');
    console.log(`${sample.id} status=${status} failure=${failure} seconds=${seconds.toFixed(3)}`);
  }
  await writeFile('installed-evidence/complete.json', JSON.stringify({ count: samples.length, variant: model }));
});
