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
  captureWorkerFields, enterPhase,
}) {
  enterPhase('host-release-command');
  console.log(`INACTIVE_HISTORY_RESTART_COMMITTED_LIVE ${JSON.stringify({
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid,
    processIdentity: ready.processIdentity, prepared, directory, owner, committed,
  })}`);
  const command = captureWorkerFields(await controllerWire.receive({ timeoutMs: 45000 }),
    ['type'], 'restart release controller command');
  assert.equal(command.type, 'release-restart');
  enterPhase('restart-release-publication');
  await transport.wire.send({ type: 'release-restart' });
  await assertRestartPublicationProofs({
    publication: 'release', transport, ready, control, identity, captureWorkerFields, enterPhase,
  });
  const result = captureWorkerFields(await transport.wire.receive({ timeoutMs: 45000 }),
    ['status', 'attemptId', 'prepared', 'committed', 'retirement', 'released', 'state',
      'runtimeAuthority', 'lockAuthority', 'taskAuthority'],
    'restart release');
  const retirementDescriptor = captureWorkerFields(result.retirement,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart release retirement descriptor');
  const releasedDescriptor = captureWorkerFields(result.released,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart released descriptor');
  assert.deepEqual(result, {
    status: 'restart-released', attemptId: record.attemptId, prepared, committed,
    retirement: retirementDescriptor, released: releasedDescriptor, state: original.state,
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
    lockIdentity: directory, lock: owner, state: original.state, creator,
  };
  const { createdAt } = retirement.value;
  assert.equal(new Date(createdAt).toISOString(), createdAt);
  assert.ok(createdAt >= committedRecord.committedAt);
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
