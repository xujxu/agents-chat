import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { runDeployment } from './transaction.mjs';
import { runStage } from './stage-runner.mjs';
import { assertLockOwner, captureLockOwner, loadState, releaseLock, writeState } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { saveWorkerEngine } from './saved-worker-engine.mjs';
import { saveRecoveryEngine, verifyRecoveryEngine } from './saved-recovery-engine.mjs';
import { createWorkerOperation } from './worker-operation.mjs';
import { prepareWindowsSourceBuild } from './windows-source-build.mjs';
import { admitWindowsCompatibility } from './windows-compatibility.mjs';
import { inspectSnapshotScope } from './snapshot-scope.mjs';
import { prepareGitObjects } from './git-objects.mjs';
import { createWindowsTaskSnapshot } from './windows-task-snapshot.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { reconcileSnapshotSlots, rotateSnapshot } from './snapshot-rotation.mjs';
import {
  assertWindowsManagedTaskScope, captureWindowsManagedTaskAdmission, inspectWindowsManagedTask,
} from './windows-managed-task.mjs';
import { withWindowsAdmission } from './windows-admission.mjs';
import { prepareWindowsRuntimeBundle } from './windows-runtime-publication.mjs';
import { stopWindowsTaskTransaction } from './windows-task-transaction.mjs';
import { completeWindowsTaskActivation } from './windows-task-completion.mjs';
import { inspectWindowsConfiguration } from './windows-configuration.mjs';
import { captureWindowsDeploymentAcceptance } from './windows-deployment-acceptance.mjs';
import { inspectCurrentWindowsDeployment } from './windows-current-deployment.mjs';
import { publishDeploymentReceipt } from './deployment-receipt.mjs';
import { closeRejectedWindowsPreflight } from './windows-preflight-refusal.mjs';
import { requireLinuxDeploymentSpace as requireDeploymentSpace } from './linux-deployment-capacity.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { journalUncertain } from './evidence-journal.mjs';

