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
  releaseRestart = false, holdReleased = false, holdReleaseIntent = false, refuseAdmission = false,
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
  assert.ok(!releaseRestart || (commitRestart && !holdCommitted && (!prepareState || (writeState && !holdState))));
  assert.ok(!holdReleased || releaseRestart);
  assert.ok(!holdReleaseIntent || (releaseRestart && !holdReleased));
  assert.ok(!refuseAdmission || (writeState && !holdState && !releaseRestart));
  const held = hold || holdDirectory || holdOwner || holdCommitted || holdState || holdReleased || holdReleaseIntent;
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
    ...(releaseRestart ? ['-ReleaseRestart'] : []), ...(holdReleased ? ['-HoldRestartReleased'] : []),
    ...(holdReleaseIntent ? ['-HoldRestartReleaseIntent'] : [])];
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
  let restartHandoff;
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
            if (releaseRestart && !writeState) {
              const releaseSnapshots = await assertRestartReleasePublication({
                control, identity, ready, original, record, prepared: descriptor, committed: committedSnapshot.descriptor,
                directory: directoryIdentity, owner: ownerSnapshot.descriptor, transport, controllerWire,
                captureWorkerFields, enterPhase, holdReleased, holdIntent: holdReleaseIntent, processIdentity,
              });
              snapshots.push(...releaseSnapshots);
              if (holdReleased) {
                [heldPublication.restartRelease, heldPublication.restartReleased] =
                  releaseSnapshots.map(snapshot => snapshot.descriptor);
              }
              if (holdReleaseIntent) { heldPublication.restartRelease = releaseSnapshots[0].descriptor; }
            }
            if (holdCommitted || holdState || holdReleased || holdReleaseIntent) { heldPublication.restartCommitted = committedSnapshot.descriptor; }
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
                  captureWorkerFields, enterPhase, holdState, releaseRestart, processIdentity,
                });
                restartHandoff = {
                  restart: descriptor, restartCommitted: committedSnapshot.descriptor,
                  restartStateIntent: intentSnapshot.descriptor, restartState: writtenState.descriptor,
                };
                if (releaseRestart) {
                  const releaseSnapshots = await assertRestartReleasePublication({
                    control, identity, ready, original, record, prepared: descriptor, committed: committedSnapshot.descriptor,
                    directory: directoryIdentity, owner: ownerSnapshot.descriptor, transport, controllerWire,
                    captureWorkerFields, enterPhase, holdReleased, holdIntent: holdReleaseIntent, processIdentity,
                    stateIntent: intentSnapshot.descriptor, writtenState: writtenState.descriptor,
                  });
                  snapshots.push(...releaseSnapshots);
                  if (holdReleaseIntent) {
                    heldPublication.restartRelease = releaseSnapshots[0].descriptor;
                    heldPublication.restartStateIntent = intentSnapshot.descriptor;
                    heldPublication.restartState = writtenState.descriptor;
                  }
                  if (holdReleased) {
                    [heldPublication.restartRelease, heldPublication.restartReleased] =
                      releaseSnapshots.map(snapshot => snapshot.descriptor);
                    heldPublication.restartStateIntent = intentSnapshot.descriptor;
                    heldPublication.restartState = writtenState.descriptor;
                  }
                }
                if (holdState) {
                  heldPublication.restartStateIntent = intentSnapshot.descriptor;
                  heldPublication.restartState = writtenState.descriptor;
                }
              }
            }
          } finally { controllerWire.close(); }
        }
        if (holdDirectory || holdOwner || holdCommitted || holdState || holdReleased || holdReleaseIntent) {
          heldPublication.restartDirectory = directoryIdentity;
          if (holdOwner || holdCommitted || holdState || holdReleased || holdReleaseIntent) { heldPublication.restartOwner = ownerSnapshot.descriptor; }
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
  if (refuseAdmission) {
    // The exact live owner holds its committed lock and written preflight, yet ordinary inactive admission
    // must not bypass the handoff verifier while handoff evidence remains.
    const {
      inspectWindowsInactiveTask, inspectWindowsInactiveTaskHandoff, captureWindowsInactiveTaskAdmission,
      captureWindowsInactiveTaskHandoffAdmission,
      assertWindowsInactiveTaskAdmissionBinding,
    } = await load('windows-managed-task.mjs');
    const { createWindowsInactiveTaskAdmissionRecord } = await load('windows-inactive-task-admission.mjs');
    const ordinaryRefusal = error => /requires its handoff-aware admission/.test(`${error.message} ${error.cause?.message ?? ''}`);
    const maintenance = path.join(control, 'task-maintenance');
    const handoff = {
      attemptId: previous.attemptId, prepared: previous.prepared, committed: previous.committed,
      retirement: previous.retirement, terminal: previous.terminal, successor: previous.successor,
      abandoned: previous.successorAbandoned, ...restartHandoff,
    };
    // The released rollback relocated readiness out of the task action bundle, so ordinary inspection refuses and
    // only the proved handoff observation reaches the physical bundle.
    await assert.rejects(inspectWindowsInactiveTask({ taskName: original.observation.taskName, project: original.project, pwsh }),
      { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
    const open = async () => {
      const scope = await inspectWindowsInactiveTaskHandoff({
        taskName: original.observation.taskName, project: original.project, pwsh, control, handoff,
      });
      assert.deepEqual(JSON.parse(JSON.stringify(scope.observation)), original.observation);
      return scope;
    };
    for (const copied of [
      { ...handoff, restartState: { ...handoff.restartState, sha256: '0'.repeat(64) } },
      { ...handoff, restartCommitted: handoff.committed },
      { ...handoff, restartStateIntent: undefined },
    ]) {
      const scope = await open();
      try {
        await assert.rejects(captureWindowsInactiveTaskAdmission({ scope, control, lock: owner, admission }), ordinaryRefusal);
        await assert.rejects(captureWindowsInactiveTaskHandoffAdmission({ scope, control, lock: owner, admission, handoff: copied }),
          { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
      } finally { await scope.close(); }
      await assert.rejects(lstat(maintenance), { code: 'ENOENT' });
    }
    const scope = await open();
    let published;
    let activationPrepared;
    let replacedDefinition;
    let activatedRuntime;
    let healthMode;
    let completedRuntime = false;
    let completedStateSha256;
    let retirementPrepared = false;
    try {
      await assert.rejects(captureWindowsInactiveTaskHandoffAdmission({
        scope, control, lock: { ...owner, token: randomUUID() }, admission, handoff,
      }));
      await assert.rejects(lstat(maintenance), { code: 'ENOENT' });
      // The restart operation publishes its distinct runtime bundle at preflight through the handoff-aware scope.
      const { prepareWindowsInactiveRuntimeBundle } = await load('windows-runtime-publication.mjs');
      const bundleInput = { scope, control, lock: owner, node: process.execPath, pwsh };
      await assert.rejects(prepareWindowsInactiveRuntimeBundle({ ...bundleInput, scope: { ...scope } }));
      const bundle = await prepareWindowsInactiveRuntimeBundle(bundleInput);
      assert.deepEqual(bundle, {
        directory: path.join(control, `runtime-${owner.operationId}`),
        configuration: path.join(control, `runtime-${owner.operationId}`, 'configuration.json'),
        sha256: original.observation.configurationSha256,
      });
      const result = await captureWindowsInactiveTaskHandoffAdmission({ scope, control, lock: owner, admission, handoff });
      assert.deepEqual(Object.keys(result).sort(), ['admission', 'sha256']);
      assert.equal(result.admission, path.join(maintenance, 'admission.json'));
      assert.deepEqual(await readdir(maintenance), ['admission.json']);
      const bytes = await readFile(result.admission);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
      assert.deepEqual(JSON.parse(bytes), createWindowsInactiveTaskAdmissionRecord({
        observation: original.observation, lock: owner, state: JSON.parse(writtenState.bytes),
      }));
      const binding = await assertWindowsInactiveTaskAdmissionBinding({
        scope, control, lock: owner, admission: result.admission, sha256: result.sha256,
      });
      const { validateState } = await load('state.mjs');
      assert.deepEqual(binding.state, { ...validateState(JSON.parse(writtenState.bytes)) });
      await assert.rejects(captureWindowsInactiveTaskAdmission({ scope, control, lock: owner, admission }), ordinaryRefusal);
      await assert.rejects(captureWindowsInactiveTaskHandoffAdmission({ scope, control, lock: owner, admission, handoff }));
      assert.deepEqual(await readFile(result.admission), bytes);
      assert.deepEqual(await readdir(maintenance), ['admission.json']);
      published = result.admission;
      // Subsequent states use the existing inactive transaction checks through the handoff-aware scope.
      const { writeState: writeDeploymentState } = await load('state.mjs');
      const { beginWindowsInactiveTaskTransaction, assertWindowsInactiveTaskSnapshotStage } =
        await load('windows-inactive-task-transaction.mjs');
      const transactionOptions = { scope, control, lock: owner, ...result };
      await assert.rejects(beginWindowsInactiveTaskTransaction(transactionOptions), /stopped-phase transaction/);
      const written = JSON.parse(writtenState.bytes);
      // The snapshot binds the archived project's actual Git HEAD as its observed source.
      const head = await promisify(execFile)('git', ['-C', original.project, 'rev-parse', 'HEAD'], { timeout: 30000 });
      const sourceCommit = written.sourceCommit ?? head.stdout.trim();
      assert.match(sourceCommit, /^[a-f0-9]{40}$/);
      const stopped = {
        ...written, phase: 'stopped', previousPhase: 'preflight', sourceCommit,
        targetCommit: written.targetCommit ?? 'b'.repeat(40),
      };
      await writeDeploymentState(control, stopped);
      await assert.rejects(beginWindowsInactiveTaskTransaction({ ...transactionOptions, scope: { ...scope } }));
      await assert.rejects(beginWindowsInactiveTaskTransaction({ ...transactionOptions, sha256: '0'.repeat(64) }));
      const transaction = await beginWindowsInactiveTaskTransaction(transactionOptions);
      assert.deepEqual(await transaction.check(), validateState(stopped));
      await assert.rejects(beginWindowsInactiveTaskTransaction(transactionOptions), /transaction consumer/);
      const snapshotOptions = { context: transaction, control, lock: owner, sourceCommit };
      await assert.rejects(assertWindowsInactiveTaskSnapshotStage(snapshotOptions), /copying/);
      await writeDeploymentState(control, { ...stopped, phase: 'copying', previousPhase: 'stopped' });
      const metadata = await assertWindowsInactiveTaskSnapshotStage(snapshotOptions);
      assert.deepEqual(metadata, {
        project: owner.project, sourceCommit, task: {
          version: 1, name: original.observation.taskName, definition: original.observation.definition,
          securityDescriptor: original.observation.securityDescriptor,
          configuration: original.observation.configuration,
          configurationSha256: original.observation.configurationSha256,
        },
      });
      await assert.rejects(assertWindowsInactiveTaskSnapshotStage({ ...snapshotOptions, context: { ...transaction } }));
      // The handoff-aware transaction snapshots, rotates and prepares activation with its own operation bundle.
      const { inspectWindowsInactiveConfiguration } = await load('windows-configuration.mjs');
      const { createWindowsInactiveTaskSnapshot } = await load('windows-task-snapshot.mjs');
      const { verifySnapshot } = await load('snapshot.mjs');
      const { saveRecoveryEngine } = await load('saved-recovery-engine.mjs');
      const { rotateWindowsInactiveTaskSnapshot, prepareWindowsInactiveTaskActivation } =
        await load('windows-inactive-task-transaction.mjs');
      const recovery = await saveRecoveryEngine({ source, control, allowVersionChange: true });
      // The archived project keeps its configured sources; inspect them through the handoff scope.
      await assert.rejects(inspectWindowsInactiveConfiguration({ scope: { ...scope }, pwsh, profile: 'agents-chat-auth-638c553' }));
      const configuration = await inspectWindowsInactiveConfiguration({ scope, pwsh, profile: 'agents-chat-auth-638c553' });
      try {
        const manifest = await createWindowsInactiveTaskSnapshot({
          context: transaction, control, lock: owner, pwsh, destination: path.join(control, 'staging'),
          id: 'handoff-transaction-snapshot', source: { commit: sourceCommit, provenance: 'observed' },
          recoveryEngine: recovery.manifestSha256, configuration,
        });
        assert.deepEqual(manifest.runtime, { platform: 'win32', state: 'stopped', task: metadata.task });
        const rotating = { ...stopped, phase: 'rotating', previousPhase: 'copying', backupId: manifest.id };
        await writeDeploymentState(control, rotating);
        await transaction.check();
        await rotateWindowsInactiveTaskSnapshot({ context: transaction, control, lock: owner });
        assert.deepEqual(await verifySnapshot(path.join(control, 'backup')), manifest);
        let previousPhase = 'rotating';
        for (const phase of ['backup-ready', 'source-selected', 'dependencies', 'building', 'configuring', 'activating']) {
          await writeDeploymentState(control, { ...rotating, phase, previousPhase });
          await transaction.check();
          previousPhase = phase;
        }
        await configuration.checkFiles();
        const preparationOptions = { context: transaction, control, lock: owner, bundle };
        await assert.rejects(prepareWindowsInactiveTaskActivation({ ...preparationOptions, context: { ...transaction } }));
        const preparation = await prepareWindowsInactiveTaskActivation(preparationOptions);
        const intent = JSON.parse(await readFile(preparation.file));
        assert.equal(intent.phase, 'activation-prepared');
        assert.equal(intent.admissionSha256, result.sha256);
        assert.equal(intent.definition, original.observation.definition);
        assert.equal(intent.configuration, bundle.configuration);
        await assert.rejects(prepareWindowsInactiveTaskActivation(preparationOptions));
        assert.deepEqual(await readdir(maintenance), ['admission.json', 'inactive-activation-prepared.json']);
        activationPrepared = preparation.file;
        // The prepared handoff transaction replaces the inhibited task with its operation bundle.
        const { replaceWindowsInactiveTask } = await load('windows-inactive-task-transaction.mjs');
        const replacementOptions = { context: transaction, control, lock: owner };
        await assert.rejects(replaceWindowsInactiveTask({ ...replacementOptions, context: { ...transaction } }));
        replacedDefinition = original.observation.definition;
        const replacement = await replaceWindowsInactiveTask(replacementOptions);
        assert.equal(replacement.replaced, true);
        assert.equal(replacement.inhibited, true);
        const replaced = JSON.parse(await readFile(replacement.file));
        assert.equal(replaced.phase, 'replacement-complete');
        assert.equal(replaced.preparationSha256, preparation.sha256);
        assert.equal(replaced.originalDefinition, original.observation.definition);
        assert.equal(replaced.configuration, bundle.configuration);
        assert.ok(replacement.definition.includes(bundle.configuration));
        await assert.rejects(replaceWindowsInactiveTask(replacementOptions));
        assert.deepEqual((await readdir(maintenance)).sort(), ['admission.json', 'inactive-activation-prepared.json',
          'inactive-replacement-complete.json', 'inactive-replacement-requested.json']);
        // The replaced handoff transaction starts one distinct guarded runtime from its operation bundle.
        const { startWindowsInactiveTask } = await load('windows-inactive-task-transaction.mjs');
        await assert.rejects(startWindowsInactiveTask({ ...replacementOptions, context: { ...transaction } }));
        const listenerFile = path.join(original.project, 'listener.json');
        const previousListener = JSON.parse(await readFile(listenerFile, 'utf8'));
        const active = await startWindowsInactiveTask(replacementOptions);
        activatedRuntime = active.runtime;
        assert.equal(active.status, 'guarded-running');
        assert.equal(active.taskName, original.observation.taskName);
        assert.notEqual(active.runtime.identity, original.observation.retiredRuntime.identity);
        assert.notEqual(active.runtime.generation, original.observation.retiredRuntime.generation);
        assert.equal(active.runtime.configurationSha256, bundle.sha256);
        await transaction.check();
        await assert.rejects(startWindowsInactiveTask(replacementOptions));
        const running = JSON.parse(await readFile(path.join(maintenance, 'inactive-start-running.json')));
        assert.equal(running.preparationSha256, preparation.sha256);
        assert.equal(running.configuration, bundle.configuration);
        assert.deepEqual(running.runtime, active.runtime);
        // Readiness verifies HTTP providers only through the handoff transaction's retained Job listener.
        await assert.rejects(transaction.listener({ port: 0 }));
        let listener;
        const listenerDeadline = Date.now() + 30000;
        do {
          listener = JSON.parse(await readFile(listenerFile, 'utf8'));
          if (listener.pid !== previousListener.pid) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < listenerDeadline);
        assert.notEqual(listener.pid, previousListener.pid);
        const healthFile = path.join(original.project, 'health-mode');
        healthMode = { file: healthFile, bytes: await readFile(healthFile).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        }) };
        await writeFile(healthFile, 'ready');
        const { waitWindowsReadiness } = await load('windows-readiness.mjs');
        const ready = await waitWindowsReadiness({
          context: transaction, port: listener.port, providers: configuration.providers, waitSeconds: 30,
        });
        assert.equal(ready.status, 'ready');
        assert.equal(ready.generation, active.runtime.generation);
        const owned = await transaction.listener({ port: listener.port });
        assert.equal(owned.pid, listener.pid);
        assert.equal(owned.generation, active.runtime.generation);
        await assert.rejects(transaction.listener({ port: listener.port === 65535 ? 65534 : listener.port + 1 }));
        // The ready handoff transaction completes with its accepted state and permanent task policy.
        const { completeWindowsTaskActivation } = await load('windows-task-completion.mjs');
        await assert.rejects(transaction.complete({ stateSha256: '0'.repeat(64) }));
        const completion = await completeWindowsTaskActivation({
          context: transaction, port: listener.port, providers: configuration.providers, waitSeconds: 30,
          async recordAcceptance() {
            await writeDeploymentState(control, {
              ...rotating, phase: 'accepted', previousPhase: 'activating', updatedAt: new Date().toISOString(),
            });
            return createHash('sha256').update(await readFile(stateFile)).digest('hex');
          },
        });
        assert.equal(completion.status, 'completed');
        assert.equal((await transaction.check()).phase, 'accepted');
        const completeFile = path.join(maintenance, 'inactive-complete-complete.json');
        const completeBytes = await readFile(completeFile);
        await transaction.complete({ stateSha256: completion.stateSha256 });
        assert.deepEqual(await readFile(completeFile), completeBytes);
        await assert.rejects(transaction.complete({ stateSha256: '1'.repeat(64) }));
        assert.deepEqual(await readFile(completeFile), completeBytes);
        const completeReceipt = JSON.parse(completeBytes);
        assert.equal(completeReceipt.preparationSha256, preparation.sha256);
        assert.equal(completeReceipt.stateSha256, completion.stateSha256);
        completedStateSha256 = completion.stateSha256;
        completedRuntime = true;
      } finally { await configuration.close(); }
      await transaction.close();
      if (activatedRuntime && !completedRuntime) {
        // Closing the unfinished transaction settles its guarded runtime.
        const deadline = Date.now() + 30000;
        while (await processIdentity(activatedRuntime.pid) === activatedRuntime.identity && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.notEqual(await processIdentity(activatedRuntime.pid), activatedRuntime.identity);
      }
      if (healthMode) {
        if (healthMode.bytes) await writeFile(healthMode.file, healthMode.bytes);
        else await unlink(healthMode.file);
      }
      writtenState = Object.freeze({
        ...writtenState, bytes: await readFile(stateFile), identity: await lstat(stateFile, { bigint: true }),
      });
    } finally { await scope.close(); }
    if (completedRuntime) {
      // After its lease is released, the completed handoff operation is observable through the inactive completion proof.
      const {
        openWindowsInactiveTaskCompletionProof, openWindowsTaskCompletionProof,
        prepareWindowsInactiveTaskRetirement, prepareWindowsInactiveTaskRetirementCheckpoint,
      } = await load('windows-task-completion-proof.mjs');
      await assert.rejects(openWindowsTaskCompletionProof({ control, pwsh, admission }), /Completed-task proof unavailable/);
      const proof = await openWindowsInactiveTaskCompletionProof({ control, pwsh, admission });
      try {
        assert.equal(proof.observation.status, 'observed');
        assert.equal(proof.observation.mutationAuthority, false);
        assert.equal(proof.observation.lease, 'released');
        assert.equal(proof.observation.operationId, owner.operationId);
        assert.equal(proof.observation.taskName, original.observation.taskName);
        assert.equal(proof.observation.stateSha256, completedStateSha256);
        assert.equal(proof.observation.runtime.identity, activatedRuntime.identity);
        assert.deepEqual(await proof.check(), proof.observation);
        // The completed handoff operation prepares its exact inactive retirement intent and checkpoint.
        await assert.rejects(prepareWindowsInactiveTaskRetirement(control, { ...proof }, admission));
        retirementPrepared = true;
        const retirement = await prepareWindowsInactiveTaskRetirement(control, proof, admission);
        assert.equal(retirement.intent.version, 2);
        assert.deepEqual(retirement.intent.completion, proof.observation);
        assert.deepEqual(retirement.intent.files.map(file => file.path).sort(),
          (await readdir(maintenance)).map(name => `task-maintenance\\${name}`).sort());
        assert.equal(retirement.intent.files[0].path, 'task-maintenance\\admission.json');
        assert.equal(retirement.intent.files.at(-1).path, 'task-maintenance\\inactive-complete-complete.json');
        assert.deepEqual(await prepareWindowsInactiveTaskRetirement(control, proof, admission), retirement);
        const checkpoint = await prepareWindowsInactiveTaskRetirementCheckpoint(control, proof, admission);
        assert.equal(checkpoint.checkpoint.version, 2);
        assert.deepEqual(checkpoint.intent, retirement);
        assert.equal(checkpoint.checkpoint.priorRuntime.runtime.identity, original.observation.retiredRuntime.identity);
        assert.notEqual(checkpoint.checkpoint.priorRuntime.runtime.generation, activatedRuntime.generation);
        assert.deepEqual(await prepareWindowsInactiveTaskRetirementCheckpoint(control, proof, admission), checkpoint);
        assert.deepEqual(await proof.check(), proof.observation);
      } finally { await proof.close(); }
      await assert.rejects(proof.check(), /Completed-task proof unavailable/);
    }
    if (completedRuntime) {
      // A completed runtime stays under its permanent task; the fixture stops it before restoring the archive.
      assert.equal(await processIdentity(activatedRuntime.pid), activatedRuntime.identity);
      const stop = await promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-Command', [
        '$ErrorActionPreference = "Stop"',
        '$service = New-Object -ComObject Schedule.Service; $service.Connect()',
        '$task = $service.GetFolder("\\").GetTask($env:AGENTS_CHAT_TASK_NAME); $task.Enabled = $false; $task.Stop(0)',
      ].join('; ')], { timeout: 45000, maxBuffer: 131072, windowsHide: true, env: {
        ...process.env, AGENTS_CHAT_TASK_NAME: original.observation.taskName,
      } });
      assert.equal(stop.stderr, '');
      const deadline = Date.now() + 30000;
      while (await processIdentity(activatedRuntime.pid) === activatedRuntime.identity && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.notEqual(await processIdentity(activatedRuntime.pid), activatedRuntime.identity);
    }
    // The inactive scope retains its published admission handle until it closes.
    await unlink(published);
    await unlink(activationPrepared);
    if (retirementPrepared) {
      for (const name of ['task-retirement-checkpoint.json', 'task-retirement.json']) {
        try { await unlink(path.join(control, name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    for (const name of await readdir(maintenance)) {
      assert.match(name, /^inactive-(replacement|start|complete)-[a-z-]+\.json$/);
      await unlink(path.join(maintenance, name));
    }
    await rmdir(maintenance);
    // Re-register the original inhibited definition so later fixture steps observe the archived task.
    const restore = await promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-Command', [
      '$ErrorActionPreference = "Stop"',
      '$service = New-Object -ComObject Schedule.Service; $service.Connect()',
      '$folder = $service.GetFolder("\\"); $task = $folder.GetTask($env:AGENTS_CHAT_TASK_NAME)',
      '$principal = $task.Definition.Principal',
      '$null = $folder.RegisterTask($env:AGENTS_CHAT_TASK_NAME, $env:AGENTS_CHAT_TASK_XML, (4 -bor 16 -bor 32), [string]$principal.UserId, $null, [int]$principal.LogonType, $null)',
      '$restored = $folder.GetTask($env:AGENTS_CHAT_TASK_NAME); $restored.Enabled = $false',
      'if ($folder.GetTask($env:AGENTS_CHAT_TASK_NAME).Enabled) { throw "Restored task is enabled." }',
    ].join('; ')], { timeout: 45000, maxBuffer: 131072, windowsHide: true, env: {
      ...process.env, AGENTS_CHAT_TASK_NAME: original.observation.taskName, AGENTS_CHAT_TASK_XML: replacedDefinition,
    } });
    assert.equal(restore.stderr, '');
  }
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
  const lockReleased = releaseRestart && !holdReleaseIntent;
  for (const snapshot of [...snapshots, ...(ownerSnapshot && !lockReleased ? [ownerSnapshot] : [])]) {
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
  if (lockReleased) {
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
    const marker = holdReleaseIntent ? 'INACTIVE_HISTORY_RESTART_RELEASE_INTENT_HELD'
      : holdReleased ? 'INACTIVE_HISTORY_RESTART_RELEASED_HELD'
      : holdState ? 'INACTIVE_HISTORY_RESTART_STATE_HELD'
      : holdCommitted ? 'INACTIVE_HISTORY_RESTART_COMMITTED_HELD'
      : holdOwner ? 'INACTIVE_HISTORY_RESTART_OWNER_HELD'
      : holdDirectory ? 'INACTIVE_HISTORY_RESTART_DIRECTORY_HELD' : 'INACTIVE_HISTORY_RESTART_PREPARED_HELD';
    console.log(`${marker} ${JSON.stringify(heldPublication)}`);
    const timer = setInterval(() => {}, 1000);
    try { await new Promise(() => {}); } finally { clearInterval(timer); }
  }
  for (const snapshot of snapshots.reverse()) await unlink(snapshot.file);
  if (writtenState) { await writeFile(stateFile, state); }
  if (refuseAdmission) {
    console.log('PASS: ordinary inactive task admission refuses the exact live restart owner written preflight while handoff evidence remains without publishing maintenance');
    console.log('PASS: handoff-aware inactive admission publishes only the exact live restart owner written preflight binding through the shared native verifier while copied foreign ordinary and duplicate admission remain refused');
    console.log('PASS: handoff-aware inactive admission begins the existing inactive transaction for the exact live restart owner and reaches its copying snapshot stage while copied scopes and duplicate consumers remain refused');
    console.log('PASS: handoff-aware inactive transaction snapshots rotates and prepares activation with its distinct operation bundle and proved task definition while copied contexts and duplicate preparation remain refused');
    console.log('PASS: handoff-aware inactive transaction replaces the inhibited task with its operation bundle and records the proved original definition while copied contexts and duplicate replacement remain refused');
    console.log('PASS: handoff-aware inactive transaction starts one distinct guarded runtime from its operation bundle and settles it on close while copied contexts and duplicate startup remain refused');
    console.log('PASS: handoff-aware inactive startup readiness verifies HTTP providers only through its retained original Job listener while premature and foreign ports remain refused');
    console.log('PASS: handoff-aware inactive transaction completes with accepted state and permanent task policy through its original guarded lease while forged and foreign-digest completion remain refused and same-digest completion replays idempotently');
    console.log('PASS: handoff-aware completed operation is observable through the read-only inactive completion proof after its lease is released while the active proof remains refused');
    console.log('PASS: handoff-aware completed operation prepares its exact inactive retirement intent and checkpoint with the archived retired runtime while copied proofs remain refused');
  }
  console.log(releaseRestart && writeState
    ? 'PASS: native live restart owner releases only its exact committed lock after its acknowledged state write while nine records and written state remain exact without authority'
    : releaseRestart
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
