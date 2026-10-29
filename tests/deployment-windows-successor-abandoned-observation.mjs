import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, writeFile, unlink, rename, mkdir, rmdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fixtureArgs, descriptorArgs } from './deployment-windows-lock-retirement-observation.mjs';
import { publishSuccessorAbandonment } from './deployment-windows-successor-abandonment.mjs';
import { assertDeadRestartRetirement } from './deployment-windows-restart-retirement-death.mjs';

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
  source, control, pwsh, admission, previous, state, completionBytes, restart = false, blockedDirectory = false,
  blockedOwner = false, blockedCommitted = false, blockedState = false, blockedReleased = false,
  blockedRetirement = false, blockedReleaseIntent = false,
}) {
  assert.ok(!blockedDirectory || restart);
  assert.ok(!blockedOwner || blockedDirectory);
  assert.ok(!blockedCommitted || blockedOwner);
  assert.ok(!blockedState || blockedCommitted);
  assert.ok(!blockedReleased || blockedCommitted);
  assert.ok(!blockedRetirement || (blockedCommitted && !blockedState && !blockedReleased));
  assert.ok(!blockedReleaseIntent || (blockedCommitted && !blockedReleased && !blockedRetirement));
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const identity = await processIdentity(process.pid);
  const actors = [previous.originalActor, previous.retirementActor, previous.ownerRetirementActor,
    previous.directoryRetirementActor, previous.settlementActor, previous.successorPublisherActor,
    ...(restart ? [previous.abandonmentPublisherActor] : []), previous];
  const observers = [previous.successorObserverActor, ...(restart ? [previous.settledObserverActor] : [])];
  assert.equal(new Set([...actors, ...observers].map(actor => actor.actorIdentity)).size, restart ? 10 : 8);
  for (const actor of actors) {
    assert.notEqual(identity, actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.pid), actor.processIdentity);
  }
  for (const actor of observers) {
    assert.notEqual(identity, actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
  }
  const snapshots = [];
  for (const descriptor of [previous.prepared, previous.committed, previous.retirement,
    previous.terminal, previous.successor, previous.successorAbandoned, ...(restart ? [previous.restartPrepared] : []),
    ...(blockedCommitted ? [previous.restartCommitted] : []), ...(blockedState ? [previous.restartStateIntent] : []),
    ...(blockedReleased ? [previous.restartRelease, previous.restartReleased] : []),
    ...(blockedRetirement ? [previous.restartRetirement] : []),
    ...(blockedReleaseIntent ? [previous.restartRelease] : [])]) {
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
  const abandonmentPublisher = restart ? previous.abandonmentPublisherActor : previous;
  assert.deepEqual(abandoned.creator, {
    pid: abandonmentPublisher.actorPid, processIdentity: abandonmentPublisher.actorIdentity,
    bridgePid: abandonmentPublisher.pid, bridgeIdentity: abandonmentPublisher.processIdentity,
  });
  assert.equal(abandoned.attemptId, previous.successorAttemptId);
  assert.deepEqual(abandoned.prepared, previous.successor);
  const stateFile = path.join(control, 'state.json');
  const stateIdentity = await lstat(stateFile, { bigint: true });
  let writtenState;
  let committedObserved = false;
  let stateObserved = false;
  if (blockedState) {
    const intent = JSON.parse(snapshots[8].bytes);
    assert.equal(previous.restartStateIntent.path, `inactive-handoff-${previous.restartAttemptId}-state-intent.json`);
    assert.equal(snapshots[8].identity.nlink, 1n);
    assert.equal(intent.phase, 'stopped-history-handoff-restart-state-intent');
    assert.equal(intent.attemptId, previous.restartAttemptId);
    assert.deepEqual(intent.prepared, previous.restartPrepared);
    assert.deepEqual(intent.committed, previous.restartCommitted);
    assert.deepEqual(intent.lockIdentity, previous.restartDirectory);
    assert.deepEqual(intent.lock, previous.restartOwner);
    assert.equal(intent.oldState, state.toString('utf8'));
    assert.deepEqual(intent.state, original.state);
    assert.deepEqual(intent.creator, {
      pid: previous.actorPid, processIdentity: previous.actorIdentity,
      bridgePid: previous.pid, bridgeIdentity: previous.processIdentity,
    });
    const bytes = await readFile(stateFile);
    assert.equal(bytes.toString('utf8'), `${JSON.stringify(intent.nextState)}\n`);
    assert.equal(intent.nextState.operationId, intent.newOwner.operationId);
    assert.equal(stateIdentity.nlink, 1n);
    assert.equal(stateIdentity.dev.toString(), previous.restartState.dev);
    assert.equal(stateIdentity.ino.toString(), previous.restartState.ino);
    assert.equal(bytes.length, previous.restartState.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), previous.restartState.sha256);
    assert.notEqual(stateIdentity.ino.toString(), original.state.ino);
    await assert.rejects(readFile(path.join(control, 'state.json.lock')), { code: 'ENOENT' });
    writtenState = bytes;
  } else {
    assert.equal(stateIdentity.dev.toString(), original.state.dev);
    assert.equal(stateIdentity.ino.toString(), original.state.ino);
  }
  const completionFile = path.join(control, `retired-${original.previousOperationId}-inactive-rollback-history-complete.json`);
  const completionIdentity = await lstat(completionFile, { bigint: true });
  assert.equal(createHash('sha256').update(completionBytes).digest('hex'), previous.completionSha256);
  const baseArgs = successorArgs({ source, control, identity, previous });
  const sixArgs = [...baseArgs, '-ObserveSuccessorAbandoned', ...descriptorArgs('Abandoned', previous.successorAbandoned)];
  const request = {
    attemptId: previous.attemptId, prepared: previous.prepared, committed: previous.committed,
    retirement: previous.retirement, terminal: previous.terminal, successor: previous.successor,
    successorAbandoned: previous.successorAbandoned, restart: previous.restartPrepared,
  };
  const restartArgs = value => ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./deployment-windows-history-handoff-restart-observation.ps1', import.meta.url)),
    '-Source', source, '-Control', control, '-ControllerPid', String(process.pid), '-ControllerIdentity', identity,
    '-Request', JSON.stringify(value)];
  const args = restart ? restartArgs(request) : sixArgs;
  let observation = 0;
  const observe = async input => {
    // Stderr timing lets a timed-out takeover show which native observation consumed its budget.
    const index = ++observation;
    const started = Date.now();
    const requestIndex = input.indexOf('-Request');
    const switches = requestIndex < 0 ? input.filter(arg => /^-[A-Z]/.test(arg) && !['-NoProfile', '-NonInteractive', '-File', '-Source', '-Control', '-ControllerPid', '-ControllerIdentity'].includes(arg))
      : Object.keys(JSON.parse(input[requestIndex + 1])).filter(key => /^(restart|retire|settle|release|successor)/.test(key));
    let outcome = 'rejected';
    try {
      const result = await promisify(execFile)(pwsh, input, { timeout: 300000, maxBuffer: 131072, windowsHide: true });
      outcome = 'resolved';
      return result;
    } finally {
      console.error(`NATIVE_OBSERVATION ${index} ${Date.now() - started}ms ${outcome} ${switches.join(' ')}`);
    }
  };
  const expected = restart ? {
    status: 'restart-prepared-observed', attemptId: previous.restartAttemptId,
    previousAttemptId: previous.successorAttemptId, previousOperationId: original.previousOperationId,
    project: original.project, prepared: previous.restartPrepared,
    predecessor: {
      attemptId: previous.successorAttemptId, prepared: previous.successor,
      abandoned: previous.successorAbandoned, predecessor: predecessor(previous),
    },
    runtimeAuthority: false, lockAuthority: false,
  } : {
    status: 'successor-abandoned-observed', attemptId: previous.successorAttemptId,
    previousAttemptId: previous.attemptId, previousOperationId: original.previousOperationId,
    project: original.project, prepared: previous.successor, abandoned: previous.successorAbandoned,
    predecessor: predecessor(previous), creator: abandoned.creator, settledAt: abandoned.settledAt,
    runtimeAuthority: false, lockAuthority: false,
  };
  const refused = error => error.message.includes(restart
    ? 'Restart prepared observation failed; retain evidence.'
    : 'Successor abandoned observation failed; retain evidence.');
  const published = snapshots[restart ? 6 : 5];
  const directory = path.join(control, 'lock');
  let ownerSnapshot;
  let releasedObserved = false;
  let retirementPublished = false;
  let retirementObserved = false;
  let releaseIntentRefused = false;
  if (blockedDirectory) {
    if (blockedReleased) {
      await assert.rejects(lstat(directory), { code: 'ENOENT' });
    } else {
      const current = await lstat(directory, { bigint: true });
      assert.ok(current.isDirectory());
      assert.equal(current.dev.toString(), previous.restartDirectory.dev);
      assert.equal(current.ino.toString(), previous.restartDirectory.ino);
      assert.deepEqual(await readdir(directory), blockedOwner ? ['owner.json'] : []);
    }
    if (blockedOwner && !blockedReleased) {
      const { captureWorkerFields } = await load('worker-identity.mjs');
      const descriptor = captureWorkerFields(previous.restartOwner,
        ['path', 'dev', 'ino', 'bytes', 'sha256'], 'dead restart owner descriptor');
      assert.equal(descriptor.path, 'lock\\owner.json');
      const file = path.join(directory, 'owner.json');
      const bytes = await readFile(file);
      const current = await lstat(file, { bigint: true });
      assert.ok(current.isFile());
      assert.equal(current.nlink, 1n);
      assert.equal(current.dev.toString(), descriptor.dev);
      assert.equal(current.ino.toString(), descriptor.ino);
      assert.equal(bytes.length, descriptor.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
      const owner = captureWorkerFields(JSON.parse(bytes),
        ['version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt'], 'dead restart owner');
      const preparedOwner = JSON.parse(published.bytes).newOwner;
      assert.deepEqual(owner, preparedOwner);
      assert.equal(bytes.toString('utf8'), JSON.stringify(preparedOwner));
      assert.equal(owner.version, 1);
      assert.equal(owner.project, original.project);
      assert.equal(owner.pid, previous.actorPid);
      assert.equal(owner.processIdentity, previous.actorIdentity);
      ownerSnapshot = { file, bytes, identity: current };
    }
    if (blockedCommitted) {
      const committed = snapshots[7];
      assert.equal(previous.restartCommitted.path, `inactive-handoff-${previous.restartAttemptId}-committed.json`);
      assert.ok(committed.bytes.length <= 65536);
      assert.equal(committed.identity.nlink, 1n);
      const record = JSON.parse(committed.bytes);
      assert.equal(new Date(record.committedAt).toISOString(), record.committedAt);
      assert.ok(record.committedAt >= JSON.parse(published.bytes).newOwner.createdAt);
      assert.deepEqual(record, {
        version: 1, phase: 'stopped-history-handoff-restart-committed', attemptId: previous.restartAttemptId,
        control, project: original.project, controlIdentity: original.controlIdentity,
        previousOperationId: original.previousOperationId, prepared: previous.restartPrepared,
        newOwner: JSON.parse(published.bytes).newOwner, lockIdentity: previous.restartDirectory,
        lock: previous.restartOwner,
        creator: {
          pid: previous.actorPid, processIdentity: previous.actorIdentity,
          bridgePid: previous.pid, bridgeIdentity: previous.processIdentity,
        },
        committedAt: record.committedAt,
      });
      if (blockedReleaseIntent && blockedState) {
        // The dead post-write releaser's exact tenth record binds its acknowledged written state and itself.
        const intent = JSON.parse(snapshots[9].bytes);
        assert.equal(previous.restartRelease.path, `inactive-handoff-${previous.restartAttemptId}-lock-retirement.json`);
        assert.equal(snapshots[9].identity.nlink, 1n);
        assert.equal(new Date(intent.createdAt).toISOString(), intent.createdAt);
        assert.ok(intent.createdAt >= record.committedAt);
        assert.ok(intent.createdAt >= JSON.parse(snapshots[8].bytes).createdAt);
        assert.deepEqual(intent, {
          version: 1, phase: 'stopped-history-handoff-restart-release-prepared', attemptId: previous.restartAttemptId,
          control, project: original.project, controlIdentity: original.controlIdentity,
          previousOperationId: original.previousOperationId, prepared: previous.restartPrepared,
          committed: previous.restartCommitted, newOwner: JSON.parse(published.bytes).newOwner,
          lockIdentity: previous.restartDirectory, lock: previous.restartOwner, state: original.state,
          stateIntent: previous.restartStateIntent, writtenState: previous.restartState,
          creator: record.creator, createdAt: intent.createdAt,
        });
      }
      if (blockedReleased) {
        const releaseIndex = blockedState ? 9 : 8;
        const [retirement, released] = [snapshots[releaseIndex], snapshots[releaseIndex + 1]];
        assert.equal(previous.restartRelease.path, `inactive-handoff-${previous.restartAttemptId}-lock-retirement.json`);
        assert.equal(previous.restartReleased.path, `inactive-handoff-${previous.restartAttemptId}-lock-retired.json`);
        const binding = {
          attemptId: previous.restartAttemptId, control, project: original.project,
          controlIdentity: original.controlIdentity, previousOperationId: original.previousOperationId,
          prepared: previous.restartPrepared, committed: previous.restartCommitted,
          newOwner: JSON.parse(published.bytes).newOwner, lockIdentity: previous.restartDirectory,
          lock: previous.restartOwner, state: original.state,
          ...(blockedState ? { stateIntent: previous.restartStateIntent, writtenState: previous.restartState } : {}),
          creator: {
            pid: previous.actorPid, processIdentity: previous.actorIdentity,
            bridgePid: previous.pid, bridgeIdentity: previous.processIdentity,
          },
        };
        for (const snapshot of [retirement, released]) {
          assert.equal(snapshot.identity.nlink, 1n);
          assert.ok(snapshot.bytes.length <= 65536);
        }
        const intent = JSON.parse(retirement.bytes);
        assert.ok(intent.createdAt >= record.committedAt);
        if (blockedState) { assert.ok(intent.createdAt >= JSON.parse(snapshots[8].bytes).createdAt); }
        assert.deepEqual(intent, {
          version: 1, phase: 'stopped-history-handoff-restart-release-prepared', ...binding, createdAt: intent.createdAt,
        });
        const settled = JSON.parse(released.bytes);
        assert.ok(settled.releasedAt >= intent.createdAt);
        assert.deepEqual(settled, {
          version: 1, phase: 'stopped-history-handoff-restart-released', ...binding,
          retirement: previous.restartRelease, releasedAt: settled.releasedAt,
        });
      }
    }
    // Without the ninth-record transition, the generic reader follows the written state to an archive that
    // never existed; it must not substitute the original state.
    await assert.rejects(observe(args), error => refused(error) && error.message.includes(blockedState
      ? `retired-${JSON.parse(writtenState).operationId}-inactive-rollback-history-intent.json`
      : blockedCommitted ? 'Retired prepared handoff namespace differs.' : 'Committed lock directory identity differs.'));
    if (blockedReleased && !blockedState) {
      // The released lock and its two release records are outside every observer this gate exposes.
      const committedRequest = { ...request, restartCommitted: previous.restartCommitted };
      await assert.rejects(observe(restartArgs(committedRequest)),
        error => error.message.includes('Restart committed observation failed; retain evidence.'));
      releasedObserved = true;
    } else if (blockedRetirement || (blockedReleaseIntent && !blockedState)) {
      // A dead releaser's exact release intent is the same dead-owner retirement authority as a distinct retirer's.
      const { captureWorkerFields } = await load('worker-identity.mjs');
      snapshots.push(await assertDeadRestartRetirement({
        control, identity, previous, original, newOwner: JSON.parse(published.bytes).newOwner,
        committedValue: JSON.parse(snapshots[7].bytes), snapshot: snapshots[8], observe, restartArgs,
        processIdentity, captureWorkerFields, release: blockedReleaseIntent,
      }));
      // The distinct observer has retired only the dead owner file; its empty directory remains.
      ownerSnapshot = undefined;
      retirementObserved = true;
    } else if (blockedCommitted && !blockedState) {
      const committedRequest = { ...request, restartCommitted: previous.restartCommitted };
      const committedExpected = {
        status: 'restart-committed-observed', attemptId: previous.restartAttemptId,
        previousAttemptId: previous.successorAttemptId, previousOperationId: original.previousOperationId,
        project: original.project, prepared: previous.restartPrepared, committed: previous.restartCommitted,
        lockIdentity: previous.restartDirectory, lock: previous.restartOwner,
        runtimeAuthority: false, lockAuthority: false, taskAuthority: false,
      };
      const committedRefused = error => error.message.includes('Restart committed observation failed; retain evidence.');
      for (let pass = 0; pass < 2; pass++) {
        const result = await observe(restartArgs(committedRequest));
        assert.equal(result.stderr, '');
        assert.deepEqual(JSON.parse(result.stdout), committedExpected);
      }
      await assert.rejects(observe(restartArgs({
        ...committedRequest,
        restartCommitted: { ...committedRequest.restartCommitted, ino: committedRequest.restartCommitted.ino === '1' ? '2' : '1' },
      })), committedRefused);
      await assert.rejects(observe(restartArgs({
        ...committedRequest,
        restartCommitted: { ...committedRequest.restartCommitted, path: previous.restartPrepared.path },
      })), committedRefused);
      committedObserved = true;
      // A distinct retirer proves the committed owner dead before it publishes only its retirement intent.
      const { captureWorkerFields } = await load('worker-identity.mjs');
      const retiredRun = await observe(restartArgs({ ...committedRequest, retireRestart: true }));
      assert.equal(retiredRun.stderr, '');
      const retired = JSON.parse(retiredRun.stdout);
      const retirementDescriptor = captureWorkerFields(retired.retirement,
        ['path', 'dev', 'ino', 'bytes', 'sha256'], 'restart lock retirement descriptor');
      assert.deepEqual(retired, {
        status: 'restart-lock-retirement-prepared', attemptId: previous.restartAttemptId,
        prepared: previous.restartPrepared, committed: previous.restartCommitted, retirement: retirementDescriptor,
        lockIdentity: previous.restartDirectory, lock: previous.restartOwner, state: original.state,
        runtimeAuthority: false, lockAuthority: false, taskAuthority: false,
      });
      assert.equal(retirementDescriptor.path, `inactive-handoff-${previous.restartAttemptId}-lock-retirement.json`);
      const retirementFile = path.join(control, retirementDescriptor.path);
      const retirementBytes = await readFile(retirementFile);
      const retirementIdentity = await lstat(retirementFile, { bigint: true });
      assert.ok(retirementIdentity.isFile());
      assert.equal(retirementIdentity.nlink, 1n);
      assert.equal(retirementIdentity.dev.toString(), retirementDescriptor.dev);
      assert.equal(retirementIdentity.ino.toString(), retirementDescriptor.ino);
      assert.equal(retirementBytes.length, retirementDescriptor.bytes);
      assert.ok(retirementBytes.length <= 65536);
      assert.equal(createHash('sha256').update(retirementBytes).digest('hex'), retirementDescriptor.sha256);
      const intent = JSON.parse(retirementBytes);
      const committedValue = JSON.parse(snapshots[7].bytes);
      assert.equal(new Date(intent.createdAt).toISOString(), intent.createdAt);
      assert.ok(intent.createdAt >= committedValue.committedAt);
      assert.ok(intent.createdAt <= new Date().toISOString());
      const retirer = captureWorkerFields(intent.creator,
        ['pid', 'processIdentity', 'bridgePid', 'bridgeIdentity'], 'restart lock retirer');
      assert.equal(retirer.pid, process.pid);
      assert.equal(retirer.processIdentity, identity);
      assert.ok(Number.isInteger(retirer.bridgePid) && retirer.bridgePid > 0);
      assert.notEqual(retirer.bridgePid, previous.pid);
      assert.equal(typeof retirer.bridgeIdentity, 'string');
      assert.notEqual(await processIdentity(retirer.bridgePid), retirer.bridgeIdentity);
      assert.deepEqual(intent, {
        version: 1, phase: 'stopped-history-handoff-restart-lock-retirement-prepared',
        attemptId: previous.restartAttemptId, control, project: original.project,
        controlIdentity: original.controlIdentity, previousOperationId: original.previousOperationId,
        prepared: previous.restartPrepared, committed: previous.restartCommitted,
        newOwner: JSON.parse(published.bytes).newOwner, lockIdentity: previous.restartDirectory,
        lock: previous.restartOwner, state: original.state,
        owner: committedValue.creator, creator: retirer, createdAt: intent.createdAt,
      });
      snapshots.push({ file: retirementFile, bytes: retirementBytes, identity: retirementIdentity });
      // The ninth record is outside every observer this gate exposes; a fresh retirer must not duplicate it.
      await assert.rejects(observe(restartArgs(committedRequest)), committedRefused);
      await assert.rejects(observe(restartArgs({ ...committedRequest, retireRestart: true })), committedRefused);
      retirementPublished = true;
    }
    if (blockedState) {
      const committedRequest = { ...request, restartCommitted: previous.restartCommitted };
      const fixtureRefused = error => error.message.includes('Native restart observation fixture failed');
      await assert.rejects(observe(restartArgs(committedRequest)), fixtureRefused);
      const stateRequest = {
        ...committedRequest, restartStateIntent: previous.restartStateIntent, restartState: previous.restartState,
      };
      const stateExpected = {
        status: 'restart-state-observed', attemptId: previous.restartAttemptId,
        previousAttemptId: previous.successorAttemptId, previousOperationId: original.previousOperationId,
        project: original.project, prepared: previous.restartPrepared, committed: previous.restartCommitted,
        stateIntent: previous.restartStateIntent, state: previous.restartState,
        lockIdentity: previous.restartDirectory, lock: previous.restartOwner,
        runtimeAuthority: false, lockAuthority: false, taskAuthority: false,
      };
      const stateRefused = error => error.message.includes('Restart state observation failed; retain evidence.');
      for (let pass = 0; pass < 2; pass++) {
        if (blockedReleased || blockedReleaseIntent) {
          // After the dead owner's post-write release records, its lock and release records are outside every observer.
          await assert.rejects(observe(restartArgs(stateRequest)), stateRefused);
          continue;
        }
        const result = await observe(restartArgs(stateRequest));
        assert.equal(result.stderr, '');
        assert.deepEqual(JSON.parse(result.stdout), stateExpected);
      }
      const { restartState: _omitted, ...intentOnly } = stateRequest;
      await assert.rejects(observe(restartArgs(intentOnly)), fixtureRefused);
      for (const wrong of [
        { restartState: { ...stateRequest.restartState, ino: stateRequest.restartState.ino === '1' ? '2' : '1' } },
        { restartState: { ...original.state } },
        { restartStateIntent: { ...stateRequest.restartStateIntent, path: previous.restartCommitted.path } },
        { restartStateIntent: { ...stateRequest.restartStateIntent, ino: stateRequest.restartStateIntent.ino === '1' ? '2' : '1' } },
      ]) {
        await assert.rejects(observe(restartArgs({ ...stateRequest, ...wrong })), stateRefused);
      }
      if (blockedReleaseIntent) {
        // Archive-only dead-owner retirement is never valid after the acknowledged write, at any entrance.
        await assert.rejects(observe(restartArgs({ ...committedRequest, restartRetirement: previous.restartRelease })),
          error => error.message.includes('Restart lock retirement observation failed; retain evidence.'));
        await assert.rejects(observe(restartArgs({ ...stateRequest, restartRetirement: previous.restartRelease })));
        await assert.rejects(observe(restartArgs({ ...committedRequest, retireRestart: true })));
        releaseIntentRefused = true;
      } else if (blockedReleased) { releasedObserved = true; } else { stateObserved = true; }
    }
  } else {
    const first = await observe(args);
    assert.equal(first.stderr, '');
    assert.deepEqual(JSON.parse(first.stdout), expected);
    const wrong = args.slice();
    if (restart) {
      wrong[wrong.indexOf('-Request') + 1] = JSON.stringify({
        ...request, restart: { ...request.restart, ino: request.restart.ino === '1' ? '2' : '1' },
      });
    } else { wrong[wrong.indexOf('-AbandonedIno') + 1] = previous.successorAbandoned.ino === '1' ? '2' : '1'; }
    await assert.rejects(observe(wrong), refused);
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
  }
  await assert.rejects(observe(baseArgs),
    error => error.message.includes('Successor prepared observation failed; retain evidence.'));
  if (restart) {
    const record = JSON.parse(published.bytes);
    assert.equal(record.newOwner.pid, previous.actorPid);
    assert.equal(record.newOwner.processIdentity, previous.actorIdentity);
    assert.equal(record.attemptId, previous.restartAttemptId);
    assert.deepEqual(record.predecessor, expected.predecessor);
    await assert.rejects(observe(sixArgs),
      error => error.message.includes('Successor abandoned observation failed; retain evidence.'));
  }
  const { acquireLock, releaseLock, reconcileInterruptedOperation } = await load('state.mjs');
  await assert.rejects(acquireLock(control, { pwsh, admission, project: original.project, operationId: randomUUID() }));
  await assert.rejects(releaseLock(control, restart ? JSON.parse(published.bytes).newOwner : successor.newOwner, { pwsh, admission }));
  let reconciled = false;
  if (blockedState) {
    const report = await reconcileInterruptedOperation(control);
    const restartRecords = blockedReleased
      ? ['prepared', 'committed', 'lock-retirement', 'lock-retired', 'state-intent']
      : blockedReleaseIntent ? ['prepared', 'committed', 'lock-retirement', 'state-intent'] : ['prepared', 'committed', 'state-intent'];
    assert.deepEqual(report, {
      status: 'blocked', operationId: JSON.parse(writtenState).operationId, phase: 'preflight',
      message: 'Service, task or worker retirement evidence exists. Retain it; inspect before restart or recovery.',
      handoff: {
        authority: false,
        attempts: [
          { attemptId: previous.attemptId, records: ['prepared', 'committed', 'lock-retirement', 'lock-retired'],
            status: 'lock-settled' },
          { attemptId: previous.successorAttemptId, records: ['prepared', 'abandoned'], status: 'abandoned' },
          { attemptId: previous.restartAttemptId, records: restartRecords, status: 'state-transition' },
        ].sort((left, right) => left.attemptId < right.attemptId ? -1 : 1),
        unrecognized: [],
      },
    });
    assert.equal(snapshots.length, blockedReleased ? 11 : blockedReleaseIntent ? 10 : 9);
    if (!blockedReleased && !blockedReleaseIntent) { reconciled = true; }
  }
  if (retirementPublished || retirementObserved) {
    const report = await reconcileInterruptedOperation(control);
    assert.equal(report.status, 'blocked');
    assert.equal(report.operationId, JSON.parse(state).operationId);
    assert.deepEqual(report.handoff, {
      authority: false,
      attempts: [
        { attemptId: previous.attemptId, records: ['prepared', 'committed', 'lock-retirement', 'lock-retired'],
          status: 'lock-settled' },
        { attemptId: previous.successorAttemptId, records: ['prepared', 'abandoned'], status: 'abandoned' },
        { attemptId: previous.restartAttemptId,
          records: ['prepared', 'committed', 'lock-retirement', ...(retirementObserved ? ['lock-retired'] : [])],
          status: retirementObserved ? 'lock-settled' : 'lock-retiring' },
      ].sort((left, right) => left.attemptId < right.attemptId ? -1 : 1),
      unrecognized: [],
    });
    assert.equal(snapshots.length, retirementObserved ? 10 : 9);
  }
  if (blockedReleased && !blockedState) {
    const report = await reconcileInterruptedOperation(control);
    assert.equal(report.status, 'blocked');
    assert.equal(report.operationId, JSON.parse(state).operationId);
    assert.deepEqual(report.handoff, {
      authority: false,
      attempts: [
        { attemptId: previous.attemptId, records: ['prepared', 'committed', 'lock-retirement', 'lock-retired'],
          status: 'lock-settled' },
        { attemptId: previous.successorAttemptId, records: ['prepared', 'abandoned'], status: 'abandoned' },
        { attemptId: previous.restartAttemptId, records: ['prepared', 'committed', 'lock-retirement', 'lock-retired'],
          status: 'lock-settled' },
      ].sort((left, right) => left.attemptId < right.attemptId ? -1 : 1),
      unrecognized: [],
    });
    assert.equal(snapshots.length, 10);
  }
  for (const snapshot of [...snapshots, ...(ownerSnapshot ? [ownerSnapshot] : [])]) {
    assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
    const current = await lstat(snapshot.file, { bigint: true });
    assert.equal(current.dev, snapshot.identity.dev);
    assert.equal(current.ino, snapshot.identity.ino);
    if (snapshot === ownerSnapshot) { assert.equal(current.nlink, 1n); }
  }
  assert.deepEqual((await readdir(control)).filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort(),
    snapshots.map(snapshot => path.basename(snapshot.file)).sort());
  for (const [file, bytes, originalIdentity] of [
    [stateFile, writtenState ?? state, stateIdentity], [completionFile, completionBytes, completionIdentity],
  ]) {
    assert.deepEqual(await readFile(file), bytes);
    const current = await lstat(file, { bigint: true });
    assert.equal(current.dev, originalIdentity.dev);
    assert.equal(current.ino, originalIdentity.ino);
  }
  if (blockedDirectory && !blockedReleased && !blockedRetirement && !(blockedReleaseIntent && !blockedState)) {
    const current = await lstat(directory, { bigint: true });
    assert.equal(current.dev.toString(), previous.restartDirectory.dev);
    assert.equal(current.ino.toString(), previous.restartDirectory.ino);
    assert.deepEqual(await readdir(directory), ownerSnapshot ? ['owner.json'] : []);
    if (ownerSnapshot) { await unlink(ownerSnapshot.file); }
    await rmdir(directory);
  } else { await assert.rejects(lstat(directory), { code: 'ENOENT' }); }
  if (restart) {
    for (const snapshot of snapshots.reverse()) await unlink(snapshot.file);
    if (writtenState) { await writeFile(stateFile, state); }
    if (committedObserved) {
      console.log('PASS: distinct restart committed observer proves eight records dead owner and directory without state lock or task authority');
    }
    if (reconciled) {
      console.log('PASS: ordinary reconciliation reports nine exact handoff records as three attempts while staying blocked without authority');
    }
    if (stateObserved) {
      console.log('PASS: distinct restart state observer resolves original state only through its ninth record and proves the exact written state without lock or task authority');
    }
    if (retirementPublished) {
      console.log('PASS: distinct restart lock retirer proves the committed owner dead and publishes only its exact retirement intent while lock and original state remain without authority');
      console.log('PASS: ordinary reconciliation reports the dead restart attempt as lock-retiring while staying blocked without authority');
    }
    if (retirementObserved) {
      console.log('PASS: distinct restart lock retirement observer proves the retirer and owner dead from the exact intent and refuses a duplicate without authority');
      console.log('PASS: distinct restart lock owner retirer deletes only the dead owner file from the exact intent and preserves its empty directory without authority');
      console.log('PASS: fresh restart lock retirement observer takes over the owner-retired stage from the exact intent and retires only its empty directory without authority');
      console.log('PASS: fresh restart lock retirement observer takes over the absent directory from the exact intent and publishes only its exact settlement without authority');
      console.log('PASS: fresh restart lock retirement observer takes over the settled stage from its exact record and refuses a duplicate settlement without authority');
      console.log('PASS: ordinary reconciliation reports the settled dead restart retirement as lock-settled while staying blocked without authority');
    }
    if (releasedObserved) {
      console.log(blockedState
        ? 'PASS: ordinary reconciliation reports the post-write released restart attempt as a state transition while staying blocked without authority'
        : 'PASS: ordinary reconciliation reports the released restart attempt as lock-settled while staying blocked without authority');
    }
    if (releaseIntentRefused) {
      console.log('PASS: ordinary reconciliation reports the dead post-write release intent as a state transition while staying blocked without authority');
    }
    console.log(blockedReleaseIntent && blockedState
      ? 'PASS: actual post-write restart releaser death after its exact release intent preserves ten records written state owner and directory and refuses archive-only lock retirement without authority'
      : blockedReleaseIntent
      ? 'PASS: actual restart releaser death after its exact release intent lets distinct fresh actors retire and settle only the dead owner lock without authority'
      : blockedRetirement
      ? 'PASS: actual restart lock retirer death preserves its exact intent dead owner and directory for a distinct observer without deletion authority'
      : blockedReleased && blockedState
      ? 'PASS: actual post-write restart releaser death preserves eleven records and written state for a distinct observer without authority'
      : blockedReleased
      ? 'PASS: actual restart releaser death after exact lock release preserves ten records and original state for a distinct observer without authority'
      : blockedState
      ? 'PASS: actual restart state writer death preserves its written state nine records owner and directory for a distinct observer without authority'
      : blockedCommitted
      ? 'PASS: actual fresh restart committed publisher death preserves its exact eighth record owner directory and seven records without state authority'
      : blockedOwner
      ? 'PASS: actual fresh restart owner publisher death preserves its exact owner directory and seven records without committed authority'
      : blockedDirectory
      ? 'PASS: actual fresh restart directory publisher death preserves the exact incomplete directory and seven records without continuation authority'
      : 'PASS: actual fresh restart publisher death preserves seven exact records for a distinct eleventh native observer without continuation authority');
  } else {
    console.log('PASS: actual successor abandonment publisher death preserves six exact records for a distinct ninth native observer without continuation authority');
    console.log(`INACTIVE_HISTORY_SUCCESSOR_ABANDONED_OBSERVED ${JSON.stringify({
      ...previous, settledObserverActor: { actorPid: process.pid, actorIdentity: identity },
    })}`);
  }
}
