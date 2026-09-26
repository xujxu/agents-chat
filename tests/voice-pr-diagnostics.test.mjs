import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { boundedEvents, directorySnapshot, saveDiagnosticReport, recordVoiceLifecycle } from './helpers/voiceLifecycleDiagnostics.mjs';

test('lifecycle-only recorder records context without a filesystem watcher', () => {
  let phase = 'tests';
  const recorder = recordVoiceLifecycle(() => ({ phase, round: 1 }));
  recorder.record('server-ready', { pid: 123 });
  phase = 'stopping';
  recorder.record('server-stop-request');
  const report = recorder.snapshot();
  assert.equal(report.collection, 'lifecycle-only-no-filesystem-watcher');
  assert.deepEqual(report.events.map(event => event.phase), ['tests', 'stopping']);
  assert.equal(report.events[0].pid, 123);
  assert.ok(report.events.every(event => Number.isFinite(Date.parse(event.observedAt))));
  for (let index = 0; index < 4096; index++) recorder.record('extra');
  assert.equal(recorder.snapshot().events.length, 4096);
  assert.equal(recorder.snapshot().dropped, 2);
});

test('event history retains its bound and reports lost events', () => {
  const buffer = boundedEvents(2);
  for (let index = 0; index < 5; index++) buffer.push({ index });
  assert.deepEqual(buffer.snapshot(), { events: [{ index: 0 }, { index: 1 }], dropped: 3 });
  assert.throws(() => boundedEvents(0));
});

test('directory snapshot is bounded metadata only and never follows links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-diagnostic-contract-'));
  try {
    const directory = path.join(root, 'agents-chat-voice-a');
    await mkdir(directory);
    for (let index = 0; index < 22; index++) await writeFile(path.join(directory, `file-${index}`), 'DO_NOT_CAPTURE_CONTENT');
    await mkdir(path.join(root, 'outside'));
    await writeFile(path.join(root, 'outside', 'secret'), 'DO_NOT_CAPTURE_CONTENT');
    await symlink(path.join(root, 'outside'), path.join(root, 'agents-chat-voice-b'), 'dir');
    const report = await directorySnapshot(root);
    assert.equal(report.count, 2);
    assert.equal(report.directories[0].memberCount, 22);
    assert.equal(report.directories[0].files.length, 20);
    assert.equal(report.directories[1].symlink, true);
    assert.deepEqual(report.directories[1].files, []);
    assert.ok(!JSON.stringify(report).includes('DO_NOT_CAPTURE_CONTENT'));
    for (let index = 0; index < 65; index++) await mkdir(path.join(root, `agents-chat-voice-extra-${index}`));
    const bounded = await directorySnapshot(root);
    assert.equal(bounded.count, 67);
    assert.equal(bounded.directories.length, 64);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing root is an explicit capture error, not a clean snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-diagnostic-contract-'));
  await rm(root, { recursive: true });
  await assert.rejects(directorySnapshot(root), { code: 'ENOENT' });
});

test('failure reports preserve original failure and capture errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-diagnostic-contract-'));
  try {
    const file = path.join(root, 'failure.json');
    const report = { status: 'failed', error: 'whisper leaked request directories',
      captureErrors: [{ code: 'EACCES' }], completedRounds: 0 };
    await saveDiagnosticReport(file, report);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), report);
    await assert.rejects(saveDiagnosticReport(path.join(root, 'missing', 'failure.json'), report), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
