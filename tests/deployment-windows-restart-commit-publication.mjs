import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRestartPublicationProofs } from './deployment-windows-restart-publication-progress.mjs';

export async function assertRestartCommitPublication({
  control, identity, ready, original, record, prepared, directory, owner, transport, controllerWire,
  captureWorkerFields, enterPhase, holdCommitted = false, processIdentity,
}) {
  enterPhase('host-commit-command');
  console.log(`INACTIVE_HISTORY_RESTART_OWNER_LIVE ${JSON.stringify({
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid,
    processIdentity: ready.processIdentity, prepared, directory, owner,
  })}`);
  const command = captureWorkerFields(await controllerWire.receive({ timeoutMs: 45000 }),
    ['type'], 'restart committed controller command');
  assert.equal(command.type, 'commit-restart');
  enterPhase('restart-committed-publication');
  await transport.wire.send({ type: 'commit-restart' });
  await assertRestartPublicationProofs({
    publication: 'committed', transport, ready, control, identity, captureWorkerFields, enterPhase,
  });
  let response = await transport.wire.receive({ timeoutMs: 45000 });
  if (holdCommitted) {
    const frame = captureWorkerFields(response,
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held restart commitment');
    assert.equal(frame.type, 'ready');
    assert.equal(frame.pid, ready.pid);
    assert.equal(frame.processIdentity, ready.processIdentity);
    assert.equal(frame.processIdentity, await processIdentity(frame.pid));
    assert.equal(frame.control, control);
    assert.equal(frame.controllerIdentity, identity);
    response = frame.value;
  }
  const result = captureWorkerFields(response,
    ['status', 'attemptId', 'prepared', 'committed', 'directory', 'owner', 'runtimeAuthority', 'lockAuthority'],
    'restart committed publication');
  const descriptor = captureWorkerFields(result.committed,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart committed descriptor');
  assert.deepEqual(result, {
    status: 'restart-committed-published', attemptId: record.attemptId, prepared, committed: descriptor,
    directory, owner, runtimeAuthority: false, lockAuthority: false,
  });
  assert.equal(descriptor.path, `inactive-handoff-${record.attemptId}-committed.json`);
  const file = path.join(control, descriptor.path);
  const bytes = await readFile(file);
  const current = await lstat(file, { bigint: true });
  assert.ok(current.isFile());
  assert.equal(current.nlink, 1n);
  assert.equal(bytes.length, descriptor.bytes);
  assert.ok(bytes.length <= 65536);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
  assert.equal(current.dev.toString(), descriptor.dev);
  assert.equal(current.ino.toString(), descriptor.ino);
  const committed = JSON.parse(bytes);
  assert.equal(new Date(committed.committedAt).toISOString(), committed.committedAt);
  assert.ok(committed.committedAt >= record.newOwner.createdAt);
  assert.ok(committed.committedAt <= new Date().toISOString());
  assert.deepEqual(committed, {
    version: 1, phase: 'stopped-history-handoff-restart-committed', attemptId: record.attemptId,
    control, project: original.project, controlIdentity: original.controlIdentity,
    previousOperationId: original.previousOperationId, prepared, newOwner: record.newOwner,
    lockIdentity: directory, lock: owner,
    creator: {
      pid: process.pid, processIdentity: identity,
      bridgePid: ready.pid, bridgeIdentity: ready.processIdentity,
    },
    committedAt: committed.committedAt,
  });
  return { file, bytes, identity: current, descriptor };
}
