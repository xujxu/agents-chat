import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, lstat, rename, writeFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const descriptorArgs = (prefix, descriptor) => [
  `-${prefix}Dev`, descriptor.dev, `-${prefix}Ino`, descriptor.ino,
  `-${prefix}Bytes`, String(descriptor.bytes), `-${prefix}Sha256`, descriptor.sha256,
];
const fixtureArgs = ({ source, control, identity, previous }) => [
  '-NoProfile', '-NonInteractive', '-File',
  fileURLToPath(new URL('./deployment-windows-history-handoff-committed-observation.ps1', import.meta.url)),
  '-Source', source, '-Control', control, '-ControllerPid', String(process.pid),
  '-ControllerIdentity', identity, '-AttemptId', previous.attemptId,
  ...descriptorArgs('Prepared', previous.prepared), ...descriptorArgs('Committed', previous.committed),
];

export async function holdLockRetirementIntent({ source, control, pwsh, previous }) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
  const { captureWorkerFields } = await load('worker-identity.mjs');
  const identity = await processIdentity(process.pid);
  const transport = windowsControllerTransport({
    pwsh, label: 'Held native lock retirement intent fixture',
    refused: cause => new Error('Held native lock retirement intent fixture failed.', { cause }),
    args: [...fixtureArgs({ source, control, identity, previous }), '-PrepareRetirement', '-Hold'],
  });
  let ready;
  try {
    ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held lock retirement');
    assert.equal(ready.type, 'ready');
    assert.equal(ready.pid, transport.child.pid);
    assert.equal(ready.processIdentity, await processIdentity(ready.pid));
    assert.equal(ready.control, control);
    assert.equal(ready.controllerIdentity, identity);
    assert.equal(ready.value.path, `inactive-handoff-${previous.attemptId}-lock-retirement.json`);
  } catch (cause) { throw await transport.abandon(cause); }
  console.log(`INACTIVE_HISTORY_LOCK_RETIREMENT_HELD ${JSON.stringify({
    ...previous, originalActor: previous, actorPid: process.pid, actorIdentity: identity,
    pid: ready.pid, processIdentity: ready.processIdentity, retirement: ready.value,
  })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
}

export async function assertLockRetirementIntentAfterDeath({ source, control, pwsh, admission, previous, state, completionBytes }) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const original = previous.originalActor;
  assert.equal(previous.stage, 'Committed');
  assert.equal(original.stage, 'Committed');
  for (const actor of [original, previous]) {
    assert.notEqual(await processIdentity(process.pid), actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.pid), actor.processIdentity);
  }
  assert.notEqual(original.actorIdentity, previous.actorIdentity);
  assert.deepEqual(previous.prepared, original.prepared);
  assert.deepEqual(previous.committed, original.committed);
  assert.deepEqual(previous.owner, original.owner);
  assert.deepEqual(previous.lockIdentity, original.lockIdentity);
  assert.equal(previous.prepared.path, `inactive-handoff-${previous.attemptId}-prepared.json`);
  assert.equal(previous.committed.path, `inactive-handoff-${previous.attemptId}-committed.json`);
  assert.equal(previous.retirement.path, `inactive-handoff-${previous.attemptId}-lock-retirement.json`);
  assert.equal(previous.owner.path, 'lock\\owner.json');
  const snapshots = [];
  for (const descriptor of [previous.prepared, previous.committed, previous.owner, previous.retirement]) {
    const file = path.join(control, descriptor.path);
    const bytes = await readFile(file);
    const identity = await lstat(file, { bigint: true });
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    assert.equal(identity.dev.toString(), descriptor.dev);
    assert.equal(identity.ino.toString(), descriptor.ino);
    snapshots.push({ file, bytes, identity });
  }
  const [prepared, committed, owner, retirement] = snapshots.map(snapshot => JSON.parse(snapshot.bytes));
  assert.equal(prepared.oldState, state.toString('utf8'));
  assert.equal(prepared.newOwner.pid, original.actorPid);
  assert.equal(prepared.newOwner.processIdentity, original.actorIdentity);
  assert.deepEqual(owner, prepared.newOwner);
  assert.equal(committed.phase, 'stopped-history-handoff-committed');
  assert.equal(committed.attemptId, previous.attemptId);
  assert.equal(committed.control, control);
  assert.equal(committed.project, prepared.project);
  assert.deepEqual(committed.controlIdentity, prepared.controlIdentity);
  assert.equal(committed.previousOperationId, prepared.previousOperationId);
  assert.deepEqual(committed.prepared, previous.prepared);
  assert.deepEqual(committed.newOwner, owner);
  assert.deepEqual(committed.lock, previous.owner);
  assert.deepEqual(committed.lockIdentity, previous.lockIdentity);
  assert.deepEqual(committed.creator, { pid: original.actorPid, processIdentity: original.actorIdentity,
    bridgePid: original.pid, bridgeIdentity: original.processIdentity });
  assert.deepEqual(Object.keys(retirement).sort(), [
    'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
    'prepared', 'committed', 'newOwner', 'lockIdentity', 'lock', 'creator', 'createdAt',
  ].sort());
  assert.equal(retirement.version, 1);
  assert.equal(retirement.phase, 'stopped-history-handoff-lock-retirement-prepared');
  assert.equal(retirement.attemptId, previous.attemptId);
  assert.equal(retirement.control, control);
  assert.equal(retirement.project, prepared.project);
  assert.deepEqual(retirement.controlIdentity, prepared.controlIdentity);
  assert.equal(retirement.previousOperationId, prepared.previousOperationId);
  assert.deepEqual(retirement.prepared, previous.prepared);
  assert.deepEqual(retirement.committed, previous.committed);
  assert.deepEqual(retirement.newOwner, owner);
  assert.deepEqual(retirement.lockIdentity, previous.lockIdentity);
  assert.deepEqual(retirement.lock, previous.owner);
  assert.deepEqual(retirement.creator, { pid: previous.actorPid, processIdentity: previous.actorIdentity,
    bridgePid: previous.pid, bridgeIdentity: previous.processIdentity });
  assert.match(retirement.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(retirement.createdAt) >= Date.parse(committed.committedAt));
  const directory = path.join(control, 'lock');
  const directoryIdentity = await lstat(directory, { bigint: true });
  assert.ok(directoryIdentity.isDirectory());
  assert.deepEqual(previous.lockIdentity,
    { dev: directoryIdentity.dev.toString(), ino: directoryIdentity.ino.toString() });
  assert.deepEqual(await readdir(directory), ['owner.json']);
  const completionFile = path.join(control, `retired-${prepared.previousOperationId}-inactive-rollback-history-complete.json`);
  const completionIdentity = await lstat(completionFile, { bigint: true });
  const baseArgs = fixtureArgs({ source, control, identity: await processIdentity(process.pid), previous });
  const observeArgs = [...baseArgs, '-ObserveRetirement',
    '-RetirementDev', previous.retirement.dev, '-RetirementBytes', String(previous.retirement.bytes),
    '-RetirementSha256', previous.retirement.sha256];
  const observe = ino => promisify(execFile)(pwsh, [...observeArgs, '-RetirementIno', ino],
    { timeout: 45000, maxBuffer: 131072, windowsHide: true });
  const native = await observe(previous.retirement.ino);
  assert.equal(native.stderr, '');
  const observed = JSON.parse(native.stdout);
  assert.deepEqual(Object.keys(observed).sort(), [
    'status', 'attemptId', 'previousOperationId', 'project', 'prepared', 'committed', 'retirement',
    'lockIdentity', 'lock', 'runtimeAuthority', 'lockAuthority',
  ].sort());
  assert.equal(observed.status, 'lock-retirement-observed');
  assert.equal(observed.attemptId, previous.attemptId);
  assert.equal(observed.previousOperationId, prepared.previousOperationId);
  assert.equal(observed.project, prepared.project);
  assert.deepEqual(observed.prepared, previous.prepared);
  assert.deepEqual(observed.committed, previous.committed);
  assert.deepEqual(observed.retirement, previous.retirement);
  assert.deepEqual(observed.lockIdentity, previous.lockIdentity);
  assert.deepEqual(observed.lock, previous.owner);
  assert.equal(observed.runtimeAuthority, false);
  assert.equal(observed.lockAuthority, false);
  await assert.rejects(observe(previous.retirement.ino === '1' ? '2' : '1'),
    error => error.message.includes('Lock retirement observation failed; retain evidence.'));
  const ownerFile = snapshots[2].file;
  const heldOwner = path.join(control, 'fixture-retirement-original-owner.json');
  await rename(ownerFile, heldOwner);
  let replacement;
  try {
    await writeFile(ownerFile, snapshots[2].bytes, { flag: 'wx' });
    replacement = await lstat(ownerFile, { bigint: true });
    assert.notEqual(replacement.ino, snapshots[2].identity.ino);
    await assert.rejects(observe(previous.retirement.ino),
      error => error.message.includes('Lock retirement observation failed; retain evidence.'));
    assert.deepEqual(await readFile(ownerFile), snapshots[2].bytes);
  } finally {
    if (replacement) {
      const current = await lstat(ownerFile, { bigint: true });
      assert.equal(current.dev, replacement.dev);
      assert.equal(current.ino, replacement.ino);
      assert.deepEqual(await readFile(ownerFile), snapshots[2].bytes);
      await unlink(ownerFile);
    }
    await rename(heldOwner, ownerFile);
  }
  await assert.rejects(promisify(execFile)(pwsh, baseArgs,
    { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
  error => error.message.includes('Committed handoff observation failed; retain evidence.'));
  const api = await load('windows-task-completion-recovery.mjs');
  const { acquireLock, releaseLock } = await load('state.mjs');
  await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive({ control, pwsh, admission }));
  await assert.rejects(acquireLock(control, { pwsh, admission, project: prepared.project, operationId: randomUUID() }));
  await assert.rejects(releaseLock(control, owner, { pwsh, admission }));
  for (const snapshot of snapshots) {
    assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
    const current = await lstat(snapshot.file, { bigint: true });
    assert.equal(current.dev, snapshot.identity.dev);
    assert.equal(current.ino, snapshot.identity.ino);
  }
  const currentDirectory = await lstat(directory, { bigint: true });
  assert.equal(currentDirectory.dev, directoryIdentity.dev);
  assert.equal(currentDirectory.ino, directoryIdentity.ino);
  assert.deepEqual(await readdir(directory), ['owner.json']);
  assert.deepEqual((await readdir(control)).filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort(),
    [previous.prepared.path, previous.committed.path, previous.retirement.path].sort());
  assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
  assert.deepEqual(await readFile(completionFile), completionBytes);
  assert.equal(createHash('sha256').update(completionBytes).digest('hex'), previous.completionSha256);
  const completionAfter = await lstat(completionFile, { bigint: true });
  assert.equal(completionAfter.dev, completionIdentity.dev);
  assert.equal(completionAfter.ino, completionIdentity.ino);
  await unlink(snapshots[3].file);
  await unlink(snapshots[1].file);
  await unlink(ownerFile);
  await rmdir(directory);
  await unlink(snapshots[0].file);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
  console.log('PASS: actual lock retirement intent publisher death preserves exact evidence for a distinct third actor without cleanup authority');
  console.log('PASS: native retired lock intent observation revalidates exact creator death and unchanged committed lock without mutation');
}
