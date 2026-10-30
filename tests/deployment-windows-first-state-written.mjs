import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export function firstStateWrittenOriginalState(control, previous) {
  return readFile(path.join(control, previous.stateIntent.path))
    .then(bytes => Buffer.from(JSON.parse(bytes).oldState));
}

export async function assertFirstStateWrittenAfterDeath({
  source, control, pwsh, admission, api, options, previous, state, completionFile,
}) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { acquireLock, releaseLock } = await load('state.mjs');
  assert.equal(previous.stage, 'StateWritten');
  assert.notEqual(await processIdentity(process.pid), previous.actorIdentity);
  assert.notEqual(await processIdentity(previous.actorPid), previous.actorIdentity);
  assert.notEqual(await processIdentity(previous.pid), previous.processIdentity);
  const snapshots = [];
  const capture = async descriptor => {
    const file = path.join(control, descriptor.path);
    const bytes = await readFile(file);
    const identity = await lstat(file, { bigint: true });
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    assert.equal(identity.dev.toString(), descriptor.dev);
    assert.equal(identity.ino.toString(), descriptor.ino);
    const snapshot = { file, bytes, identity };
    snapshots.push(snapshot);
    return snapshot;
  };
  const prepared = JSON.parse((await capture(previous.prepared)).bytes);
  assert.equal(prepared.oldState, state.toString('utf8'));
  assert.equal(prepared.newOwner.pid, previous.actorPid);
  assert.deepEqual(JSON.parse((await capture(previous.owner)).bytes), prepared.newOwner);
  const committed = JSON.parse((await capture(previous.committed)).bytes);
  assert.equal(committed.phase, 'stopped-history-handoff-committed');
  assert.equal(previous.stateIntent.path, `inactive-handoff-${previous.attemptId}-state-intent.json`);
  const intent = JSON.parse((await capture(previous.stateIntent)).bytes);
  assert.equal(intent.phase, 'stopped-history-handoff-state-intent');
  assert.equal(intent.attemptId, previous.attemptId);
  assert.deepEqual(intent.prepared, previous.prepared);
  assert.deepEqual(intent.committed, previous.committed);
  assert.equal(intent.oldState, state.toString('utf8'));
  assert.deepEqual(intent.creator, { pid: previous.actorPid, processIdentity: previous.actorIdentity,
    bridgePid: previous.pid, bridgeIdentity: previous.processIdentity });
  assert.equal(previous.state.path, 'state.json');
  const stateFile = path.join(control, 'state.json');
  const written = await capture(previous.state);
  assert.equal(written.bytes.at(-1), 0x0a);
  assert.deepEqual(JSON.parse(written.bytes), intent.nextState);
  assert.equal(intent.nextState.phase, 'preflight');
  assert.equal(intent.nextState.operationId, prepared.newOwner.operationId);
  assert.notEqual(written.identity.ino.toString(), prepared.state.ino);
  assert.deepEqual((await readdir(control)).filter(name => name.startsWith('state.json.lock')), []);
  const lockDirectory = path.join(control, 'lock');
  const directory = await lstat(lockDirectory, { bigint: true });
  assert.deepEqual(previous.lockIdentity, { dev: directory.dev.toString(), ino: directory.ino.toString() });
  const request = JSON.stringify({
    attemptId: previous.attemptId, prepared: previous.prepared, committed: previous.committed,
    stateIntent: previous.stateIntent, state: previous.state,
  });
  const observe = async () => promisify(execFile)(pwsh, [
    '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./deployment-windows-history-handoff-state-observation.ps1', import.meta.url)),
    '-Source', source, '-Control', control, '-ControllerPid', String(process.pid),
    '-ControllerIdentity', await processIdentity(process.pid), '-Request', request,
  ], { timeout: 45000, maxBuffer: 131072, windowsHide: true });
  const native = await observe();
  assert.equal(native.stderr, '');
  const { observed, refusals } = JSON.parse(native.stdout);
  assert.deepEqual(Object.keys(observed).sort(), [
    'status', 'attemptId', 'previousOperationId', 'project', 'prepared', 'committed', 'stateIntent', 'state',
    'lockIdentity', 'lock', 'runtimeAuthority', 'lockAuthority', 'taskAuthority',
  ].sort());
  assert.equal(observed.status, 'committed-handoff-state-observed');
  assert.equal(observed.attemptId, previous.attemptId);
  assert.equal(observed.previousOperationId, prepared.previousOperationId);
  assert.equal(observed.project, prepared.project);
  for (const name of ['prepared', 'committed', 'stateIntent', 'state', 'lockIdentity']) {
    assert.deepEqual(observed[name], previous[name]);
  }
  assert.deepEqual(observed.lock, previous.owner);
  assert.equal(observed.runtimeAuthority, false);
  assert.equal(observed.lockAuthority, false);
  assert.equal(observed.taskAuthority, false);
  assert.deepEqual(Object.keys(refusals).sort(), ['intent', 'write']);
  const held = path.join(control, 'fixture-handoff-written-state.json');
  await rename(stateFile, held);
  let replacement;
  try {
    await writeFile(stateFile, written.bytes, { flag: 'wx' });
    replacement = await lstat(stateFile, { bigint: true });
    assert.notEqual(replacement.ino, written.identity.ino);
    await assert.rejects(observe(), error => error.message.includes('Handoff state observation failed; retain evidence.'));
  } finally {
    if (replacement) await unlink(stateFile);
    await rename(held, stateFile);
  }
  await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
  await assert.rejects(acquireLock(control, { ...options, project: prepared.project, operationId: randomUUID() }));
  await assert.rejects(releaseLock(control, prepared.newOwner, { pwsh, admission }));
  for (const snapshot of snapshots) {
    assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
    const current = await lstat(snapshot.file, { bigint: true });
    assert.equal(current.dev, snapshot.identity.dev);
    assert.equal(current.ino, snapshot.identity.ino);
  }
  assert.equal(createHash('sha256').update(await readFile(completionFile)).digest('hex'), previous.completionSha256);
  // The fixture restores the original state bytes in place so the shared archive continuation can proceed.
  await writeFile(stateFile, state);
  await unlink(path.join(control, previous.stateIntent.path));
  await unlink(path.join(control, previous.committed.path));
  await unlink(path.join(control, previous.owner.path));
  await rmdir(lockDirectory);
  await unlink(path.join(control, previous.prepared.path));
  assert.deepEqual(await readFile(stateFile), state);
  console.log('PASS: actual first-attempt state writer death preserves the exact written preflight transition for a distinct observer without lock runtime or admission authority');
}
