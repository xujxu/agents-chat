import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { runDeployment } from './transaction.mjs';
import { runStage } from './stage-runner.mjs';
import { assertLockOwner, captureLockOwner, loadState, writeState } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { saveWorkerEngine } from './saved-worker-engine.mjs';
import { saveRecoveryEngine, verifyRecoveryEngine } from './saved-recovery-engine.mjs';
import { createWorkerOperation } from './worker-operation.mjs';
import { prepareWindowsInactiveSourceBuild } from './windows-source-build.mjs';
import { admitWindowsInactiveCompatibility } from './windows-compatibility.mjs';
import { inspectSnapshotScope } from './snapshot-scope.mjs';
import { prepareGitObjects } from './git-objects.mjs';
import { createWindowsInactiveTaskSnapshot } from './windows-task-snapshot.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { reconcileSnapshotSlots } from './snapshot-rotation.mjs';
import { assertWindowsInactiveTaskScope, inspectWindowsManagedTask } from './windows-managed-task.mjs';
import { inspectWindowsConfiguration } from './windows-configuration.mjs';
import { captureWindowsDeploymentAcceptance } from './windows-deployment-acceptance.mjs';
import { publishDeploymentReceipt } from './deployment-receipt.mjs';
import { prepareWindowsInactiveRuntimeBundle } from './windows-runtime-publication.mjs';
import {
  beginWindowsInactiveTaskTransaction, rotateWindowsInactiveTaskSnapshot, prepareWindowsInactiveTaskActivation,
  replaceWindowsInactiveTask, startWindowsInactiveTask,
} from './windows-inactive-task-transaction.mjs';
import { completeWindowsTaskActivation } from './windows-task-completion.mjs';
import { requireLinuxDeploymentSpace as requireDeploymentSpace } from './linux-deployment-capacity.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { journalUncertain } from './evidence-journal.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Updates a stopped managed task admitted through the first-attempt stopped-history handoff. The handoff already
// wrote this operation's preflight state and published its inactive admission; handoff, admission and lock evidence
// are always retained for the distinct retirement and closeout.
export async function runWindowsInactiveDeployment({
  routed, control, node, npmCli, git, pwsh, environment, port, deploymentBytes,
  operation: kind = 'update', revision, noPull = false, noInstall = false,
  waitSeconds = 120, timeoutSeconds = 1800, signal, onProgress,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || kind !== 'update' || !routed || typeof routed !== 'object'
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(deploymentBytes) || deploymentBytes <= 0
    || !Number.isSafeInteger(waitSeconds) || waitSeconds <= 0
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0
    || onProgress !== undefined && typeof onProgress !== 'function') {
    throw new Error('Inactive Windows update requires its routed handoff admission, native tools and bounded verified activation.');
  }
  const { scope, admission, sha256, handoff } = routed;
  const lock = captureLockOwner(routed.lock);
  const original = await assertWindowsInactiveTaskScope(scope, { signal });
  const project = original.project;
  const timeoutMs = Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER);
  const helperSource = fileURLToPath(new URL('./', import.meta.url));
  const stateFile = path.join(control, 'state.json');
  let state;
  let written;
  let source;
  let target;
  let workers;
  let stages;
  let compatibility;
  let buildEnvironment;
  let recovery;
  let bundle;
  let transaction;
  let built;
  let sealed = false;
  let activationAttempted = false;
  let completed = false;
  let receiptPublished = false;
  let active;
  let activeConfiguration;
  let result;
  const errors = [];
  const authority = async () => {
    await externalWorkerDirectory(helperSource, project);
    await externalWorkerDirectory(control, project);
    if (lock.project !== project) throw new Error('Deployment lock differs from the archived Windows project.');
    await assertLockOwner(control, lock);
    if (!same(await loadState(control), state)) throw journalUncertain(new Error('Deployment state changed.'));
  };
  const writePhase = async (phase, context = {}) => {
    await authority();
    const next = {
      version: 1, operationId: lock.operationId, project, operation: kind, phase,
      previousPhase: state.phase, sourceCommit: source?.commit ?? null, targetCommit: target?.commit ?? null,
      backupId: context.snapshot?.id ?? state.backupId ?? null,
      priorRuntime: 'stopped', runtimeIdentity: written.runtimeIdentity,
      startedAt: written.startedAt, updatedAt: new Date().toISOString(), errorCode: context.errorCode ?? null,
    };
    await writeState(control, next);
    state = next;
    onProgress?.({ phase });
  };
  const record = async (phase, context = {}) => {
    await authority();
    if (state.phase === 'accepted') {
      if (completed && phase === 'accepted') return;
      throw journalUncertain(new Error('Retain original accepted state for inactive completion closeout; it cannot be rewritten.'));
    }
    if (phase === 'preflight') {
      // The handoff wrote this operation's preflight; publish only its distinct runtime bundle here.
      if (state !== written) throw journalUncertain(new Error('Inactive preflight was already recorded.'));
      await runStage('prepare-task', async stageSignal => {
        await compatibility.check({ signal: stageSignal });
        bundle = await prepareWindowsInactiveRuntimeBundle({
          scope, control, lock, node, pwsh, admission, sha256, signal: stageSignal,
        });
        await compatibility.configuration.checkFiles({ signal: stageSignal });
      }, { timeoutMs, signal });
      return;
    }
    await writePhase(phase, context);
    if (transaction && !['blocked', 'recovery-required'].includes(phase)) await transaction.check();
  };
  const seal = async () => {
    if (!sealed) { await workers.seal(); sealed = true; }
  };
  try {
    const handoffState = async () => {
      if (digest(await readWorkerFile(stateFile, 65536, { privateMode: true })) !== handoff?.state?.sha256) {
        throw new Error('Inactive update state differs from its handoff-written preflight.');
      }
    };
    await handoffState();
    written = Object.freeze({ ...await loadState(control) });
    await handoffState();
    state = written;
    if (written.phase !== 'preflight' || written.operationId !== lock.operationId || written.operation !== kind
      || written.priorRuntime !== 'stopped' || written.project !== project) {
      throw new Error('Inactive update requires its exact handoff-written stopped preflight.');
    }
    await authority();
    const saved = await saveWorkerEngine({ control, project, operationId: lock.operationId, source: helperSource });
    workers = await createWorkerOperation({ control, lock, saved });
    result = await runDeployment({ operation: kind, noInstall, waitSeconds, timeoutSeconds, signal }, {
      record,
      async inspect({ signal: stageSignal }) {
        await authority();
        stages = await prepareWindowsInactiveSourceBuild({
          scope, control, lock, operation: workers, node, npmCli, git, environment, pwsh, signal: stageSignal,
        });
        source = await stages.inspect({ signal: stageSignal });
        return { exists: true, running: false, owned: true };
      },
      async resolveTarget({ signal: stageSignal }) {
        await authority();
        target = await stages.resolve({ options: { revision, noPull }, signal: stageSignal });
        return target;
      },
      async admit({ signal: stageSignal }) {
        await authority();
        compatibility = await admitWindowsInactiveCompatibility({
          scope, control, lock, operation: workers, node, git, pwsh, commit: target.commit, signal: stageSignal,
        });
        buildEnvironment = compatibility.configuration.buildEnvironment(environment);
        return compatibility;
      },
      async capacity({ signal: stageSignal }) {
        await authority();
        const slots = await reconcileSnapshotSlots(control, { project });
        if (!['empty', 'retained'].includes(slots.status)) throw new Error('Unfinished snapshot rotation requires recovery before activation.');
        const snapshot = await inspectSnapshotScope({ project, signal: stageSignal });
        const objects = await prepareGitObjects({ project, commit: source.commit, pwsh, signal: stageSignal });
        let bytes = BigInt(snapshot.snapshotBytes) + BigInt(objects.bytes) + 80n * 1024n ** 2n;
        for (const file of compatibility.configuration.files) {
          stageSignal.throwIfAborted();
          const relative = path.relative(project, file.path);
          if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) continue;
          try { bytes += (await lstat(file.path, { bigint: true })).size; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await requireDeploymentSpace([[control, bytes], [project, BigInt(deploymentBytes)]]);
        recovery = await saveRecoveryEngine({ control, source: helperSource, allowVersionChange: true });
      },
      async stop({ recovering, signal: stageSignal }) {
        await authority();
        if (recovering) {
          if (!transaction) throw journalUncertain(new Error('Original inactive transaction did not begin.'));
          if (activationAttempted) {
            throw journalUncertain(new Error(
              'Unaccepted inactive activation requires guarded-runtime settlement after controller exit; retain recovery evidence.'));
          }
          await transaction.check({ signal: stageSignal });
          return;
        }
        // The archived task is already stopped; the transaction binds the handoff admission to this stopped phase.
        await verifyRecoveryEngine({ control, manifestSha256: recovery.manifestSha256 });
        transaction = await beginWindowsInactiveTaskTransaction({ scope, control, lock, admission, sha256, signal: stageSignal });
      },
      async snapshot({ signal: stageSignal }) {
        await authority();
        return createWindowsInactiveTaskSnapshot({
          context: transaction, control, lock, configuration: compatibility.configuration,
          destination: path.join(control, 'staging'), id: lock.operationId,
          source: { commit: source.commit, provenance: 'observed' }, recoveryEngine: recovery.manifestSha256,
          pwsh, signal: stageSignal,
        });
      },
      async verifySnapshot({ snapshot, signal: stageSignal }) {
        await authority();
        if (!same(await verifySnapshot(path.join(control, 'staging'), { signal: stageSignal }), snapshot)) {
          throw new Error('Staged inactive Windows backup changed.');
        }
      },
      async rotate({ signal: stageSignal }) {
        await authority();
        await rotateWindowsInactiveTaskSnapshot({ context: transaction, control, lock, signal: stageSignal });
      },
      async selectSource({ signal: stageSignal }) {
        await authority();
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        await stages.select({ target, stopped: transaction, signal: stageSignal });
      },
      async dependencies({ signal: stageSignal }) {
        await authority();
        await stages.npm({ stage: 'dependencies', commit: target.commit, stopped: transaction,
          environment: buildEnvironment, signal: stageSignal });
      },
      async build({ signal: stageSignal }) {
        await authority();
        built = await stages.npm({ stage: 'build', commit: target.commit, stopped: transaction,
          environment: buildEnvironment, signal: stageSignal });
      },
      async configure({ signal: stageSignal }) {
        await authority();
        await transaction.check({ signal: stageSignal });
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        await built.source.check({ signal: stageSignal });
        await built.artifacts.check({ signal: stageSignal });
      },
      async start({ recovering, signal: stageSignal }) {
        await authority();
        if (recovering || !transaction || !bundle) {
          throw journalUncertain(new Error('Inactive activation requires its original transaction and runtime bundle.'));
        }
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        await seal();
        await prepareWindowsInactiveTaskActivation({ context: transaction, control, lock, bundle, signal: stageSignal });
        await replaceWindowsInactiveTask({ context: transaction, control, lock, signal: stageSignal });
        activationAttempted = true;
        await startWindowsInactiveTask({ context: transaction, control, lock, signal: stageSignal });
      },
      async verify(context) {
        const { recovering, signal: stageSignal } = context;
        await authority();
        if (recovering) throw journalUncertain(new Error('Inactive updates have no prior runtime to restore.'));
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        await built.source.check({ signal: stageSignal });
        await built.artifacts.check({ signal: stageSignal });
        await completeWindowsTaskActivation({
          context: transaction, port, providers: compatibility.configuration.providers, waitSeconds, signal: stageSignal,
          async recordAcceptance() {
            await compatibility.configuration.checkFiles({ signal: stageSignal });
            await writePhase('accepted', context);
            return digest(await readWorkerFile(stateFile, 65536, { privateMode: true }));
          },
        });
        completed = true;
      },
    });
    await seal();
    if (completed && state.phase === 'accepted') {
      // The accepted runtime is now an ordinary running managed task; publish its receipt like a live update.
      await runStage('publish-receipt', async stageSignal => {
        await authority();
        active = await inspectWindowsManagedTask({
          project, taskName: original.taskName, pwsh, signal: stageSignal,
        });
        activeConfiguration = await inspectWindowsConfiguration({
          scope: active, pwsh, profile: compatibility.configuration.profile, signal: stageSignal,
        });
        const accepted = await captureWindowsDeploymentAcceptance({
          scope: active, configuration: activeConfiguration, source: built.source, artifacts: built.artifacts,
          port, waitSeconds, signal: stageSignal,
        });
        await publishDeploymentReceipt({ control, lock, ...accepted, signal: stageSignal });
        receiptPublished = true;
      }, { timeoutMs, signal });
    }
  } catch (error) {
    errors.push(error);
  }
  const closed = await Promise.allSettled([
    activeConfiguration?.close(), active?.close(), compatibility?.configuration.close(), transaction ? transaction.close() : scope.close(), workers?.close(),
  ]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => journalUncertain(value.reason)));
  if (errors.length) {
    const error = errors.length === 1 ? errors[0]
      : journalUncertain(new AggregateError(errors, 'Inactive Windows update and retained authority cleanup failed.'));
    throw Object.assign(error, {
      handoffRetained: true, operationId: lock.operationId,
      ...(completed && receiptPublished && !errors.some(hasUnsettledWorker)
        ? { closeoutRequired: true, recoveryEngine: recovery.manifestSha256 } : {}),
    });
  }
  return Object.freeze({
    ...result, operationId: lock.operationId, handoffRetained: true, closeoutRequired: true,
    recoveryEngine: recovery.manifestSha256,
  });
}
