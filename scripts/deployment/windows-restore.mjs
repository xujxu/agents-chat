import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { runRestore } from './restore-transaction.mjs';
import { runStage } from './stage-runner.mjs';
import { admitWindowsRestore } from './windows-restore-compatibility.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { restoreProjectSnapshot } from './restore-project.mjs';
import { restoreExternalSnapshot } from './restore-external.mjs';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectBuildArtifacts } from './build-artifacts.mjs';
import { assertLockOwner, captureLockOwner, loadState, writeState } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { saveWorkerEngine } from './saved-worker-engine.mjs';
import { verifyRecoveryEngine } from './saved-recovery-engine.mjs';
import { createWorkerOperation } from './worker-operation.mjs';
import { withWindowsAdmission } from './windows-admission.mjs';
import { assertWindowsManagedTaskScope, captureWindowsManagedTaskAdmission, inspectWindowsManagedTask } from './windows-managed-task.mjs';
import { prepareWindowsRestoreRuntimeBundle } from './windows-runtime-publication.mjs';
import { stopWindowsTaskTransaction } from './windows-task-transaction.mjs';
import { completeWindowsTaskActivation } from './windows-task-completion.mjs';
import { inspectWindowsConfiguration } from './windows-configuration.mjs';
import { captureWindowsDeploymentAcceptance } from './windows-deployment-acceptance.mjs';
import { publishRestoredDeploymentReceipt } from './deployment-receipt.mjs';
import { requireLinuxDeploymentSpace as requireDeploymentSpace } from './linux-deployment-capacity.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';

