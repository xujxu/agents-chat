import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { validateVoiceWav } from '../lib/voice/audio';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import {
  collectLocalConsistency, installedConsistencyConfiguration,
  type ConsistencyOutcome, type ConsistencySample,
} from './helpers/voiceConsistency';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test('installed Sense repeated native, transcriber and API outputs', async ({ page }) => {
  test.skip(process.env.SENSE_CONSISTENCY !== '1', 'Actions-only diagnostic experiment');
  test.setTimeout(1800000);
  const threads = Number(process.env.CONSISTENCY_THREADS);
  expect([1, 2, 4]).toContain(threads);
  const { config, identity } = await installedConsistencyConfiguration(threads);
  const samples: ConsistencySample[] = JSON.parse(await readFile('diagnostics/samples.json', 'utf8'));
  expect(samples).toHaveLength(12);
  const output = `diagnostics/attempts-${threads}.jsonl`;
  await writeFile(output, '');
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
  const api = page.context().request;
  const capability = await api.get('/api/voice');
  expect(capability.status()).toBe(200);
  expect(await capability.json()).toMatchObject({
    enabled: true, model: 'sensevoice-small-q8', resourcePolicy: 'standard', threads,
  });
  let count = 0;
  for (const repetition of [1, 2, 3]) {
    for (const sample of samples) {
      expect(sample.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      const audio = await readFile(`corpus/audio/${sample.id}.wav`);
      expect(createHash('sha256').update(audio).digest('hex')).toBe(sample.audio_sha256);
      validateVoiceWav(audio);
      for (const surface of ['native', 'transcriber', 'api'] as const) {
        let result: ConsistencyOutcome;
        if (surface !== 'api') result = await collectLocalConsistency(surface, audio, config);
        else {
          result = { text: null, failure: null, seconds: 0, status: null, apiElapsedMs: null,
            stdoutBase64: null, stdoutSha256: null };
          const started = performance.now();
          let response;
          try {
            response = await api.post('/api/voice', {
              headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local',
                'x-voice-request-id': randomUUID() },
              data: audio, timeout: 130000,
            });
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            result.failure = 'transport_error';
          }
          result.seconds = (performance.now() - started) / 1000;
          if (response) {
            result.status = response.status();
            expect([200, 422, 500, 502, 503, 504]).toContain(result.status);
            const body = await response.json();
            if (result.status === 200) {
              expect(body.ok).toBe(true);
              expect(typeof body.text).toBe('string');
              expect(typeof body.elapsedMs).toBe('number');
              expect(Number.isFinite(body.elapsedMs)).toBe(true);
              expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
              if (!body.text.trim()) result.failure = 'empty_transcript';
              else { result.text = body.text; result.apiElapsedMs = body.elapsedMs; }
            } else {
              expect(body.ok).toBe(false);
              expect(typeof body.error).toBe('string');
              expect(body.error).not.toBe('');
              expect(body.error).not.toBe('voice_not_configured');
              result.failure = body.error;
            }
          }
        }
        await appendFile(output, JSON.stringify({
          ...sample, platform: config.platform, identity, threads, repetition, surface, ...result,
        }) + '\n');
        count++;
        console.log(`${sample.id} t=${threads} repeat=${repetition} ${surface} failure=${result.failure}`);
      }
    }
  }
  expect(count).toBe(108);
  await writeFile(`diagnostics/complete-${threads}.json`, JSON.stringify({ threads, count }));
});
