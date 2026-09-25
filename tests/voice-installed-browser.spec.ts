import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { devices, errors, expect, test, type Page } from '@playwright/test';
import { browserEvidenceDirectory, selectBrowserCase } from '../scripts/voice/browser-cases';
import { validateVoiceWav, VoiceError } from '../lib/voice/audio';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { armBrowserCapture, installBrowserCapture, playBrowserCapture, snapshotBrowserCapture,
  type BrowserCaptureSnapshot } from './helpers/voiceBrowserCapture';

type Sample = { id: string; reference: string; category: string; dataset: string; duration: number;
  split: string; audio_sha256: string };
type Attempt = Sample & {
  caseId?: string;
  platform: string; pipeline: 'direct' | 'browser'; text: string | null; apiText: string | null;
  failure: string | null; seconds: number | null; status: number | null; apiElapsedMs: number | null;
  uploadedAudioSha256: string | null; uploadedDuration: number | null;
  timing: BrowserCaptureSnapshot['timing'] | null; capture: BrowserCaptureSnapshot['capture'] | null;
};
const caseId = process.env.INSTALLED_BROWSER_CASE;
const selectedCase = caseId === undefined ? undefined : selectBrowserCase(caseId);
const evidence = browserEvidenceDirectory(caseId);
type ResponseBody = { ok: true; text: string; elapsedMs: number } | { ok: false; error: string };
function bodyOf(value: unknown, status: number): ResponseBody {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw new Error('Invalid voice response object');
  if (status === 200 && value.ok === true && 'text' in value && typeof value.text === 'string'
    && 'elapsedMs' in value && typeof value.elapsedMs === 'number' && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) {
    return { ok: true, text: value.text, elapsedMs: value.elapsedMs };
  }
  if ([422, 500, 502, 503, 504].includes(status) && value.ok === false
    && 'error' in value && typeof value.error === 'string' && value.error) return { ok: false, error: value.error };
  throw new Error('Unexpected voice status or response fields');
}
function initial(sample: Sample, pipeline: Attempt['pipeline']): Attempt {
  return { ...sample, ...(selectedCase ? { caseId } : {}), platform: process.platform, pipeline, text: null, apiText: null, failure: null,
    seconds: null, status: null, apiElapsedMs: null, uploadedAudioSha256: null, uploadedDuration: null,
    timing: null, capture: null };
}
function applyResponse(row: Attempt, value: unknown, status: number) {
  row.status = status;
  const body = bodyOf(value, status);
  if (!body.ok) row.failure ??= body.error;
  else {
    row.apiText = body.text;
    row.apiElapsedMs = body.elapsedMs;
    if (!body.text.trim() || body.text.includes('\0')) row.failure = 'empty_or_invalid_transcript';
    else row.text = body.text;
  }
}

async function direct(page: Page, sample: Sample, audio: Buffer): Promise<Attempt> {
  const row = initial(sample, 'direct');
  row.uploadedAudioSha256 = sample.audio_sha256;
  row.uploadedDuration = sample.duration;
  const start = performance.now();
  let response;
  try {
    response = await page.context().request.post('/api/voice', {
      headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local', 'x-voice-request-id': randomUUID() },
      data: audio, timeout: 130000,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    row.failure = 'transport_error';
  }
  row.seconds = (performance.now() - start) / 1000;
  if (response) applyResponse(row, await response.json(), response.status());
  return row;
}

async function browser(page: Page, sample: Sample, audio: Buffer): Promise<Attempt> {
  const row = initial(sample, 'browser');
  await armBrowserCapture(page, audio.toString('base64'));
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  try {
    await page.waitForFunction(() => !!document.querySelector('button[aria-label="Stop recording"]')
      || !!document.querySelector('[role="alert"][aria-label="Voice input error"]'), undefined, { timeout: 15000 });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    row.failure = 'capture_setup_timeout';
  }
  const stop = page.getByRole('button', { name: 'Stop recording', exact: true });
  if (!row.failure && await stop.isVisible()) {
    await playBrowserCapture(page);
    await page.waitForTimeout(sample.duration * 1000 + 100);
    if (await stop.isVisible()) await stop.click();
    try {
      await page.waitForFunction(() => {
        const state = window.__installedVoiceCapture;
        const idle = document.querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]');
        return !!state && (state.observerError || state.fetchFailure
          || (state.timing.bodyAt !== null && idle && !idle.disabled
            && (state.timing.composerAt !== null || document.querySelector('[role="alert"][aria-label="Voice input error"]'))));
      }, undefined, { timeout: 135000 });
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      row.failure = 'browser_delivery_timeout';
    }
  } else {
    row.failure ??= 'capture_setup_failed';
  }
  const cancel = page.getByRole('button', { name: 'Cancel voice input', exact: true });
  if (await cancel.isVisible()) await cancel.click();
  await expect(page.getByRole('button', { name: 'Start voice input', exact: true })).toBeEnabled({ timeout: 10000 });
  await expect.poll(async () => {
    const capture = (await snapshotBrowserCapture(page)).capture;
    return capture.sourceRate === null || capture.contextClosed;
  }, { timeout: 10000 }).toBe(true);
  const snapshot = await snapshotBrowserCapture(page, true);
  if (snapshot.observerError) throw new Error(`Capture evidence incomplete: ${snapshot.observerError}`);
  row.timing = snapshot.timing;
  row.capture = snapshot.capture;
  if (snapshot.uploadBase64 !== null) {
    const bytes = Buffer.from(snapshot.uploadBase64, 'base64');
    await writeFile(`${evidence}/captured/${sample.id}.wav`, bytes);
    row.uploadedAudioSha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      row.uploadedDuration = validateVoiceWav(bytes).durationSeconds;
    } catch (error) {
      if (!(error instanceof VoiceError)) throw error;
      row.failure ??= 'invalid_captured_wav';
    }
  } else row.failure ??= 'missing_capture_upload';
  if (snapshot.status !== null) applyResponse(row, snapshot.body, snapshot.status);
  else row.failure ??= snapshot.fetchFailure ?? 'missing_api_response';
  if (!snapshot.capture.sourceCompleted) row.failure ??= 'capture_source_truncated';
  if (row.apiText && (snapshot.composerText !== row.apiText || snapshot.timing.composerAt === null)) {
    row.failure ??= 'ui_not_filled';
  }
  if (row.failure) row.text = null;
  const end = row.failure ? snapshot.timing.terminalAt : snapshot.timing.composerAt;
  row.seconds = snapshot.timing.stopAt !== null && end !== null ? (end - snapshot.timing.stopAt) / 1000 : null;
  return row;
}