export async function runWindowsLiveDeployment({
  scope, control, lock: supplied, node, npmCli, git, pwsh, environment, port, deploymentBytes,
  operation: kind = 'update', revision, noPull = false, noInstall = false,
  waitSeconds = 120, timeoutSeconds = 1800, signal, onProgress,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || !['deploy', 'update'].includes(kind)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(deploymentBytes) || deploymentBytes <= 0
    || !Number.isSafeInteger(waitSeconds) || waitSeconds <= 0
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0
    || onProgress !== undefined && typeof onProgress !== 'function') {
    throw new Error('Live Windows deployment requires explicit native tools, bounded verified activation and a positive build budget.');
  }
  const lock = captureLockOwner(supplied);
  const original = await assertWindowsManagedTaskScope(scope, { signal });
  const project = original.project;
  const history = { priorRuntime: 'running', runtimeIdentity: original.runtime.generation };
  const timeoutMs = Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER);
  const helperSource = fileURLToPath(new URL('./', import.meta.url));
  let state;
  let previousState;
  let source;
  let target;
  let workers;
  let stages;
  let compatibility;
  let buildEnvironment;
  let current;
  let recovery;
  let bundle;
  let taskAdmission;
  let stopped;
  let built;
  let active;
  let activeConfiguration;
  let sealed = false;
  let activationAttempted = false;
  let completed = false;
  let receiptPublished = false;
  let result;
  const errors = [];
  const authority = async () => {
    await externalWorkerDirectory(helperSource, project);
    await externalWorkerDirectory(control, project);
    if (lock.project !== project) throw new Error('Deployment lock differs from the installed Windows project.');
    await assertLockOwner(control, lock);
    if (state && !same(await loadState(control), state)) throw journalUncertain(new Error('Deployment state changed.'));
  };
  const writePhase = async (phase, context = {}) => {
    await authority();
    const next = {
      version: 1, operationId: lock.operationId, project, operation: kind, phase,
      previousPhase: state?.phase ?? null, sourceCommit: source?.commit ?? null, targetCommit: target?.commit ?? null,
      backupId: phase === 'already-current' ? previousState.backupId : context.snapshot?.id ?? state?.backupId ?? null,
      ...history, startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: context.errorCode ?? null,
    };
    await writeState(control, next);
    state = next;
    onProgress?.({ phase });
  };
  const record = async (phase, context = {}) => {
    await authority();
    if (['accepted', 'prior-runtime-restored'].includes(state?.phase)) {
      if (completed && phase === state.phase && (context.errorCode ?? null) === state.errorCode) return;
      throw journalUncertain(new Error('Retain original terminal state for native completion recovery; it cannot be rewritten.'));
    }
    if (phase === 'preflight' && state) {
      await runStage('prepare-task', async stageSignal => {
        await compatibility.check({ signal: stageSignal });
        bundle = await prepareWindowsRuntimeBundle({ scope, control, lock, node, pwsh, signal: stageSignal });
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        taskAdmission = await withWindowsAdmission(control, { pwsh }, admission =>
          captureWindowsManagedTaskAdmission({ scope, control, lock, admission, signal: stageSignal }));
        await scope.close();
      }, { timeoutMs, signal });
      return;
    }
    await writePhase(phase, context);
    if (stopped && !['blocked', 'recovery-required'].includes(phase)) {
      // The native controller must observe every edge, including phases without task work.
      await stopped.check();
    }
  };
  const seal = async () => {
    if (!sealed) { await workers.seal(); sealed = true; }
  };
  try {
    await authority();
    previousState = await loadState(control);
    await record('preflight');
    const saved = await saveWorkerEngine({ control, project, operationId: lock.operationId, source: helperSource });
    workers = await createWorkerOperation({ control, lock, saved });
    result = await runDeployment({ operation: kind, noInstall, waitSeconds, timeoutSeconds, signal }, {
      record,
      async inspect({ signal: stageSignal }) {
        await authority();
        stages = await prepareWindowsSourceBuild({
          scope, control, lock, operation: workers, node, npmCli, git, environment, pwsh, signal: stageSignal,
        });
        source = await stages.inspect({ signal: stageSignal });
        return { exists: true, running: true, owned: true };
      },
      async resolveTarget({ signal: stageSignal }) {
        await authority();
        target = await stages.resolve({ options: { revision, noPull }, signal: stageSignal });
        return target;
      },
      async admit({ signal: stageSignal }) {
        await authority();
        compatibility = await admitWindowsCompatibility({
          scope, control, lock, operation: workers, node, git, pwsh, commit: target.commit, signal: stageSignal,
        });
        buildEnvironment = compatibility.configuration.buildEnvironment(environment);
        if (kind === 'update' && source.commit === target.commit) {
          current = await inspectCurrentWindowsDeployment({
            state: previousState, scope, configuration: compatibility.configuration, control,
            commit: target.commit, port, waitSeconds, signal: stageSignal,
          });
        }
        return { ...compatibility, current: current?.current };
      },
      async capacity({ signal: stageSignal }) {
        await authority();
        const slots = await reconcileSnapshotSlots(control, { project });
        if (!['empty', 'retained'].includes(slots.status)) throw new Error('Unfinished snapshot rotation requires recovery before downtime.');
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
          if (!stopped) throw journalUncertain(new Error('Original Windows stop did not complete.'));
          if (activationAttempted) {
            throw journalUncertain(new Error(
              'Unaccepted Windows activation requires original guarded-runtime settlement after controller exit; retain recovery evidence.'));
          }
          await stopped.check({ signal: stageSignal });
          await stopped.close();
          return;
        }
        await verifyRecoveryEngine({ control, manifestSha256: recovery.manifestSha256 });
        stopped = await stopWindowsTaskTransaction({ control, lock, pwsh, ...taskAdmission, signal: stageSignal });
      },
      async snapshot({ signal: stageSignal }) {
        await authority();
        return createWindowsTaskSnapshot({
          context: stopped, control, lock, configuration: compatibility.configuration,
          destination: path.join(control, 'staging'), id: lock.operationId,
          source: { commit: source.commit, provenance: 'observed' }, recoveryEngine: recovery.manifestSha256,
          pwsh, signal: stageSignal,
        });
      },
      async verifySnapshot({ snapshot, signal: stageSignal }) {
        await authority();
        if (!same(await verifySnapshot(path.join(control, 'staging'), { signal: stageSignal }), snapshot)) {
          throw new Error('Staged Windows backup changed.');
        }
      },
      async rotate() {
        await authority();
        await rotateSnapshot(control, { project });
      },
      async selectSource({ signal: stageSignal }) {
        await authority();
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        await stages.select({ target, stopped, signal: stageSignal });
      },
      async dependencies({ signal: stageSignal }) {
        await authority();
        await stages.npm({ stage: 'dependencies', commit: target.commit, stopped,
          environment: buildEnvironment, signal: stageSignal });
      },
      async build({ signal: stageSignal }) {
        await authority();
        built = await stages.npm({ stage: 'build', commit: target.commit, stopped,
          environment: buildEnvironment, signal: stageSignal });
      },
      async configure({ signal: stageSignal }) {
        await authority();
        await stopped.check({ signal: stageSignal });
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        await built.source.check({ signal: stageSignal });
        await built.artifacts.check({ signal: stageSignal });
      },
      async start({ recovering, signal: stageSignal }) {
        await authority();
        if (!stopped || !bundle) throw journalUncertain(new Error('Original task transaction or runtime bundle is unavailable.'));
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        await seal();
        if (recovering) await stopped.retirePriorRuntime({ signal: stageSignal });
        else await stopped.retire({ signal: stageSignal });
        await stopped.replace({ ...bundle, signal: stageSignal });
        activationAttempted = true;
        await stopped.activate({ signal: stageSignal });
      },
      async verify(context) {
        const { recovering, signal: stageSignal } = context;
        await authority();
        await compatibility.configuration.checkFiles({ signal: stageSignal });
        if (!recovering) {
          await built.source.check({ signal: stageSignal });
          await built.artifacts.check({ signal: stageSignal });
        }
        await completeWindowsTaskActivation({
          context: stopped, control, port, providers: compatibility.configuration.providers, waitSeconds, signal: stageSignal,
          async recordAcceptance() {
            await compatibility.configuration.checkFiles({ signal: stageSignal });
            await writePhase(recovering ? 'prior-runtime-restored' : 'accepted', context);
            return createHash('sha256').update(await readWorkerFile(
              path.join(control, 'state.json'), 65536, { privateMode: true })).digest('hex');
          },
        });
        completed = true;
      },
    });
    if (result.status === 'already-current') {
      await seal();
      await runStage('verify-current', async stageSignal => {
        await authority();
        await current.check({ signal: stageSignal });
        await record('already-current');
      }, { timeoutMs, signal });
      await workers.retire();
      await assertWindowsManagedTaskScope(scope, { signal });
      await releaseLock(control, lock, { pwsh });
    } else {
      await runStage('publish-receipt', async stageSignal => {
        await authority();
        active = await inspectWindowsManagedTask({ project, taskName: original.taskName, pwsh, signal: stageSignal });
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
    if (!hasUnsettledWorker(error) && state?.phase === 'preflight' && workers && !sealed && !taskAdmission) {
      try { await closeRejectedWindowsPreflight({ control, lock, scope, operation: workers, pwsh }); }
      catch (cleanup) { errors.push(cleanup); }
    }
  }
  const closed = await Promise.allSettled([
    activeConfiguration?.close(), active?.close(), compatibility?.configuration.close(), stopped?.close(), workers?.close(),
  ]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => journalUncertain(value.reason)));
  const closeoutRequired = completed && (receiptPublished || state.phase === 'prior-runtime-restored')
    && !errors.some(hasUnsettledWorker);
  if (errors.length) {
    const error = errors.length === 1 ? errors[0]
      : journalUncertain(new AggregateError(errors, 'Windows deployment and retained authority cleanup failed.'));
    if (closeoutRequired) {
      error.closeoutRequired = true;
      error.operationId = lock.operationId;
      error.recoveryEngine = recovery.manifestSha256;
    }
    throw error;
  }
  return Object.freeze({
    ...result, closeoutRequired,
    ...(closeoutRequired ? { recoveryEngine: recovery.manifestSha256 } : {}),
  });
}
