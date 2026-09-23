import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { validateVoiceWav } from '../lib/voice/audio';

type Sample = { id: string; duration: number; audio_sha256: string };
type NativeMetric = { peak_rss_kib: number };
type ApiBody = { ok?: boolean; text?: string; error?: string };
type CaptureWindow = Window & {
  __corpusAudio?: string;
  __corpusPlay?: () => void;
  __corpusStarted?: number;
  __corpusUpload?: { base64: string; started: number };
};

async function metrics(): Promise<NativeMetric[]> {
  const text = await readFile('chain-evidence/native-metrics.jsonl', 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as NativeMetric);
}

test('fixed corpus traverses actual authenticated direct and browser audio paths', async ({ page }) => {
  test.skip(process.env.VOICE_CORPUS_CHAIN !== '1', 'CI-only public corpus acceptance');
  test.setTimeout(3_600_000);
  const samples: Sample[] = JSON.parse(await readFile('chain/samples.json', 'utf8'));
  await mkdir('chain-evidence/captured', { recursive: true });
  await writeFile('chain-evidence/results.jsonl', '');
  await writeFile('chain-evidence/native-metrics.jsonl', '');
  await installMobileChatFixture(page);
  await page.addInitScript(() => {
    const state = window as CaptureWindow;
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (input === '/api/voice' && init?.method === 'POST' && init.body instanceof Blob) {
        const bytes = new Uint8Array(await init.body.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        state.__corpusUpload = { base64: btoa(binary), started: performance.now() };
      }
      return originalFetch.call(window, input, init);
    };
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {
      configurable: true,
      value: async () => {
        if (!state.__corpusAudio) throw new Error('Missing corpus waveform');
        const bytes = Uint8Array.from(atob(state.__corpusAudio), char => char.charCodeAt(0));
        const context = new AudioContext({ sampleRate: 48_000 });
        const buffer = await context.decodeAudioData(bytes.buffer);
        const destination = context.createMediaStreamDestination();
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        await context.resume();
        state.__corpusPlay = () => { state.__corpusStarted = performance.now(); source.start(); };
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); source.stop(); void context.close(); };
        }
        return destination.stream;
      },
    });
  });
  await loginMobileFixture(page);
  const api = page.context().request;
  const capability = await api.get('/api/voice');
  expect(capability.status()).toBe(200);
  expect((await capability.json()).enabled).toBe(true);
  for (const sample of samples) {
    const audio = await readFile(`chain/audio/${sample.id}.wav`);
    expect(createHash('sha256').update(audio).digest('hex')).toBe(sample.audio_sha256);
    validateVoiceWav(audio);
    for (const pipeline of ['direct-wav-api', 'browser-recorded-api']) {
      const before = (await metrics()).length;
      let body: ApiBody;
      let status: number;
      let seconds: number;
      let uploadedDuration = sample.duration;
      if (pipeline === 'direct-wav-api') {
        const started = performance.now();
        const response = await api.post('/api/voice', {
          headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local',
            'x-voice-request-id': randomUUID() },
          data: audio, timeout: 130_000,
        });
        seconds = (performance.now() - started) / 1000;
        body = await response.json() as ApiBody;
        status = response.status();
      } else {
        await page.locator('textarea.composerTextarea').fill('');
        await page.evaluate(base64 => {
          const state = window as CaptureWindow;
          state.__corpusAudio = base64;
          state.__corpusUpload = undefined;
          state.__corpusPlay = undefined;
        }, audio.toString('base64'));
        const responsePromise = page.waitForResponse(response =>
          response.url().endsWith('/api/voice') && response.request().method() === 'POST', { timeout: 170_000 });
        await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
        await page.evaluate(() => {
          const play = (window as CaptureWindow).__corpusPlay;
          if (!play) throw new Error('Corpus stream was not connected');
          play();
        });
        await page.waitForTimeout(sample.duration * 1000 + 100);
        const stop = page.getByRole('button', { name: 'Stop recording', exact: true });
        if (await stop.isVisible()) await stop.click();
        const response = await responsePromise;
        body = await response.json() as ApiBody;
        status = response.status();
        const capture = await page.evaluate(() => {
          const state = window as CaptureWindow;
          if (!state.__corpusUpload) throw new Error('Browser did not upload recorded audio');
          return { ...state.__corpusUpload, ended: performance.now() };
        });
        seconds = (capture.ended - capture.started) / 1000;
        const bytes = Buffer.from(capture.base64, 'base64');
        uploadedDuration = validateVoiceWav(bytes).durationSeconds;
        await writeFile(`chain-evidence/captured/${sample.id}.wav`, bytes);
        await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toBeEnabled();
        if (status === 200) await expect(page.locator('textarea.composerTextarea')).toHaveValue(body.text!);
        else await expect(page.locator('textarea.composerTextarea')).toHaveValue('');
      }
      expect([200, 422, 502, 503, 504]).toContain(status);
      if (status === 200) {
        expect(body.ok).toBe(true);
        expect(typeof body.text).toBe('string');
        expect(body.text?.length).toBeGreaterThan(0);
      } else {
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe('string');
      }
      const after = await metrics();
      expect(after.length - before).toBeLessThanOrEqual(1);
      await appendFile('chain-evidence/results.jsonl', JSON.stringify({
        id: sample.id, pipeline, text: body.text ?? null, status, error: body.error ?? null,
        seconds, uploaded_duration: uploadedDuration,
        peak_rss_kib: after.length > before ? after[after.length - 1].peak_rss_kib : null,
      }) + '\n');
      console.log(`${sample.id} ${pipeline} status=${status} seconds=${seconds.toFixed(2)}`);
    }
  }
});
