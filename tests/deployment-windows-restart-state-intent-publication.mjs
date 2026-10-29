import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRestartPublicationProofs } from './deployment-windows-restart-publication-progress.mjs';

export async function assertRestartStateIntentPublication({
  control, identity, ready, original, record, prepared, committed, directory, owner, transport, controllerWire,
  captureWorkerFields, enterPhase, validateState,
}) {
  enterPhase('host-state-intent-command');
  console.log(`INACTIVE_HISTORY_RESTART_COMMITTED_LIVE ${JSON.stringify({
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid,
    processIdentity: ready.processIdentity, prepared, directory, owner, committed,
  })}`);
  const command = captureWorkerFields(await controllerWire.receive({ timeoutMs: 45000 }),
    ['type'], 'restart state intent controller command');
  assert.equal(command.type, 'prepare-restart-state');
  enterPhase('restart-state-intent-publication');
  await transport.wire.send({ type: 'prepare-restart-state' });
  await assertRestartPublicationProofs({
    publication: 'state-intent', transport, ready, control, identity, captureWorkerFields, enterPhase,
  });
  const result = captureWorkerFields(await transport.wire.receive({ timeoutMs: 45000 }),
    ['status', 'attemptId', 'prepared', 'committed', 'stateIntent', 'directory', 'owner',
      'runtimeAuthority', 'lockAuthority', 'stateAuthority'],
    'restart state intent publication');
  const descriptor = captureWorkerFields(result.stateIntent,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart state intent descriptor');
  assert.deepEqual(result, {
    status: 'restart-state-intent-published', attemptId: record.attemptId, prepared, committed,
    stateIntent: descriptor, directory, owner, runtimeAuthority: false, lockAuthority: false, stateAuthority: false,
  });
  assert.equal(descriptor.path, `inactive-handoff-${record.attemptId}-state-intent.json`);
  const file = path.join(control, descriptor.path);
  const bytes = await readFile(file);
  const current = await lstat(file, { bigint: true });
  assert.ok(current.isFile());
  assert.equal(current.nlink, 1n);
  assert.equal(bytes.length, descriptor.bytes);
  assert.ok(bytes.length <= 1048576);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
  assert.equal(current.dev.toString(), descriptor.dev);
  assert.equal(current.ino.toString(), descriptor.ino);
  const intent = JSON.parse(bytes);
  const committedRecord = JSON.parse(await readFile(path.join(control, committed.path)));
  assert.equal(new Date(intent.createdAt).toISOString(), intent.createdAt);
  assert.ok(intent.createdAt >= committedRecord.committedAt);
  assert.ok(intent.createdAt <= new Date().toISOString());
  const oldState = validateState(JSON.parse(original.oldState));
  assert.equal(oldState.project, original.project);
  assert.equal(oldState.operationId, original.previousOperationId);
  const nextState = {
    version: 1, operationId: record.newOwner.operationId, project: original.project, operation: original.operation,
    phase: 'preflight', previousPhase: null, sourceCommit: null, targetCommit: null, backupId: null,
    priorRuntime: 'stopped', runtimeIdentity: original.observation.retiredRuntime.generation,
    startedAt: record.newOwner.createdAt, updatedAt: intent.createdAt, errorCode: null,
  };
  assert.deepEqual(validateState(structuredClone(nextState)), nextState);
  assert.deepEqual(intent, {
    version: 1, phase: 'stopped-history-handoff-restart-state-intent', attemptId: record.attemptId,
    control, project: original.project, controlIdentity: original.controlIdentity,
    previousOperationId: original.previousOperationId, prepared, committed, newOwner: record.newOwner,
    lockIdentity: directory, lock: owner, state: original.state, oldState: original.oldState, nextState,
    creator: {
      pid: process.pid, processIdentity: identity,
      bridgePid: ready.pid, bridgeIdentity: ready.processIdentity,
    },
    createdAt: intent.createdAt,
  });
  return { file, bytes, identity: current, descriptor };
}
