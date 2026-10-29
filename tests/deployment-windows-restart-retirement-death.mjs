import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const descriptorFields = ['path', 'dev', 'ino', 'bytes', 'sha256'];

export const restartCommittedRequest = previous => ({
  attemptId: previous.attemptId, prepared: previous.prepared, committed: previous.committed,
  retirement: previous.retirement, terminal: previous.terminal, successor: previous.successor,
  successorAbandoned: previous.successorAbandoned, restart: previous.restartPrepared,
  restartCommitted: previous.restartCommitted,
});

export const restartObservationArgs = ({ source, control, identity, request, hold = false }) => [
  '-NoProfile', '-NonInteractive', '-File',
  fileURLToPath(new URL('./deployment-windows-history-handoff-restart-observation.ps1', import.meta.url)),
  '-Source', source, '-Control', control, '-ControllerPid', String(process.pid), '-ControllerIdentity', identity,
  '-Request', JSON.stringify(request), ...(hold ? ['-Hold'] : []),
];

// A distinct retirer publishes only its retirement intent and stays live so the controller can kill it there.
export async function holdRestartRetirement({ source, control, pwsh, previous }) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
  const { captureWorkerFields } = await load('worker-identity.mjs');
  const identity = await processIdentity(process.pid);
  assert.notEqual(identity, previous.actorIdentity);
  assert.notEqual(await processIdentity(previous.actorPid), previous.actorIdentity);
  assert.notEqual(await processIdentity(previous.pid), previous.processIdentity);
  const transport = windowsControllerTransport({
    pwsh, label: 'Held restart lock retirement fixture',
    refused: cause => new Error('Held restart lock retirement fixture failed.', { cause }),
    args: restartObservationArgs({
      source, control, identity, hold: true,
      request: { ...restartCommittedRequest(previous), retireRestart: true },
    }),
  });
  let ready;
  let retirement;
  try {
    ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held restart lock retirement');
    assert.equal(ready.type, 'ready');
    assert.equal(ready.pid, transport.child.pid);
    assert.equal(ready.processIdentity, await processIdentity(ready.pid));
    assert.equal(ready.control, control);
    assert.equal(ready.controllerIdentity, identity);
    const value = captureWorkerFields(ready.value,
      ['status', 'attemptId', 'prepared', 'committed', 'retirement', 'lockIdentity', 'lock', 'state',
        'runtimeAuthority', 'lockAuthority', 'taskAuthority'], 'held restart lock retirement value');
    retirement = captureWorkerFields(value.retirement, descriptorFields, 'held restart lock retirement descriptor');
    const original = JSON.parse(await readFile(path.join(control, previous.prepared.path)));
    assert.deepEqual(value, {
      status: 'restart-lock-retirement-prepared', attemptId: previous.restartAttemptId,
      prepared: previous.restartPrepared, committed: previous.restartCommitted, retirement,
      lockIdentity: previous.restartDirectory, lock: previous.restartOwner, state: original.state,
      runtimeAuthority: false, lockAuthority: false, taskAuthority: false,
    });
    assert.equal(retirement.path, `inactive-handoff-${previous.restartAttemptId}-lock-retirement.json`);
    const bytes = await readFile(path.join(control, retirement.path));
    assert.equal(bytes.length, retirement.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), retirement.sha256);
    assert.deepEqual(JSON.parse(bytes).creator, {
      pid: process.pid, processIdentity: identity, bridgePid: ready.pid, bridgeIdentity: ready.processIdentity,
    });
  } catch (cause) { throw await transport.abandon(cause); }
  console.log(`INACTIVE_HISTORY_RESTART_RETIREMENT_HELD ${JSON.stringify({
    ...previous, restartRetirement: retirement,
    restartRetirerActor: {
      actorPid: process.pid, actorIdentity: identity, pid: ready.pid, processIdentity: ready.processIdentity,
    },
  })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
}

// A distinct observer proves the retirer and owner dead from the intent alone and cannot duplicate it.
export async function assertDeadRestartRetirement({
  control, identity, previous, original, newOwner, committedValue, snapshot, observe, restartArgs,
  processIdentity, captureWorkerFields,
}) {
  const retirer = captureWorkerFields(previous.restartRetirerActor,
    ['actorPid', 'actorIdentity', 'pid', 'processIdentity'], 'dead restart lock retirer');
  assert.notEqual(identity, retirer.actorIdentity);
  assert.notEqual(retirer.actorIdentity, previous.actorIdentity);
  assert.notEqual(retirer.pid, previous.pid);
  assert.notEqual(await processIdentity(retirer.actorPid), retirer.actorIdentity);
  assert.notEqual(await processIdentity(retirer.pid), retirer.processIdentity);
  const descriptor = captureWorkerFields(previous.restartRetirement, descriptorFields, 'dead restart lock retirement');
  assert.equal(descriptor.path, `inactive-handoff-${previous.restartAttemptId}-lock-retirement.json`);
  assert.equal(snapshot.identity.nlink, 1n);
  assert.ok(snapshot.bytes.length <= 65536);
  const intent = JSON.parse(snapshot.bytes);
  assert.equal(new Date(intent.createdAt).toISOString(), intent.createdAt);
  assert.ok(intent.createdAt >= committedValue.committedAt);
  const creator = {
    pid: retirer.actorPid, processIdentity: retirer.actorIdentity,
    bridgePid: retirer.pid, bridgeIdentity: retirer.processIdentity,
  };
  assert.deepEqual(intent, {
    version: 1, phase: 'stopped-history-handoff-restart-lock-retirement-prepared',
    attemptId: previous.restartAttemptId, control, project: original.project,
    controlIdentity: original.controlIdentity, previousOperationId: original.previousOperationId,
    prepared: previous.restartPrepared, committed: previous.restartCommitted, newOwner,
    lockIdentity: previous.restartDirectory, lock: previous.restartOwner, state: original.state,
    owner: committedValue.creator, creator, createdAt: intent.createdAt,
  });
  const committedRequest = restartCommittedRequest(previous);
  await assert.rejects(observe(restartArgs(committedRequest)),
    error => error.message.includes('Restart committed observation failed; retain evidence.'));
  const retirementRequest = { ...committedRequest, restartRetirement: descriptor };
  const expected = {
    status: 'restart-lock-retirement-observed', attemptId: previous.restartAttemptId,
    prepared: previous.restartPrepared, committed: previous.restartCommitted, retirement: descriptor,
    lockIdentity: previous.restartDirectory, lock: previous.restartOwner, state: original.state,
    owner: committedValue.creator, retirer: creator,
    runtimeAuthority: false, lockAuthority: false, taskAuthority: false,
  };
  for (let pass = 0; pass < 2; pass++) {
    const result = await observe(restartArgs(retirementRequest));
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  const retirementRefused = error =>
    error.message.includes('Restart lock retirement observation failed; retain evidence.');
  for (const wrong of [
    { ...descriptor, ino: descriptor.ino === '1' ? '2' : '1' },
    { ...descriptor, path: previous.restartCommitted.path },
  ]) {
    await assert.rejects(observe(restartArgs({ ...retirementRequest, restartRetirement: wrong })), retirementRefused);
  }
  await assert.rejects(observe(restartArgs({ ...retirementRequest, retireRestart: true })),
    error => error.message.includes('Restart lock retirement failed; retain evidence.'));
  const directory = path.join(control, 'lock');
  const owner = path.join(directory, 'owner.json');
  assert.deepEqual(await readdir(directory), ['owner.json']);
  const retired = await observe(restartArgs({ ...retirementRequest, retireOwner: true }));
  assert.equal(retired.stderr, '');
  assert.deepEqual(JSON.parse(retired.stdout), { ...expected, status: 'restart-lock-retirement-owner-retired' });
  await assert.rejects(lstat(owner), { code: 'ENOENT' });
  const current = await lstat(directory, { bigint: true });
  assert.ok(current.isDirectory());
  assert.equal(current.dev.toString(), previous.restartDirectory.dev);
  assert.equal(current.ino.toString(), previous.restartDirectory.ino);
  assert.deepEqual(await readdir(directory), []);
  const intentBytes = await readFile(path.join(control, descriptor.path));
  assert.equal(createHash('sha256').update(intentBytes).digest('hex'), descriptor.sha256);
  // The owner retirer has exited; a fresh distinct observer takes over the partially retired lock.
  for (let pass = 0; pass < 2; pass++) {
    const result = await observe(restartArgs(retirementRequest));
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ...expected, status: 'restart-lock-retirement-owner-retired' });
  }
  assert.deepEqual(await readdir(directory), []);
  const removed = await observe(restartArgs({ ...retirementRequest, retireDirectory: true }));
  assert.equal(removed.stderr, '');
  assert.deepEqual(JSON.parse(removed.stdout), { ...expected, status: 'restart-lock-retirement-directory-retired' });
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(control, descriptor.path)), intentBytes);
}