export async function runWindowsLiveRestore({
  scope, control, lock: supplied, backup, node, pwsh, profile, port, acceptDataLoss,
  waitSeconds = 120, timeoutSeconds = 1800, signal, onProgress,
}) {
  signal?.throwIfAborted();
  if (acceptDataLoss !== true) throw new Error('Restore requires explicit acknowledgement of post-backup data loss.');
  if (process.platform !== 'win32' || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(waitSeconds) || waitSeconds <= 0
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0
    || onProgress !== undefined && typeof onProgress !== 'function') {
    throw new Error('Windows restore requires a native controller and bounded verified activation.');
  }
  const lock = captureLockOwner(supplied);
  const original = await assertWindowsManagedTaskScope(scope, { signal });
  const project = original.project;
  const helperSource = path.resolve(fileURLToPath(new URL('./', import.meta.url)));
  const timeoutMs = Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER);
  let initialState;
  let inspected = false;
  let state;
  let initialSource;
  let admission;
  let recovery;
  let workers;
  let bundle;
  let taskAdmission;
  let stopped;
  let source;
  let artifacts;
  let active;
  let activeConfiguration;
  let activationAttempted = false;
  let completed = false;
  let receiptPublished = false;
  let result;
  const errors = [];
  const authority = async () => {
    await externalWorkerDirectory(control, project);
    await externalWorkerDirectory(helperSource, project);
    if (lock.project !== project) throw new Error('Restore lock differs from the original Windows project.');
    await assertLockOwner(control, lock);
    if (inspected && !same(await loadState(control), state ?? initialState)) {
      throw journalUncertain(new Error('Original Windows restore state changed.'));
    }
  };
  const writePhase = async (phase, context) => {
    await authority();
    if (state?.phase === 'restored') {
      if (completed && phase === 'restored') return;
      throw journalUncertain(new Error('Retain restored terminal state for original native completion recovery.'));
    }
    const next = {
      version: 1, operationId: lock.operationId, project, operation: 'restore', phase,
      previousPhase: state?.phase ?? null, sourceCommit: initialSource?.record.commit ?? null,
      targetCommit: context.snapshot?.source.commit ?? null, backupId: context.snapshot?.id ?? null,
      priorRuntime: 'running', runtimeIdentity: original.runtime.generation,
      startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: context.errorCode ?? null,
    };
    await writeState(control, next);
    state = next;
    onProgress?.({ phase });
    if (stopped && !['blocked', 'recovery-required', 'restored'].includes(phase)) await stopped.check();
  };
  const checkStopped = async ({ signal: stageSignal } = {}) => {
    stageSignal?.throwIfAborted();
    await authority();
    if (!stopped || activationAttempted || state.phase !== 'restoring') {
      throw journalUncertain(new Error('Original restoring-phase stop authority is unavailable.'));
    }
    await stopped.check({ signal: stageSignal });
    return { stopped: true, inhibited: true };
  };
  try {
    result = await runRestore({ operation: 'restore', acceptDataLoss, waitSeconds, timeoutSeconds, signal }, {
      async inspect({ signal: stageSignal }) {
        await authority();
        initialState = await loadState(control);
        inspected = true;
        await assertWindowsManagedTaskScope(scope, { signal: stageSignal });
        initialSource = await inspectGitMetadata({ project, signal: stageSignal });
        return { exists: true, running: true, owned: true };
      },
      async inspectBackup({ signal: stageSignal }) {
        await authority();
        const snapshot = await verifySnapshot(backup, { signal: stageSignal });
        admission = await admitWindowsRestore({ scope, backup, snapshot, node, pwsh, profile, signal: stageSignal });
        recovery = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
        if (recovery.directory !== helperSource) throw new Error('Restore must execute through the exact saved recovery engine.');
        return admission;
      },
      async capacity({ snapshot, signal: stageSignal }) {
        await authority();
        stageSignal.throwIfAborted();
        const bytes = snapshot.entries.reduce((sum, entry) => sum + BigInt(entry.bytes ?? 0),
          BigInt(snapshot.gitObjects?.bytes ?? 0));
        const runtimePaths = new Set(admission.runtime.files.map(file =>
          path.join(path.dirname(admission.runtime.task.configuration), file.name)));
        const budgets = [[project, bytes + 64n * 1024n ** 2n], [control, 64n * 1024n ** 2n]];
        for (const entry of snapshot.externalFiles ?? []) {
          const required = BigInt(entry.bytes ?? 0);
          budgets.push([runtimePaths.has(entry.path) ? control : path.dirname(entry.path), required > 0n ? required : 1n]);
        }
        await requireDeploymentSpace(budgets);
        await initialSource.check({ signal: stageSignal });
      },
      async record(phase, context) {
        await authority();
        if (phase === 'restoring') {
          await runStage('prepare-restore-task', async stageSignal => {
            await admission.check({ signal: stageSignal });
            const saved = await saveWorkerEngine({ control, project, operationId: lock.operationId, source: helperSource });
            workers = await createWorkerOperation({ control, lock, saved });
            bundle = await prepareWindowsRestoreRuntimeBundle({
              scope, control, lock, node, pwsh, backup, snapshot: admission.snapshot, signal: stageSignal,
            });
            await admission.check({ signal: stageSignal });
            taskAdmission = await withWindowsAdmission(control, { pwsh }, native =>
              captureWindowsManagedTaskAdmission({ scope, control, lock, admission: native, signal: stageSignal }));
            await admission.close();
            await scope.close();
          }, { timeoutMs, signal });
        }
        await writePhase(phase, context);
      },
      async stop({ recovering, signal: stageSignal }) {
        await authority();
        if (recovering) {
          if (!stopped || activationAttempted) {
            throw journalUncertain(new Error('Restore requires original guarded-runtime settlement; retain recovery evidence.'));
          }
          await stopped.check({ signal: stageSignal });
          await stopped.close();
          return;
        }
        await verifyRecoveryEngine({ control, manifestSha256: recovery.manifestSha256 });
        stopped = await stopWindowsTaskTransaction({ control, lock, pwsh, ...taskAdmission, signal: stageSignal });
      },
      async restoreFiles({ signal: stageSignal }) {
        await checkStopped({ signal: stageSignal });
        await admission.checkSnapshot({ signal: stageSignal });
        await restoreProjectSnapshot({
          project, backup, expectedSnapshot: admission.snapshot, acceptDataLoss, checkStopped, pwsh, signal: stageSignal,
        });
      },
      async configure({ signal: stageSignal }) {
        await checkStopped({ signal: stageSignal });
        await restoreExternalSnapshot({
          project, backup, expectedSnapshot: admission.snapshot, authorizedPaths: admission.authorizedPaths,
          runtimeBundle: bundle, acceptDataLoss, checkStopped, pwsh, signal: stageSignal,
        });
        source = await inspectGitMetadata({ project, commit: admission.snapshot.source.commit, signal: stageSignal });
        artifacts = await inspectBuildArtifacts({ project, signal: stageSignal });
      },
      async start({ signal: stageSignal }) {
        await authority();
        await admission.checkSnapshot({ signal: stageSignal });
        await source.check({ signal: stageSignal });
        await artifacts.check({ signal: stageSignal });
        await workers.seal();
        await stopped.retire({ signal: stageSignal });
        await stopped.replace({ ...bundle, signal: stageSignal });
        activationAttempted = true;
        await stopped.activate({ signal: stageSignal });
      },
      async verify(context) {
        const stageSignal = context.signal;
        await authority();
        await source.check({ signal: stageSignal });
        await artifacts.check({ signal: stageSignal });
        await completeWindowsTaskActivation({
          context: stopped, port, providers: admission.providers, waitSeconds, signal: stageSignal,
          async recordAcceptance() {
            await writePhase('restored', context);
            return createHash('sha256').update(await readWorkerFile(
              path.join(control, 'state.json'), 65536, { privateMode: true })).digest('hex');
          },
        });
        completed = true;
      },
    });
    await runStage('publish-restored-receipt', async stageSignal => {
      await authority();
      active = await inspectWindowsManagedTask({ project, taskName: original.taskName, pwsh, signal: stageSignal });
      activeConfiguration = await inspectWindowsConfiguration({
        scope: active, pwsh, profile: admission.configurationProfile, signal: stageSignal,
      });
      const accepted = await captureWindowsDeploymentAcceptance({
        scope: active, configuration: activeConfiguration, source, artifacts, port, waitSeconds, signal: stageSignal,
      });
      await publishRestoredDeploymentReceipt({ control, lock, ...accepted, signal: stageSignal });
      receiptPublished = true;
    }, { timeoutMs, signal });
  } catch (error) { errors.push(error); }
  const closed = await Promise.allSettled([
    activeConfiguration?.close(), active?.close(), stopped?.close(), workers?.close(), admission?.close(), scope.close(),
  ]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => journalUncertain(value.reason)));
  const closeoutRequired = completed && receiptPublished && !errors.some(hasUnsettledWorker);
  if (errors.length) {
    const error = errors.length === 1 ? errors[0]
      : journalUncertain(new AggregateError(errors, 'Windows restore and retained authority cleanup failed.'));
    if (closeoutRequired) Object.assign(error, { closeoutRequired, operationId: lock.operationId, recoveryEngine: recovery.manifestSha256 });
    throw error;
  }
  return Object.freeze({
    ...result, operationId: lock.operationId, closeoutRequired, runtimeRelocated: true,
    recoveryEngine: recovery.manifestSha256,
  });
}
