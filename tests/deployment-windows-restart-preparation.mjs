import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fixtureArgs, descriptorArgs } from './deployment-windows-lock-retirement-observation.mjs';

export async function assertRestartPreparation({
  source, control, pwsh, admission, previous, state, completionBytes, publish = false,
}) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
  const { captureWorkerFields } = await load('worker-identity.mjs');
  const identity = await processIdentity(process.pid);
  for (const actor of [previous.originalActor, previous.retirementActor, previous.ownerRetirementActor,
    previous.directoryRetirementActor, previous.settlementActor, previous.successorPublisherActor, previous]) {
    assert.notEqual(identity, actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.pid), actor.processIdentity);
  }
  for (const actor of [previous.successorObserverActor, previous.settledObserverActor]) {
    assert.notEqual(identity, actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
  }
  const snapshots = [];
  for (const descriptor of [previous.prepared, previous.committed, previous.retirement,
    previous.terminal, previous.successor, previous.successorAbandoned]) {
    const file = path.join(control, descriptor.path);
    const bytes = await readFile(file);
    const current = await lstat(file, { bigint: true });
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    assert.equal(current.dev.toString(), descriptor.dev);
    assert.equal(current.ino.toString(), descriptor.ino);
    snapshots.push({ file, bytes, identity: current });
  }
  const original = JSON.parse(snapshots[0].bytes);
  const successor = JSON.parse(snapshots[4].bytes);
  const abandoned = JSON.parse(snapshots[5].bytes);
  const predecessor = {
    attemptId: previous.attemptId, prepared: previous.prepared, committed: previous.committed,
    retirement: previous.retirement, terminal: previous.terminal,
  };
  assert.equal(original.oldState, state.toString('utf8'));
  const stateFile = path.join(control, 'state.json');
  const stateIdentity = await lstat(stateFile, { bigint: true });
  assert.equal(stateIdentity.dev.toString(), original.state.dev);
  assert.equal(stateIdentity.ino.toString(), original.state.ino);
  const completionFile = path.join(control, `retired-${original.previousOperationId}-inactive-rollback-history-complete.json`);
  const completionIdentity = await lstat(completionFile, { bigint: true });
  assert.equal(createHash('sha256').update(completionBytes).digest('hex'), previous.completionSha256);
  const nativeArgs = [...fixtureArgs({ source, control, identity, previous }), '-ObserveRetirement',
    ...descriptorArgs('Retirement', previous.retirement), '-ObserveSettlement',
    ...descriptorArgs('Terminal', previous.terminal), '-ObserveSuccessor',
    '-SuccessorAttemptId', previous.successorAttemptId, ...descriptorArgs('Successor', previous.successor),
    '-ObserveSuccessorAbandoned', ...descriptorArgs('Abandoned', previous.successorAbandoned), '-PrepareRestart',
    ...(publish ? ['-PublishRestart'] : [])];
  const transport = windowsControllerTransport({
    pwsh, label: 'Fresh native restart preparation fixture',
    refused: cause => new Error('Fresh native restart preparation fixture failed.', { cause }),
    args: nativeArgs,
  });
  let diagnostic = '';
  let owner;
  transport.child.stderr.on('data', bytes => { diagnostic = `${diagnostic}${bytes.toString('utf8')}`.slice(-4096); });
  try {
    const ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 45000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'settlement observed');
    assert.equal(ready.type, 'successor-settlement-observed');
    assert.equal(ready.pid, transport.child.pid);
    assert.equal(ready.processIdentity, await processIdentity(ready.pid));
    assert.equal(ready.control, control);
    assert.equal(ready.controllerIdentity, identity);
    assert.deepEqual(ready.value, {
      status: 'successor-abandoned-observed', attemptId: previous.successorAttemptId,
      previousAttemptId: previous.attemptId, previousOperationId: original.previousOperationId,
      project: original.project, prepared: previous.successor, abandoned: previous.successorAbandoned,
      predecessor, creator: abandoned.creator, settledAt: abandoned.settledAt,
      runtimeAuthority: false, lockAuthority: false,
    });
    await transport.wire.send({ type: 'prepare' });
    const response = await transport.wire.receive({ timeoutMs: 45000 });
    const publication = publish ? captureWorkerFields(response, ['prepared', 'record'], 'restart publication') : null;
    const record = captureWorkerFields(publication ? publication.record : response,
      ['version', 'phase', 'attemptId', 'newOwner', 'predecessor'], 'restart preparation');
    const identifiers = [record.attemptId, record.newOwner.operationId, record.newOwner.token];
    const oldIds = [original.previousOperationId, previous.attemptId, original.newOwner.operationId,
      original.newOwner.token, previous.successorAttemptId, successor.newOwner.operationId, successor.newOwner.token];
    for (const value of identifiers) {
      assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.ok(!oldIds.includes(value));
    }
    assert.equal(new Set(identifiers).size, 3);
    assert.deepEqual(record, {
      version: 1, phase: 'stopped-history-handoff-restart-prepared', attemptId: record.attemptId,
      newOwner: {
        version: 1, token: record.newOwner.token, project: original.project,
        operationId: record.newOwner.operationId, pid: process.pid,
        processIdentity: identity, createdAt: record.newOwner.createdAt,
      },
      predecessor: {
        attemptId: previous.successorAttemptId, prepared: previous.successor,
        abandoned: previous.successorAbandoned, predecessor,
      },
    });
    assert.equal(new Date(record.newOwner.createdAt).toISOString(), record.newOwner.createdAt);
    assert.ok(record.newOwner.createdAt >= abandoned.settledAt);
    owner = record.newOwner;
    assert.deepEqual(await transport.waitForExit(), { code: 0, signal: null });
    assert.equal(diagnostic, '');
    transport.wire.close();
    if (publication) {
      const descriptor = captureWorkerFields(publication.prepared,
        ['path', 'dev', 'ino', 'bytes', 'sha256'], 'published restart descriptor');
      assert.equal(descriptor.path, `inactive-handoff-${record.attemptId}-prepared.json`);
      const file = path.join(control, descriptor.path);
      const bytes = await readFile(file);
      const current = await lstat(file, { bigint: true });
      assert.equal(bytes.length, descriptor.bytes);
      assert.ok(bytes.length <= 1048576);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
      assert.equal(current.dev.toString(), descriptor.dev);
      assert.equal(current.ino.toString(), descriptor.ino);
      assert.deepEqual(JSON.parse(bytes), {
        ...original, phase: record.phase, attemptId: record.attemptId,
        newOwner: record.newOwner, predecessor: record.predecessor,
      });
      snapshots.push({ file, bytes, identity: current });
    }
  } catch (cause) {
    const error = await transport.abandon(cause);
    if (error.diagnostic) console.error(error.diagnostic);
    throw error;
  }
  const { acquireLock, releaseLock } = await load('state.mjs');
  if (publish) {
    await assert.rejects(promisify(execFile)(pwsh,
      nativeArgs.filter(arg => arg !== '-PrepareRestart' && arg !== '-PublishRestart'),
      { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
    error => error.message.includes('Successor abandoned observation failed; retain evidence.'));
  }
  await assert.rejects(acquireLock(control, { pwsh, admission, project: original.project, operationId: randomUUID() }));
  await assert.rejects(releaseLock(control, owner, { pwsh, admission }));
  for (const snapshot of snapshots) {
    assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
    const current = await lstat(snapshot.file, { bigint: true });
    assert.equal(current.dev, snapshot.identity.dev);
    assert.equal(current.ino, snapshot.identity.ino);
  }
  assert.deepEqual((await readdir(control)).filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort(),
    snapshots.map(snapshot => path.basename(snapshot.file)).sort());
  for (const [file, bytes, originalIdentity] of [
    [stateFile, state, stateIdentity], [completionFile, completionBytes, completionIdentity],
  ]) {
    assert.deepEqual(await readFile(file), bytes);
    const current = await lstat(file, { bigint: true });
    assert.equal(current.dev, originalIdentity.dev);
    assert.equal(current.ino, originalIdentity.ino);
  }
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  for (const snapshot of snapshots.reverse()) await unlink(snapshot.file);
  console.log(publish
    ? 'PASS: native restart publication creates one exact seventh preparation while duplicate publication and ordinary authority remain refused'
    : 'PASS: native restart preparation derives a fresh live owner bound to settled six-record evidence without publication or authority');
}
