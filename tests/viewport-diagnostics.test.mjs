import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  METRIC_KEYS, MAX_DIAGNOSTIC_BYTES, createViewportRecorder,
  parseDiagnosticMode, shouldPauseViewportSync, validateDiagnosticLog,
} from '../lib/viewportDiagnostics.ts';
import { readDiagnosticBody, storeViewportDiagnostic } from '../lib/viewportDiagnosticStore.ts';

function sample(t = 0, event = 'initial') {
  return {
    t, event, gesture: false, focus: 'none', orientation: 'portrait', mobile: true,
    metrics: Object.fromEntries(METRIC_KEYS.map(key => [key, key === 'scale' ? 1 : null])),
  };
}

function log() {
  return {
    version: 1, mode: 'baseline', browser: 'chrome', browserVersion: '153.0.8010.24',
    osVersion: '18.7.8', assets: ['/_next/static/chunks/test.css'],
    initial: sample(), samples: [], dropped: 0,
  };
}

test('only the explicit isolated mode pauses shell writes during zoom', () => {
  assert.equal(parseDiagnosticMode(null), null);
  assert.equal(parseDiagnosticMode('unknown'), null);
  assert.equal(parseDiagnosticMode('baseline'), 'baseline');
  assert.equal(parseDiagnosticMode('isolated'), 'isolated');
  for (const mode of [null, 'baseline']) {
    assert.equal(shouldPauseViewportSync(mode, true, 2), false);
  }
  assert.equal(shouldPauseViewportSync('isolated', true, 1), true);
  assert.equal(shouldPauseViewportSync('isolated', false, 2), true);
  assert.equal(shouldPauseViewportSync('isolated', false, 1), false);
  assert.equal(shouldPauseViewportSync('isolated', false, undefined), false);
});

test('strict diagnostic schema rejects unknown data and invalid metrics', () => {
  assert.equal(validateDiagnosticLog(log()), true);
  for (const invalid of [
    { ...log(), chat: 'private message' },
    { ...log(), mode: 'other' },
    { ...log(), browserVersion: 'arbitrary text' },
    { ...log(), assets: ['https://example.com/private?token=secret'] },
    { ...log(), initial: { ...sample(), t: 1 } },
    { ...log(), initial: { ...sample(), metrics: { ...sample().metrics, value: 'input text' } } },
    { ...log(), initial: { ...sample(), metrics: { ...sample().metrics, scale: Infinity } } },
    { ...log(), samples: [sample(20, 'resize'), sample(10, 'resize')] },
    { ...log(), samples: Array.from({ length: 257 }, (_, i) => sample(i, 'resize')) },
  ]) assert.equal(validateDiagnosticLog(invalid), false);
});

test('recorder retains initial state, bounded recent samples, and frozen snapshots', () => {
  const recorder = createViewportRecorder(log());
  for (let i = 1; i <= 300; i++) recorder.record(sample(i, 'resize'));
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.initial.t, 0);
  assert.equal(snapshot.samples.length, 256);
  assert.equal(snapshot.samples[0].t, 45);
  assert.equal(snapshot.dropped, 44);
  recorder.record(sample(301, 'settled'));
  assert.equal(snapshot.samples.at(-1).t, 300);
  assert.equal(validateDiagnosticLog(snapshot), true);
});

test('body reader enforces actual bytes even with a false Content-Length', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_DIAGNOSTIC_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const request = new Request('https://example.com', {
    method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Length': '1' },
  });
  await assert.rejects(readDiagnosticBody(request), error => error.status === 413);
  await assert.rejects(readDiagnosticBody(new Request('https://example.com', {
    method: 'POST', body: '{broken',
  })), error => error.status === 400);
  assert.deepEqual(await readDiagnosticBody(new Request('https://example.com', {
    method: 'POST', body: JSON.stringify(log()),
  })), log());
});

async function withRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'viewport-diagnostics-'));
  try {
    await mkdir(path.join(root, '.next'));
    await writeFile(path.join(root, '.next/BUILD_ID'), 'test-build');
    await run(root, path.join(root, '.data/tmp/viewport-diagnostics'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('store persists only private UUID logs with separate server identity', async () => {
  await withRoot(async (root, directory) => {
    const id = await storeViewportDiagnostic(log(), root);
    assert.match(id, /^[a-f0-9-]{36}$/);
    const file = path.join(directory, `${id}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(stored.log, log());
    assert.equal(stored.serverBuildId, 'test-build');
    assert.equal(typeof stored.receivedAt, 'string');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  });
});

test('store prunes only expired own files and rejects concurrent over-cap writes', async () => {
  await withRoot(async (root, directory) => {
    await storeViewportDiagnostic(log(), root);
    const expired = path.join(directory, `${randomUUID()}.json`);
    const unrelated = path.join(directory, 'keep.txt');
    await writeFile(expired, '{}');
    await writeFile(unrelated, 'keep');
    const old = new Date(Date.now() - 8 * 86400_000);
    await utimes(expired, old, old);
    await utimes(unrelated, old, old);
    await storeViewportDiagnostic(log(), root);
    assert.equal((await readdir(directory)).includes(path.basename(expired)), false);
    assert.equal(await readFile(unrelated, 'utf8'), 'keep');
    for (let i = 0; i < 97; i++) await writeFile(path.join(directory, `${randomUUID()}.json`), '{}');
    const results = await Promise.allSettled([
      storeViewportDiagnostic(log(), root), storeViewportDiagnostic(log(), root),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 507);
  });
});

test('store rejects symlink and non-directory destinations without following them', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'outside'));
    await symlink(path.join(root, 'outside'), path.join(root, '.data'));
    await assert.rejects(storeViewportDiagnostic(log(), root), /directory/i);
    assert.deepEqual(await readdir(path.join(root, 'outside')), []);
  });
  await withRoot(async root => {
    await writeFile(path.join(root, '.data'), 'not a directory');
    await assert.rejects(storeViewportDiagnostic(log(), root), /directory/i);
  });
});
