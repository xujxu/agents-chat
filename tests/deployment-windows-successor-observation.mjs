import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, writeFile, unlink, rename, mkdir, rmdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fixtureArgs, descriptorArgs } from './deployment-windows-lock-retirement-observation.mjs';

function predecessor(previous) {
  return {
    attemptId: previous.attemptId, prepared: previous.prepared, committed: previous.committed,
    retirement: previous.retirement, terminal: previous.terminal,
  };
}

export async function holdSuccessorPrepared({ source, control, pwsh, previous }) {
  assert.equal(previous.directoryRetired, true);
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
  const { captureWorkerFields } = await load('worker-identity.mjs');
  const identity = await processIdentity(process.pid);
  const transport = windowsControllerTransport({
    pwsh, label: 'Held native successor preparation fixture',
    refused: cause => new Error('Held native successor preparation fixture failed.', { cause }),
    args: [...fixtureArgs({ source, control, identity, previous }),
      '-ObserveRetirement', ...descriptorArgs('Retirement', previous.retirement),
      '-ObserveSettlement', ...descriptorArgs('Terminal', previous.terminal),
      '-PrepareSuccessor', '-PublishSuccessor', '-Hold'],
  });
  let ready;
  try {
    ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held successor preparation');
    assert.equal(ready.type, 'ready');
    assert.equal(ready.pid, transport.child.pid);
    assert.equal(ready.processIdentity, await processIdentity(ready.pid));
    assert.equal(ready.control, control);
    assert.equal(ready.controllerIdentity, identity);
    const original = JSON.parse(await readFile(path.join(control, previous.prepared.path)));
    assert.deepEqual(ready.value, {
      status: 'successor-prepared', attemptId: ready.value.attemptId,
      previousAttemptId: previous.attemptId, previousOperationId: original.previousOperationId,
      project: original.project, prepared: ready.value.prepared, predecessor: predecessor(previous),
      runtimeAuthority: false, lockAuthority: false,
    });
    const descriptor = ready.value.prepared;
    assert.equal(descriptor.path, `inactive-handoff-${ready.value.attemptId}-prepared.json`);
    const bytes = await readFile(path.join(control, descriptor.path));
    const current = await lstat(path.join(control, descriptor.path), { bigint: true });
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    assert.equal(current.dev.toString(), descriptor.dev);
    assert.equal(current.ino.toString(), descriptor.ino);
    const record = JSON.parse(bytes);
    assert.deepEqual(record, {
      ...original, phase: 'stopped-history-handoff-successor-prepared',
      attemptId: ready.value.attemptId,
      newOwner: {
        version: 1, token: record.newOwner.token, project: original.project,
        operationId: record.newOwner.operationId, pid: process.pid,
        processIdentity: identity, createdAt: record.newOwner.createdAt,
      },
      predecessor: predecessor(previous),
    });
    assert.equal(new Date(record.newOwner.createdAt).toISOString(), record.newOwner.createdAt);
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  } catch (cause) { throw await transport.abandon(cause); }
  console.log(`INACTIVE_HISTORY_SUCCESSOR_PREPARED_HELD ${JSON.stringify({
    ...previous, successor: ready.value.prepared, successorAttemptId: ready.value.attemptId,
    settlementActor: { actorPid: previous.actorPid, actorIdentity: previous.actorIdentity,
      pid: previous.pid, processIdentity: previous.processIdentity },
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid, processIdentity: ready.processIdentity,
  })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
}

export async function assertSuccessorAfterDeath({
  source, control, pwsh, admission, previous, state, completionBytes,
}) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const identity = await processIdentity(process.pid);
  assert.equal(previous.directoryRetired, true);
  const actors = [previous.originalActor, previous.retirementActor, previous.ownerRetirementActor,
    previous.directoryRetirementActor, previous.settlementActor, previous];
  assert.equal(new Set(actors.map(actor => actor.actorIdentity)).size, 6);
  for (const actor of actors) {
    assert.notEqual(identity, actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.pid), actor.processIdentity);
  }
  const snapshots = [];
  for (const descriptor of [previous.prepared, previous.committed, previous.retirement,
    previous.terminal, previous.successor]) {
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
  const terminal = JSON.parse(snapshots[3].bytes);
  const successor = JSON.parse(snapshots[4].bytes);
  assert.deepEqual(terminal.creator, {
    pid: previous.settlementActor.actorPid, processIdentity: previous.settlementActor.actorIdentity,
    bridgePid: previous.settlementActor.pid, bridgeIdentity: previous.settlementActor.processIdentity,
  });
  assert.equal(original.oldState, state.toString('utf8'));
  assert.equal(successor.attemptId, previous.successorAttemptId);
  assert.equal(successor.newOwner.pid, previous.actorPid);
  assert.equal(successor.newOwner.processIdentity, previous.actorIdentity);
  assert.deepEqual(successor.predecessor, predecessor(previous));
  const stateFile = path.join(control, 'state.json');
  const stateIdentity = await lstat(stateFile, { bigint: true });
  assert.equal(stateIdentity.dev.toString(), original.state.dev);
  assert.equal(stateIdentity.ino.toString(), original.state.ino);
  const completionFile = path.join(control, `retired-${original.previousOperationId}-inactive-rollback-history-complete.json`);
  const completionIdentity = await lstat(completionFile, { bigint: true });
  assert.equal(createHash('sha256').update(completionBytes).digest('hex'), previous.completionSha256);
  const args = [...fixtureArgs({ source, control, identity, previous }), '-ObserveRetirement',
    ...descriptorArgs('Retirement', previous.retirement), '-ObserveSettlement',
    ...descriptorArgs('Terminal', previous.terminal), '-ObserveSuccessor',
    '-SuccessorAttemptId', previous.successorAttemptId, ...descriptorArgs('Successor', previous.successor)];
  const observe = input => promisify(execFile)(pwsh, input,
    { timeout: 45000, maxBuffer: 131072, windowsHide: true });
  const expected = {
    status: 'successor-prepared-observed', attemptId: previous.successorAttemptId,
    previousAttemptId: previous.attemptId, previousOperationId: original.previousOperationId,
    project: original.project, prepared: previous.successor, predecessor: predecessor(previous),
    runtimeAuthority: false, lockAuthority: false,
  };
  const first = await observe(args);
  assert.equal(first.stderr, '');
  assert.deepEqual(JSON.parse(first.stdout), expected);
  const refused = error => error.message.includes('Successor prepared observation failed; retain evidence.');
  const wrong = args.slice();
  wrong[wrong.indexOf('-SuccessorIno') + 1] = previous.successor.ino === '1' ? '2' : '1';
  await assert.rejects(observe(wrong), refused);
  const published = snapshots[4];
  const held = path.join(control, 'fixture-held-successor-prepared.json');
  await rename(published.file, held);
  let replacement;
  try {
    await writeFile(published.file, published.bytes, { flag: 'wx' });
    replacement = await lstat(published.file, { bigint: true });
    assert.notEqual(replacement.ino, published.identity.ino);
    await assert.rejects(observe(args), refused);
    assert.deepEqual(await readFile(published.file), published.bytes);
  } finally {
    if (replacement) {
      const current = await lstat(published.file, { bigint: true });
      assert.equal(current.dev, replacement.dev);
      assert.equal(current.ino, replacement.ino);
      assert.deepEqual(await readFile(published.file), published.bytes);
      await unlink(published.file);
    }
    await rename(held, published.file);
  }
  const directory = path.join(control, 'lock');
  await mkdir(directory);
  const foreign = await lstat(directory, { bigint: true });
  try {
    await assert.rejects(observe(args), refused);
    const current = await lstat(directory, { bigint: true });
    assert.equal(current.dev, foreign.dev);
    assert.equal(current.ino, foreign.ino);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rmdir(directory); }
  const checked = await observe(args);
  assert.equal(checked.stderr, '');
  assert.deepEqual(JSON.parse(checked.stdout), expected);
  const { acquireLock, releaseLock } = await load('state.mjs');
  await assert.rejects(acquireLock(control, { pwsh, admission, project: original.project, operationId: randomUUID() }));
  await assert.rejects(releaseLock(control, successor.newOwner, { pwsh, admission }));
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
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  for (const snapshot of snapshots.reverse()) await unlink(snapshot.file);
  console.log('PASS: actual successor publisher death preserves five exact records for a distinct seventh native observer without continuation authority');
}
