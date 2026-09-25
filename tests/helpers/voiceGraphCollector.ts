import { expect, type Page, type TestInfo } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { installMobileChatFixture, loginMobileFixture } from './mobileChatFixture';
import { armBrowserCapture, installBrowserCapture, playBrowserCapture, snapshotBrowserCapture } from './voiceBrowserCapture';
import { graphSnapshot, installGraphProbe } from './voiceGraphProbe';
import { graphWav, type GraphMode, type GraphStimulus } from './voiceGraphStimuli';

const text = 'Synthetic graph fixture; no ASR';
export const graphFiles = [
  'tests/helpers/voiceGraphStimuli.ts', 'tests/helpers/voiceGraphProbe.ts',
  'tests/helpers/voiceGraphCollector.ts', 'tests/helpers/voiceBrowserCapture.ts',
  'tests/voice-audio-graph.spec.ts', 'tests/playwright.voice-graph.config.ts',
  'app/features/composer/voice/voiceRecorder.ts', 'public/voice/recorder-worklet.js',
  'lib/voice/audio.ts', 'scripts/voice_graph_metrics.py', 'scripts/voice_graph_evidence.py',
  'scripts/voice_graph_report.py',
];
export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type FileEntry = { file: string; sha256: string; samples?: number };
type SavedStage = { rate: number; channels: FileEntry[] };

export async function collectGraph(page: Page, info: TestInfo, stimulus: GraphStimulus,
  repeat: number, mode: GraphMode, measured: boolean) {
  const id = `${info.project.name}/${stimulus}/${repeat}/${mode}`;
  const root = measured ? 'graph-evidence' : 'graph-contract-evidence';
  const relative = id;
  const directory = join(root, relative);
  mkdirSync(directory, { recursive: true });
  const save = (name: string, bytes: Buffer, samples?: number): FileEntry => {
    writeFileSync(join(directory, name), bytes, { flag: 'wx' });
    return { file: `${relative}/${name}`, sha256: hash(bytes), ...(samples === undefined ? {} : { samples }) };
  };
  const source = graphWav(stimulus);
  const row: Record<string, unknown> = {
    id, project: info.project.name, stimulus, repeat, mode,
    run: process.env.GITHUB_RUN_ID, commit: process.env.GITHUB_SHA,
    A: save('source.wav', source), error: null, probe: null,
    environment: {
      browser: page.context().browser()?.version(), descriptor: info.project.use,
      host: { platform: os.platform(), release: os.release(), arch: os.arch(),
        cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memory: os.totalmem() },
      playwright: JSON.parse(readFileSync('node_modules/@playwright/test/package.json', 'utf8')).version,
      implementation: Object.fromEntries(graphFiles.map(file => [file, hash(readFileSync(file))])),
    },
  };
  let received: Buffer | null = null;
  let receiverFailure: string | null = null;
  let requests = 0;
  const server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011').origin);
    response.setHeader('access-control-allow-credentials', 'true');
    response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type, x-voice-user-id, x-voice-request-id');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    requests++;
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 960044) chunks.push(chunk);
    });
    request.on('error', error => { receiverFailure = error.message; response.destroy(error); });
    request.on('end', () => {
      if (request.method !== 'POST' || size > 960044 || requests !== 1) {
        receiverFailure = 'invalid_receiver_request';
        response.writeHead(400).end(); return;
      }
      received = Buffer.concat(chunks);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, text, elapsedMs: 0 }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Receiver did not bind');
    await installMobileChatFixture(page);
    await installBrowserCapture(page);
    await page.route('**/api/voice', route => route.request().method() === 'POST'
      ? route.continue({ url: `http://127.0.0.1:${address.port}/upload` })
      : route.fulfill({ json: { ok: true, enabled: true, model: 'sensevoice-small-q8', threads: 2, resourcePolicy: 'standard' } }));
    await loginMobileFixture(page);
    if (mode === 'full') await installGraphProbe(page);
    await armBrowserCapture(page, source.toString('base64'));
    await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
    await playBrowserCapture(page);
    await page.waitForTimeout(8100);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(page.locator('textarea.composerTextarea')).toHaveValue(text);
    await expect.poll(async () => (await snapshotBrowserCapture(page)).capture.contextClosed).toBe(true);
    await expect.poll(async () => (await snapshotBrowserCapture(page)).timing.composerAt).not.toBeNull();
    const snapshot = await snapshotBrowserCapture(page, true);
    if (!snapshot.uploadBase64 || !received) throw new Error('Missing upload bytes');
    const upload = Buffer.from(snapshot.uploadBase64, 'base64');
    row.F = save('upload.wav', upload);
    row.received = save('received.wav', received);
    const { uploadBase64: _upload, ...metadata } = snapshot;
    row.snapshot = metadata;
    const probe = await graphSnapshot(page);
    if (probe) {
      const { stages, ...metadata } = probe;
      row.probe = metadata;
      for (const key of ['B', 'C', 'D', 'E'] as const) {
        const stage = stages[key];
        if (!stage) throw new Error(`Missing stage ${key}`);
        const saved: SavedStage = { rate: stage.rate, channels: stage.channels.map((base64, channel) => {
          const bytes = Buffer.from(base64, 'base64');
          return save(`${key}-${channel}.f32`, bytes, bytes.length / 4);
        }) };
        row[key] = saved;
      }
      expect(probe.errors).toEqual([]);
      expect(probe.recorderClosed).toBe(true);
      expect(probe.terminals).toEqual(['finished']);
    }
    expect(receiverFailure).toBeNull();
    expect(requests).toBe(1);
    expect(upload.equals(received)).toBe(true);
    expect(snapshot.observerError).toBeNull();
    expect(snapshot.fetchFailure).toBeNull();
    expect(snapshot.capture.sourceCompleted).toBe(true);
    expect(snapshot.capture.tracksStopped).toBe(true);
    return row;
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    row.receiver = { requests, error: receiverFailure };
    writeFileSync(join(directory, 'attempt.json'), JSON.stringify(row, null, 2));
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
