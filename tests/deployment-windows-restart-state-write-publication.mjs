import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRestartPublicationProofs } from './deployment-windows-restart-publication-progress.mjs';

export async function assertRestartStateWritePublication({
  control, identity, ready, record, intent, transport, controllerWire, captureWorkerFields, enterPhase,
  holdState = false, releaseRestart = false, processIdentity,
}) {
  assert.ok(!holdState || !releaseRestart);
  enterPhase('host-state-write-command');
  console.log(`INACTIVE_HISTORY_RESTART_STATE_INTENT_LIVE ${JSON.stringify({
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid,
    processIdentity: ready.processIdentity, stateIntent: intent.descriptor,
  })}`);
  const command = captureWorkerFields(await controllerWire.receive({ timeoutMs: 45000 }),
    ['type'], 'restart state write controller command');
  assert.equal(command.type, 'write-restart-state');
  enterPhase('restart-state-write-publication');
  await transport.wire.send({ type: 'write-restart-state' });
  await assertRestartPublicationProofs({
    publication: 'state-write', transport, ready, control, identity, captureWorkerFields, enterPhase,
  });
  let response = await transport.wire.receive({ timeoutMs: 45000 });
  if (holdState || releaseRestart) {
    const frame = captureWorkerFields(response,
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held restart state write');
    assert.equal(frame.type, releaseRestart ? 'restart-state-written-published' : 'ready');
    assert.equal(frame.pid, ready.pid);
    assert.equal(frame.processIdentity, ready.processIdentity);
    assert.equal(frame.processIdentity, await processIdentity(frame.pid));
    assert.equal(frame.control, control);
    assert.equal(frame.controllerIdentity, identity);
    response = frame.value;
  }
  const result = captureWorkerFields(response,
    ['status', 'attemptId', 'stateIntent', 'state', 'runtimeAuthority', 'lockAuthority', 'taskAuthority'],
    'restart state write');
  const descriptor = captureWorkerFields(result.state,
    ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart written state descriptor');
  assert.deepEqual(result, {
    status: 'restart-state-written', attemptId: record.attemptId, stateIntent: intent.descriptor,
    state: descriptor, runtimeAuthority: false, lockAuthority: false, taskAuthority: false,
  });
  assert.equal(descriptor.path, 'state.json');
  const file = path.join(control, 'state.json');
  const bytes = await readFile(file);
  const current = await lstat(file, { bigint: true });
  assert.ok(current.isFile());
  assert.equal(current.nlink, 1n);
  assert.equal(bytes.toString('utf8'), `${JSON.stringify(intent.nextState)}\n`);
  assert.equal(bytes.length, descriptor.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
  assert.equal(current.dev.toString(), descriptor.dev);
  assert.equal(current.ino.toString(), descriptor.ino);
  assert.deepEqual((await readdir(control)).filter(name => name.toLowerCase().startsWith('state.json.lock')), []);
  assert.deepEqual(await readFile(intent.file), intent.bytes);
  return { file, bytes, identity: current, descriptor };
}
