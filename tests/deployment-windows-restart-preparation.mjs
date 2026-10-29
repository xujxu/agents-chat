import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, readdir, unlink, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fixtureArgs, descriptorArgs } from './deployment-windows-lock-retirement-observation.mjs';
import { assertRestartOwnerPublication } from './deployment-windows-restart-owner-publication.mjs';
import { assertRestartPublicationProofs } from './deployment-windows-restart-publication-progress.mjs';
import { assertRestartCommitPublication } from './deployment-windows-restart-commit-publication.mjs';
import { assertRestartStateIntentPublication } from './deployment-windows-restart-state-intent-publication.mjs';
import { assertRestartStateWritePublication } from './deployment-windows-restart-state-write-publication.mjs';
import { assertRestartReleasePublication } from './deployment-windows-restart-release-publication.mjs';

export async function assertRestartPreparation({
  source, control, pwsh, admission, previous, state, completionBytes, publish = false, hold = false,
  createDirectory = false, holdDirectory = false, publishOwner = false, holdOwner = false, commitRestart = false,
  holdCommitted = false, prepareState = false, writeState = false, holdState = false,
  releaseRestart = false,
}) {
  assert.ok(!hold || publish);
  assert.ok(!createDirectory || (publish && !hold));
  assert.ok(!holdDirectory || createDirectory);
  assert.ok(!publishOwner || (createDirectory && !holdDirectory));
  assert.ok(!holdOwner || publishOwner);
  assert.ok(!commitRestart || (publishOwner && !holdOwner));
  assert.ok(!holdCommitted || commitRestart);
  assert.ok(!prepareState || (commitRestart && !holdCommitted));
  assert.ok(!writeState || prepareState);
  assert.ok(!holdState || writeState);
  assert.ok(!releaseRestart || (commitRestart && !holdCommitted && !prepareState));
  const held = hold || holdDirectory || holdOwner || holdCommitted || holdState;
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
    ...(publish ? ['-PublishRestart'] : []), ...(hold ? ['-Hold'] : []),
    ...(createDirectory ? ['-CreateRestartDirectory'] : []), ...(holdDirectory ? ['-HoldRestartDirectory'] : []),
    ...(publishOwner ? ['-PublishRestartOwner'] : []), ...(holdOwner ? ['-HoldRestartOwner'] : []),
    ...(commitRestart ? ['-CommitRestart'] : []), ...(holdCommitted ? ['-HoldRestartCommitted'] : []),
    ...(prepareState ? ['-PrepareRestartState'] : []), ...(writeState ? ['-WriteRestartState'] : []), ...(holdState ? ['-HoldRestartState'] : []),
    ...(releaseRestart ? ['-ReleaseRestart'] : [])];
  let phase;
  const phases = [];
  const enterPhase = value => {
    phase = value;
    phases.push({ phase, at: new Date().toISOString() });
  };
  enterPhase('bootstrap-observation');
  const transport = windowsControllerTransport({
    pwsh, label: 'Fresh native restart preparation fixture',
    refused: cause => Object.assign(
      new Error(`Fresh native restart preparation fixture failed during ${phase}.`, { cause }), { phases }),
    args: nativeArgs,
  });
  let diagnostic = '';
  let owner;
  let heldPublication;
  let directoryIdentity;
  let controllerWire;
  let ownerSnapshot;
  let writtenState;
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
    enterPhase('restart-preparation');
    await transport.wire.send({ type: 'prepare' });
    const response = await transport.wire.receive({ timeoutMs: 45000 });
    let value = response;
    if (hold || createDirectory) {
      const frame = captureWorkerFields(response,
        ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held restart publication');
      assert.equal(frame.type, hold ? 'ready' : 'restart-published');
      assert.equal(frame.pid, ready.pid);
      assert.equal(frame.processIdentity, ready.processIdentity);
      assert.equal(frame.processIdentity, await processIdentity(frame.pid));
      assert.equal(frame.control, control);
      assert.equal(frame.controllerIdentity, identity);
      value = frame.value;
    }
    const publication = publish ? captureWorkerFields(value, ['prepared', 'record'], 'restart publication') : null;
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
    if (!hold && !createDirectory) {
      enterPhase('preparation-exit');
      assert.deepEqual(await transport.waitForExit(), { code: 0, signal: null });
      transport.wire.close();
    }
    assert.equal(diagnostic, '');
    if (publication) {
      enterPhase('published-record-validation');
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
      if (held) {
        heldPublication = {
          ...previous, abandonmentPublisherActor: {
            actorPid: previous.actorPid, actorIdentity: previous.actorIdentity,
            pid: previous.pid, processIdentity: previous.processIdentity,
          },
          restartPrepared: descriptor, restartAttemptId: record.attemptId,
          actorPid: process.pid, actorIdentity: identity, pid: ready.pid, processIdentity: ready.processIdentity,
        };
      }
      if (createDirectory) {
        enterPhase('host-directory-command');
        const { workerWire } = await load('worker-wire.mjs');
        controllerWire = workerWire(process.stdin);
        try {
          console.log(`INACTIVE_HISTORY_RESTART_PREPARED_LIVE ${JSON.stringify({
            actorPid: process.pid, actorIdentity: identity, pid: ready.pid,
            processIdentity: ready.processIdentity, prepared: descriptor,
          })}`);
          const command = captureWorkerFields(await controllerWire.receive({ timeoutMs: 45000 }),
            ['type'], 'restart directory controller command');
          assert.equal(command.type, 'create-directory');
        } finally { if (!publishOwner) controllerWire.close(); }
        enterPhase('restart-directory-publication');
        await transport.wire.send({ type: 'create-directory' });
        await assertRestartPublicationProofs({
          publication: 'directory', transport, ready, control, identity, captureWorkerFields, enterPhase,
        });
        let directoryResponse = await transport.wire.receive({ timeoutMs: 45000 });
        if (holdDirectory || publishOwner) {
          const frame = captureWorkerFields(directoryResponse,
            ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held restart directory');
          assert.equal(frame.type, holdDirectory ? 'ready' : 'restart-directory-published');
          assert.equal(frame.pid, ready.pid);
          assert.equal(frame.processIdentity, ready.processIdentity);
          assert.equal(frame.processIdentity, await processIdentity(frame.pid));
          assert.equal(frame.control, control);
          assert.equal(frame.controllerIdentity, identity);
          directoryResponse = frame.value;
        }
        const directory = captureWorkerFields(directoryResponse,
          ['status', 'attemptId', 'prepared', 'directory', 'runtimeAuthority', 'lockAuthority'],
          'restart directory publication');
        directoryIdentity = captureWorkerFields(directory.directory, ['dev', 'ino'], 'restart directory identity');
        assert.deepEqual(directory, {
          status: 'restart-lock-directory', attemptId: record.attemptId, prepared: descriptor,
          directory: directoryIdentity, runtimeAuthority: false, lockAuthority: false,
        });
        if (publishOwner) {
          try {
            ownerSnapshot = await assertRestartOwnerPublication({
              control, identity, ready, record, prepared: descriptor, directory: directoryIdentity,
              transport, controllerWire, captureWorkerFields, enterPhase, holdOwner, processIdentity, commitRestart,
            });
          } finally { if (!commitRestart) controllerWire.close(); }
        }
        if (commitRestart) {
          try {
            const committedSnapshot = await assertRestartCommitPublication({
              control, identity, ready, original, record, prepared: descriptor, directory: directoryIdentity,
              owner: ownerSnapshot.descriptor, transport, controllerWire, captureWorkerFields, enterPhase,
              holdCommitted, processIdentity, prepareState: prepareState || releaseRestart,
            });
            snapshots.push(committedSnapshot);
            if (releaseRestart) {
              snapshots.push(...await assertRestartReleasePublication({
                control, identity, ready, original, record, prepared: descriptor, committed: committedSnapshot.descriptor,
                directory: directoryIdentity, owner: ownerSnapshot.descriptor, transport, controllerWire,
                captureWorkerFields, enterPhase,
              }));
            }
            if (holdCommitted || holdState) { heldPublication.restartCommitted = committedSnapshot.descriptor; }
            if (prepareState) {
              const { validateState } = await load('state.mjs');
              const intentSnapshot = await assertRestartStateIntentPublication({
                control, identity, ready, original, record, prepared: descriptor, committed: committedSnapshot.descriptor,
                directory: directoryIdentity, owner: ownerSnapshot.descriptor, transport, controllerWire,
                captureWorkerFields, enterPhase, validateState, writeState, processIdentity,
              });
              snapshots.push(intentSnapshot);
              if (writeState) {
                writtenState = await assertRestartStateWritePublication({
                  control, identity, ready, record, intent: intentSnapshot, transport, controllerWire,
                  captureWorkerFields, enterPhase, holdState, processIdentity,
                });
                if (holdState) {
                  heldPublication.restartStateIntent = intentSnapshot.descriptor;
                  heldPublication.restartState = writtenState.descriptor;
                }
              }
            }
          } finally { controllerWire.close(); }
        }
        if (holdDirectory || holdOwner || holdCommitted || holdState) {
          heldPublication.restartDirectory = directoryIdentity;
          if (holdOwner || holdCommitted || holdState) { heldPublication.restartOwner = ownerSnapshot.descriptor; }
        } else {
          enterPhase(releaseRestart ? 'release-exit' : writeState ? 'state-write-exit' : prepareState ? 'state-intent-exit' : commitRestart ? 'committed-exit' : 'directory-exit');
          assert.deepEqual(await transport.waitForExit(), { code: 0, signal: null });
          assert.equal(diagnostic, '');
          transport.wire.close();
        }
      }
    }
  } catch (cause) {
    controllerWire?.close();
    const error = await transport.abandon(cause);
    if (error.diagnostic) console.error(error.diagnostic);
    throw error;
  }
  const { acquireLock, releaseLock } = await load('state.mjs');
  if (publish && !held) {
    await assert.rejects(promisify(execFile)(pwsh,
      nativeArgs.filter(arg => !['-PrepareRestart', '-PublishRestart', '-CreateRestartDirectory', '-PublishRestartOwner', '-CommitRestart', '-PrepareRestartState', '-WriteRestartState', '-ReleaseRestart'].includes(arg)),
      { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
    error => error.message.includes('Successor abandoned observation failed; retain evidence.'));
  }
  if (!held) {
    await assert.rejects(acquireLock(control, { pwsh, admission, project: original.project, operationId: randomUUID() }));
    await assert.rejects(releaseLock(control, owner, { pwsh, admission }));
  }
  for (const snapshot of [...snapshots, ...(ownerSnapshot && !releaseRestart ? [ownerSnapshot] : [])]) {
    assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
    const current = await lstat(snapshot.file, { bigint: true });
    assert.equal(current.dev, snapshot.identity.dev);
    assert.equal(current.ino, snapshot.identity.ino);
  }
  assert.deepEqual((await readdir(control)).filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort(),
    snapshots.map(snapshot => path.basename(snapshot.file)).sort());
  if (writtenState) {
    assert.deepEqual(await readFile(stateFile), writtenState.bytes);
    const current = await lstat(stateFile, { bigint: true });
    assert.equal(current.dev, writtenState.identity.dev);
    assert.equal(current.ino, writtenState.identity.ino);
  }
  for (const [file, bytes, originalIdentity] of [
    ...(writtenState ? [] : [[stateFile, state, stateIdentity]]), [completionFile, completionBytes, completionIdentity],
  ]) {
    assert.deepEqual(await readFile(file), bytes);
    const current = await lstat(file, { bigint: true });
    assert.equal(current.dev, originalIdentity.dev);
    assert.equal(current.ino, originalIdentity.ino);
  }
  const directory = path.join(control, 'lock');
  if (releaseRestart) {
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
  } else if (createDirectory) {
    const current = await lstat(directory, { bigint: true });
    assert.ok(current.isDirectory());
    assert.equal(current.dev.toString(), directoryIdentity.dev);
    assert.equal(current.ino.toString(), directoryIdentity.ino);
    assert.deepEqual(await readdir(directory), publishOwner ? ['owner.json'] : []);
    if (ownerSnapshot && !held) { await unlink(ownerSnapshot.file); }
    if (!held) { await rmdir(directory); }
  } else { await assert.rejects(lstat(directory), { code: 'ENOENT' }); }
  if (held) {
    const marker = holdState ? 'INACTIVE_HISTORY_RESTART_STATE_HELD'
      : holdCommitted ? 'INACTIVE_HISTORY_RESTART_COMMITTED_HELD'
      : holdOwner ? 'INACTIVE_HISTORY_RESTART_OWNER_HELD'
      : holdDirectory ? 'INACTIVE_HISTORY_RESTART_DIRECTORY_HELD' : 'INACTIVE_HISTORY_RESTART_PREPARED_HELD';
    console.log(`${marker} ${JSON.stringify(heldPublication)}`);
    const timer = setInterval(() => {}, 1000);
    try { await new Promise(() => {}); } finally { clearInterval(timer); }
  }
  for (const snapshot of snapshots.reverse()) await unlink(snapshot.file);
  if (writtenState) { await writeFile(stateFile, state); }
  console.log(releaseRestart
    ? 'PASS: native live restart owner releases only its exact committed lock before any state write while original state and eight records remain exact without authority'
    : writeState
    ? 'PASS: native restart state write publishes exactly its ninth-record next state through one acknowledged stage without runtime lock or task authority'
    : prepareState
    ? 'PASS: native restart state intent binds exact old and next preflight state after its eighth record without writing state or granting authority'
    : commitRestart
    ? 'PASS: native restart commitment pins its exact live owner and eighth record while copied evidence ordinary authority and duplicate publication remain refused'
    : publishOwner
    ? 'PASS: native restart owner publication pins only its exact fresh live owner while ordinary authority and duplicate publication remain refused'
    : createDirectory
    ? 'PASS: native restart lock directory publication pins only its exact fresh live preparation without owner committed or state authority'
    : publish
    ? 'PASS: native restart publication creates one exact seventh preparation while duplicate publication and ordinary authority remain refused'
    : 'PASS: native restart preparation derives a fresh live owner bound to settled six-record evidence without publication or authority');
}
