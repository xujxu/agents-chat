import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertRestartPublicationProofs } from './deployment-windows-restart-publication-progress.mjs';

export async function assertRestartOwnerPublication({
  control, identity, ready, record, prepared, directory, transport, controllerWire,
  captureWorkerFields, enterPhase,
}) {
  enterPhase('host-owner-command');
  console.log(`INACTIVE_HISTORY_RESTART_DIRECTORY_LIVE ${JSON.stringify({
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid,
    processIdentity: ready.processIdentity, prepared, directory,
  })}`);
  const command = captureWorkerFields(await controllerWire.receive({ timeoutMs: 45000 }),
    ['type'], 'restart owner controller command');
  assert.equal(command.type, 'publish-owner');
  enterPhase('restart-owner-publication');
  await transport.wire.send({ type: 'publish-owner' });
  await assertRestartPublicationProofs({
    publication: 'owner', transport, ready, control, identity, captureWorkerFields, enterPhase,
  });
  const result = captureWorkerFields(await transport.wire.receive({ timeoutMs: 45000 }),
    ['status', 'attemptId', 'prepared', 'directory', 'owner', 'runtimeAuthority', 'lockAuthority'],
    'restart owner publication');
  const descriptor = captureWorkerFields(result.owner,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart owner descriptor');
  assert.deepEqual(result, {
    status: 'restart-lock-owner', attemptId: record.attemptId, prepared, directory,
    owner: descriptor, runtimeAuthority: false, lockAuthority: false,
  });
  assert.equal(descriptor.path, 'lock\\owner.json');
  const file = path.join(control, 'lock', 'owner.json');
  const bytes = await readFile(file);
  const current = await lstat(file, { bigint: true });
  assert.ok(current.isFile());
  assert.equal(bytes.toString('utf8'), JSON.stringify(record.newOwner));
  assert.equal(bytes.length, descriptor.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
  assert.equal(current.dev.toString(), descriptor.dev);
  assert.equal(current.ino.toString(), descriptor.ino);
  assert.deepEqual(await readdir(path.join(control, 'lock')), ['owner.json']);
  return { file, bytes, identity: current };
}