test('installed Sense records frozen100 through actual paired browser and API paths', async ({ page, browserName, browser: instance }, testInfo) => {
  test.skip(process.env.INSTALLED_BROWSER_ACCEPTANCE !== '1', 'Actions-only installed browser corpus');
  test.setTimeout(4_500_000);
  const samples: Sample[] = JSON.parse(await readFile('corpus/samples.json', 'utf8'));
  expect(samples).toHaveLength(100);
  expect(new Set(samples.map(sample => sample.id)).size).toBe(100);
  await mkdir(`${evidence}/captured`, { recursive: true });
  await writeFile(`${evidence}/results.jsonl`, '');
  let caseMetadata = {};
  if (selectedCase) {
    expect(process.platform).toBe(selectedCase.platform);
    expect(testInfo.project.name).toBe(selectedCase.project);
    expect(browserName).toBe(selectedCase.browserName);
    expect(testInfo.project.use.channel ?? null).toBe(selectedCase.channel);
    const descriptor = devices[selectedCase.device];
    const requestedDeviceSettings = {
      viewport: descriptor.viewport, isMobile: descriptor.isMobile, hasTouch: descriptor.hasTouch,
      deviceScaleFactor: descriptor.deviceScaleFactor, userAgent: descriptor.userAgent,
    };
    const deviceSettings = {
      viewport: testInfo.project.use.viewport, isMobile: testInfo.project.use.isMobile,
      hasTouch: testInfo.project.use.hasTouch, deviceScaleFactor: testInfo.project.use.deviceScaleFactor,
      userAgent: testInfo.project.use.userAgent,
    };
    expect(deviceSettings).toEqual(requestedDeviceSettings);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const executable: unknown = selectedCase.channel === 'msedge'
      ? JSON.parse(await readFile(`${evidence}/edge-executable.json`, 'utf8')) : null;
    if (selectedCase.channel === 'msedge') expect(userAgent).toMatch(/\bEdg\/\d/);
    const playwrightPackage: unknown = JSON.parse(await readFile('node_modules/@playwright/test/package.json', 'utf8'));
    if (!playwrightPackage || typeof playwrightPackage !== 'object' || !('version' in playwrightPackage)
      || typeof playwrightPackage.version !== 'string') throw new Error('Missing Playwright version');
    caseMetadata = { ...selectedCase, caseId, deviceSettings, requestedDeviceSettings,
      executable, playwrightVersion: playwrightPackage.version };
    await writeFile(`${evidence}/source-manifest.json`, JSON.stringify({ caseId, samples }));
  }
  await installMobileChatFixture(page);
  await installBrowserCapture(page);
  await loginMobileFixture(page);
  expect(await (await page.context().request.get('/api/voice')).json()).toMatchObject({
    enabled: true, model: 'sensevoice-small-q8', resourcePolicy: 'standard', threads: 2,
  });
  await writeFile(`${evidence}/browser.json`, JSON.stringify({
    ...caseMetadata,
    browserName, version: instance.version(), userAgent: await page.evaluate(() => navigator.userAgent),
    sourceRate: 48000, composerObservation: 'requestAnimationFrame after actual value update',
    scope: 'Controlled public-corpus MediaStream; no physical microphone, AEC or actual Win11 claim.',
  }, null, 2));
  const uploads: { caseId: string | undefined; id: string; uploadedAudioSha256: string | null }[] = [];
  for (const sample of samples.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const audio = await readFile(`corpus/audio/${sample.id}.wav`);
    expect(createHash('sha256').update(audio).digest('hex')).toBe(sample.audio_sha256);
    expect(validateVoiceWav(audio).durationSeconds).toBeCloseTo(sample.duration, 6);
    for (const collect of [direct, browser]) {
      const row = await collect(page, sample, audio);
      await appendFile(`${evidence}/results.jsonl`, JSON.stringify(row) + '\n');
      if (row.pipeline === 'browser') uploads.push({ caseId, id: sample.id, uploadedAudioSha256: row.uploadedAudioSha256 });
      console.log(`${sample.id} ${row.pipeline} status=${row.status} failure=${row.failure} seconds=${row.seconds}`);
    }
  }
  if (selectedCase) await writeFile(`${evidence}/upload-manifest.json`, JSON.stringify({ caseId, uploads }));
  await writeFile(`${evidence}/complete.json`, JSON.stringify({
    ...(selectedCase ? { caseId, run: process.env.GITHUB_RUN_ID, commit: process.env.GITHUB_SHA } : {}),
    platform: process.platform, sources: 100, attempts: 200, model: 'sensevoice-small-q8',
  }));
});
