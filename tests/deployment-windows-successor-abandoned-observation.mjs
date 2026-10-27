import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, writeFile, unlink, rename, mkdir, rmdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fixtureArgs, descriptorArgs } from './deployment-windows-lock-retirement-observation.mjs';
import { publishSuccessorAbandonment } from './deployment-windows-successor-abandonment.mjs';

const predecessor = previous => ({
  attemptId: previous.attemptId, prepared: previous.prepared, committed: previous.committed,
  retirement: previous.retirement, terminal: previous.terminal,
});
const successorArgs = ({ source, control, identity, previous }) => [
  ...fixtureArgs({ source, control, identity, previous }), '-ObserveRetirement',
  ...descriptorArgs('Retirement', previous.retirement), '-ObserveSettlement',
  ...descriptorArgs('Terminal', previous.terminal), '-ObserveSuccessor',
  '-SuccessorAttemptId', previous.successorAttemptId, ...descriptorArgs('Successor', previous.successor),
];

export async function holdSuccessorAbandoned({ source, control, pwsh, previous }) {
  const { processIdentity } = await import(pathToFileURL(path.join(source, 'process-identity.mjs')).href);
  const identity = await processIdentity(process.pid);
  assert.notEqual(identity, previous.successorObserverActor.actorIdentity);
  assert.notEqual(await processIdentity(previous.successorObserverActor.actorPid), previous.successorObserverActor.actorIdentity);
  const original = JSON.parse(await readFile(path.join(control, previous.prepared.path)));
  const successor = JSON.parse(await readFile(path.join(control, previous.successor.path)));
  const result = await publishSuccessorAbandonment({
    source, control, pwsh, identity, previous, original, successor, hold: true,
    args: successorArgs({ source, control, identity, previous }),
    expected: {
      status: 'successor-prepared-observed', attemptId: previous.successorAttemptId,
      previousAttemptId: previous.attemptId, previousOperationId: original.previousOperationId,
      project: original.project, prepared: previous.successor, predecessor: predecessor(previous),
      runtimeAuthority: false, lockAuthority: false,
    },
  });
  try { await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' }); }
  catch (cause) { throw await result.transport.abandon(cause); }
  console.log(`INACTIVE_HISTORY_SUCCESSOR_ABANDONED_HELD ${JSON.stringify({
    ...previous, successorAbandoned: result.descriptor,
    successorPublisherActor: {
      actorPid: previous.actorPid, actorIdentity: previous.actorIdentity,
      pid: previous.pid, processIdentity: previous.processIdentity,
    },
    actorPid: process.pid, actorIdentity: identity,
    pid: result.bridge.pid, processIdentity: result.bridge.processIdentity,
  })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
}

export async function assertSuccessorAbandonedAfterDeath({
  source, control, pwsh, admission, previous, state, completionBytes,
}) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const identity = await processIdentity(process.pid);
  const actors = [previous.originalActor, previous.retirementActor, previous.ownerRetirementActor,
    previous.directoryRetirementActor, previous.settlementActor, previous.successorPublisherActor, previous];
  assert.equal(new Set([...actors.map(actor => actor.actorIdentity), previous.successorObserverActor.actorIdentity]).size, 8);
  for (const actor of actors) {
    assert.notEqual(identity, actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.pid), actor.processIdentity);
  }
  assert.notEqual(identity, previous.successorObserverActor.actorIdentity);
  assert.notEqual(await processIdentity(previous.successorObserverActor.actorPid), previous.successorObserverActor.actorIdentity);
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
  assert.equal(original.oldState, state.toString('utf8'));
  assert.equal(successor.newOwner.pid, previous.successorPublisherActor.actorPid);
  assert.equal(successor.newOwner.processIdentity, previous.successorPublisherActor.actorIdentity);
  assert.deepEqual(successor.predecessor, predecessor(previous));
  assert.deepEqual(abandoned.creator, {
    pid: previous.actorPid, processIdentity: previous.actorIdentity,
    bridgePid: previous.pid, bridgeIdentity: previous.processIdentity,
  });
  assert.equal(abandoned.attemptId, previous.successorAttemptId);
  assert.deepEqual(abandoned.prepared, previous.successor);
  const stateFile = path.join(control, 'state.json');
  const stateIdentity = await lstat(stateFile, { bigint: true });
  assert.equal(stateIdentity.dev.toString(), original.state.dev);
  assert.equal(stateIdentity.ino.toString(), original.state.ino);
  const completionFile = path.join(control, `retired-${original.previousOperationId}-inactive-rollback-history-complete.json`);
  const completionIdentity = await lstat(completionFile, { bigint: true });
  assert.equal(createHash('sha256').update(completionBytes).digest('hex'), previous.completionSha256);
  const baseArgs = successorArgs({ source, control, identity, previous });
  const args = [...baseArgs, '-ObserveSuccessorAbandoned', ...descriptorArgs('Abandoned', previous.successorAbandoned)];
  const observe = input => promisify(execFile)(pwsh, input,
    { timeout: 45000, maxBuffer: 131072, windowsHide: true });
  const expected = {
    status: 'successor-abandoned-observed', attemptId: previous.successorAttemptId,
    previousAttemptId: previous.attemptId, previousOperationId: original.previousOperationId,
    project: original.project, prepared: previous.successor, abandoned: previous.successorAbandoned,
    predecessor: predecessor(previous), creator: abandoned.creator, settledAt: abandoned.settledAt,
    runtimeAuthority: false, lockAuthority: false,
  };
  const first = await observe(args);
  assert.equal(first.stderr, '');
  assert.deepEqual(JSON.parse(first.stdout), expected);
  const refused = error => error.message.includes('Successor abandoned observation failed; retain evidence.');
  const wrong = args.slice();
  wrong[wrong.indexOf('-AbandonedIno') + 1] = previous.successorAbandoned.ino === '1' ? '2' : '1';
  await assert.rejects(observe(wrong), refused);
  const published = snapshots[5];
  const held = path.join(control, 'fixture-held-successor-abandoned.json');
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
  await assert.rejects(observe(baseArgs),
    error => error.message.includes('Successor prepared observation failed; retain evidence.'));
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
  console.log('PASS: actual successor abandonment publisher death preserves six exact records for a distinct ninth native observer without continuation authority');
}
