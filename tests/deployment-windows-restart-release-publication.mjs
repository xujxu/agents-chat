import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRestartPublicationProofs } from './deployment-windows-restart-publication-progress.mjs';

async function readRecord(control, descriptor, name) {
  assert.equal(descriptor.path, name);
  const file = path.join(control, name);
  const bytes = await readFile(file);
  const current = await lstat(file, { bigint: true });
  assert.ok(current.isFile());
  assert.equal(current.nlink, 1n);
  assert.equal(bytes.length, descriptor.bytes);
  assert.ok(bytes.length <= 65536);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
  assert.equal(current.dev.toString(), descriptor.dev);
  assert.equal(current.ino.toString(), descriptor.ino);
  return { file, bytes, identity: current, descriptor, value: JSON.parse(bytes) };
}

export async function assertRestartReleasePublication({
  control, identity, ready, original, record, prepared, committed, directory, owner, transport, controllerWire,
  captureWorkerFields, enterPhase, holdReleased = false, holdIntent = false, processIdentity, stateIntent, writtenState,
}) {
  assert.equal(stateIntent === undefined, writtenState === undefined);
  assert.ok(!holdIntent || !holdReleased);
  const written = writtenState ? { stateIntent, writtenState } : {};
  enterPhase('host-release-command');
  console.log(`${writtenState ? 'INACTIVE_HISTORY_RESTART_STATE_WRITTEN_LIVE' : 'INACTIVE_HISTORY_RESTART_COMMITTED_LIVE'} ${JSON.stringify({
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid,
    processIdentity: ready.processIdentity, prepared, directory, owner, committed, ...written,
  })}`);
  const command = captureWorkerFields(await controllerWire.receive({ timeoutMs: 45000 }),
    ['type'], 'restart release controller command');
  assert.equal(command.type, 'release-restart');
  enterPhase('restart-release-publication');
  await transport.wire.send({ type: 'release-restart' });
  await assertRestartPublicationProofs({
    publication: holdIntent ? 'release-intent' : 'release', transport, ready, control, identity, captureWorkerFields, enterPhase,
  });
  let response = await transport.wire.receive({ timeoutMs: 45000 });
  if (holdReleased || holdIntent) {
    const frame = captureWorkerFields(response,
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held restart release');
    assert.equal(frame.type, 'ready');
    assert.equal(frame.pid, ready.pid);
    assert.equal(frame.processIdentity, ready.processIdentity);
    assert.equal(frame.processIdentity, await processIdentity(frame.pid));
    assert.equal(frame.control, control);
    assert.equal(frame.controllerIdentity, identity);
    response = frame.value;
  }
  if (holdIntent) {
    return assertRestartReleaseIntent({
      control, identity, ready, original, record, prepared, committed, directory, owner, response, captureWorkerFields,
      stateIntent, writtenState,
    });
  }
  const result = captureWorkerFields(response,
    ['status', 'attemptId', 'prepared', 'committed', 'retirement', 'released', 'state',
      ...(writtenState ? ['stateIntent', 'writtenState'] : []), 'runtimeAuthority', 'lockAuthority', 'taskAuthority'],
    'restart release');
  const retirementDescriptor = captureWorkerFields(result.retirement,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart release retirement descriptor');
  const releasedDescriptor = captureWorkerFields(result.released,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart released descriptor');
  assert.deepEqual(result, {
    status: 'restart-released', attemptId: record.attemptId, prepared, committed,
    retirement: retirementDescriptor, released: releasedDescriptor, state: original.state, ...written,
    runtimeAuthority: false, lockAuthority: false, taskAuthority: false,
  });
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  const retirement = await readRecord(control, retirementDescriptor,
    `inactive-handoff-${record.attemptId}-lock-retirement.json`);
  const released = await readRecord(control, releasedDescriptor,
    `inactive-handoff-${record.attemptId}-lock-retired.json`);
  const committedRecord = JSON.parse(await readFile(path.join(control, committed.path)));
  const creator = {
    pid: process.pid, processIdentity: identity, bridgePid: ready.pid, bridgeIdentity: ready.processIdentity,
  };
  const binding = {
    attemptId: record.attemptId, control, project: original.project, controlIdentity: original.controlIdentity,
    previousOperationId: original.previousOperationId, prepared, committed, newOwner: record.newOwner,
    lockIdentity: directory, lock: owner, state: original.state, ...written, creator,
  };
  const { createdAt } = retirement.value;
  assert.equal(new Date(createdAt).toISOString(), createdAt);
  assert.ok(createdAt >= committedRecord.committedAt);
  if (writtenState) {
    const stateFile = path.join(control, 'state.json');
    const current = await lstat(stateFile, { bigint: true });
    assert.equal(current.dev.toString(), writtenState.dev);
    assert.equal(current.ino.toString(), writtenState.ino);
    assert.equal(createHash('sha256').update(await readFile(stateFile)).digest('hex'), writtenState.sha256);
    const intentRecord = JSON.parse(await readFile(path.join(control, stateIntent.path)));
    assert.ok(createdAt >= intentRecord.createdAt);
  }
  assert.deepEqual(retirement.value, {
    version: 1, phase: 'stopped-history-handoff-restart-release-prepared', ...binding, createdAt,
  });
  const { releasedAt } = released.value;
  assert.equal(new Date(releasedAt).toISOString(), releasedAt);
  assert.ok(releasedAt >= createdAt);
  assert.ok(releasedAt <= new Date().toISOString());
  assert.deepEqual(released.value, {
    version: 1, phase: 'stopped-history-handoff-restart-released', ...binding,
    retirement: retirementDescriptor, releasedAt,
  });
  return [retirement, released];
}

// The live releaser publishes its exact tenth record and still holds the committed lock it has not yet deleted.
async function assertRestartReleaseIntent({
  control, identity, ready, original, record, prepared, committed, directory, owner, response, captureWorkerFields,
  stateIntent, writtenState,
}) {
  const written = writtenState ? { stateIntent, writtenState } : {};
  const result = captureWorkerFields(response,
    ['status', 'attemptId', 'prepared', 'committed', 'retirement', 'lockIdentity', 'lock', 'state',
      ...(writtenState ? ['stateIntent', 'writtenState'] : []), 'runtimeAuthority', 'lockAuthority', 'taskAuthority'],
    'restart release intent');
  const retirementDescriptor = captureWorkerFields(result.retirement,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart release intent descriptor');
  assert.deepEqual(result, {
    status: 'restart-release-prepared', attemptId: record.attemptId, prepared, committed,
    retirement: retirementDescriptor, lockIdentity: directory, lock: owner, state: original.state, ...written,
    runtimeAuthority: false, lockAuthority: false, taskAuthority: false,
  });
  const lock = path.join(control, 'lock');
  const lockIdentity = await lstat(lock, { bigint: true });
  assert.ok(lockIdentity.isDirectory());
  assert.equal(lockIdentity.dev.toString(), directory.dev);
  assert.equal(lockIdentity.ino.toString(), directory.ino);
  const ownerBytes = await readFile(path.join(lock, 'owner.json'));
  assert.equal(createHash('sha256').update(ownerBytes).digest('hex'), owner.sha256);
  await assert.rejects(lstat(path.join(control, `inactive-handoff-${record.attemptId}-lock-retired.json`)),
    { code: 'ENOENT' });
  const retirement = await readRecord(control, retirementDescriptor,
    `inactive-handoff-${record.attemptId}-lock-retirement.json`);
  const committedRecord = JSON.parse(await readFile(path.join(control, committed.path)));
  const { createdAt } = retirement.value;
  assert.equal(new Date(createdAt).toISOString(), createdAt);
  assert.ok(createdAt >= committedRecord.committedAt);
  assert.ok(createdAt <= new Date().toISOString());
  if (writtenState) {
    const stateFile = path.join(control, 'state.json');
    const current = await lstat(stateFile, { bigint: true });
    assert.equal(current.dev.toString(), writtenState.dev);
    assert.equal(current.ino.toString(), writtenState.ino);
    assert.equal(createHash('sha256').update(await readFile(stateFile)).digest('hex'), writtenState.sha256);
    assert.ok(createdAt >= JSON.parse(await readFile(path.join(control, stateIntent.path))).createdAt);
  }
  assert.deepEqual(retirement.value, {
    version: 1, phase: 'stopped-history-handoff-restart-release-prepared',
    attemptId: record.attemptId, control, project: original.project, controlIdentity: original.controlIdentity,
    previousOperationId: original.previousOperationId, prepared, committed, newOwner: record.newOwner,
    lockIdentity: directory, lock: owner, state: original.state, ...written,
    creator: { pid: process.pid, processIdentity: identity, bridgePid: ready.pid, bridgeIdentity: ready.processIdentity },
    createdAt,
  });
  return [retirement];
}
