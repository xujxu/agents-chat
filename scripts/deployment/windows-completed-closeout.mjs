import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { withWindowsAdmission } from './windows-admission.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { validateState } from './state.mjs';
import { openWindowsFirstDeploymentRetirement } from './windows-first-deployment-retirement.mjs';
import { recoverWindowsFirstDeploymentReceipt } from './windows-first-receipt-recovery.mjs';
import { completeWindowsFirstDeployment } from './windows-first-cold-completion.mjs';
import { openWindowsColdRetirementScope } from './windows-cold-retirement-scope.mjs';
import {
  openWindowsInactiveRollbackRetirement, openWindowsInactiveRollbackWorkerRetirement,
  openWindowsInactiveRollbackHistoryArchive, openWindowsInactiveRollbackHistoryRetirement,
  openWindowsInactiveRollbackHistoryCompletion,
} from './windows-task-completion-recovery.mjs';
import {
  openWindowsTaskCompletionProof, beginWindowsTaskRetirement, openWindowsTaskRetirement,
  retireNextWindowsTaskFile, beginWindowsDeploymentRetirement, openWindowsDeploymentRetirement,
  retireNextWindowsDeploymentEntry, openWindowsInactiveTaskCompletionProof,
  prepareWindowsInactiveTaskRetirement, prepareWindowsInactiveTaskRetirementCheckpoint,
  openWindowsInactiveTaskRetirement, beginWindowsInactiveDeploymentRetirement,
  openWindowsInactiveDeploymentRetirement,
} from './windows-task-completion-proof.mjs';

async function hasMarker(control, name) {
  try {
    const info = await lstat(path.join(control, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Invalid completed closeout marker.');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function closeCompletedWindowsDeployment(options) {
  return closeWindowsDeployment(options, false);
}

export function archiveCompletedWindowsInactiveRollback(options) {
  return closeWindowsDeployment(options, true);
}

async function closeWindowsDeployment({
  control, project, operationId, pwsh, signal, admission: retainedAdmission,
}, archiveStoppedHistory) {
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'win32' || ![control, project, pwsh].every(value =>
      typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
      && path.resolve(value) === value && !/[\0\r\n]/.test(value))
      || typeof operationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)) {
      throw new Error('Completed Windows closeout requires explicit original project, operation and native paths.');
    }
    await externalWorkerDirectory(control, project);
    return await withWindowsAdmission(control, { pwsh, admission: retainedAdmission }, async admission => {
      signal?.throwIfAborted();
      const stateFile = path.join(control, 'state.json');
      const bytes = await readWorkerFile(stateFile, 65536, { privateMode: true });
      const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      const recoveredPrior = state.phase === 'prior-runtime-restored';
      if (state.project !== project || state.operationId !== operationId
        || !['accepted', 'restored', 'prior-runtime-restored'].includes(state.phase)
        || !recoveredPrior && state.errorCode !== null) {
        throw new Error('Completed Windows closeout state differs from the requested operation.');
      }
      const stateSha256 = createHash('sha256').update(bytes).digest('hex');
      const checkState = async () => {
        signal?.throwIfAborted();
        if (!(await readWorkerFile(stateFile, 65536, { privateMode: true })).equals(bytes)) {
          throw new Error('Original completed state changed during closeout.');
        }
      };
      const checkProof = proof => {
        if (proof.operationId !== operationId || proof.stateSha256 !== stateSha256) {
          throw new Error('Native completed proof differs from the requested operation.');
        }
      };
      let scope;
      let failure;
      try {
        if (archiveStoppedHistory && !(state.priorRuntime === 'stopped' && state.phase === 'restored'
          && state.previousPhase === 'accepted' && state.operation === 'update')) {
          throw new Error('History archival requires its exact original stopped rollback.');
        }
        if (state.priorRuntime === 'stopped' && state.phase === 'restored' && state.previousPhase === 'accepted') {
          if (state.operation !== 'update') {
            throw new Error('Stopped rollback closeout requires its exact original restored update.');
          }
          const historyPrepared = archiveStoppedHistory && await hasMarker(control, 'inactive-rollback-history-intent.json');
          const historyFinalized = archiveStoppedHistory && await hasMarker(control,
            `retired-${operationId}-inactive-rollback-history-intent.json`);
          if (!historyPrepared && !historyFinalized && !await hasMarker(control, 'inactive-rollback-workers.json')) {
            scope = await openWindowsInactiveRollbackRetirement({ control, pwsh, admission, signal });
            checkProof(scope.observation);
            let task = await scope.check({ signal });
            while (task.retiredEntries < task.totalEntries) {
              await checkState();
              task = await scope.advance({ signal });
            }
            await checkState();
            await scope.prepareWorkers({ signal });
            await scope.close();
            scope = undefined;
          }
          if (!historyPrepared && !historyFinalized) {
            scope = await openWindowsInactiveRollbackWorkerRetirement({ control, pwsh, admission, signal });
            checkProof(scope.observation);
            let workers = await scope.check({ signal });
            while (workers.status !== 'retired') {
              await checkState();
              workers = await scope.advance({ signal });
            }
            await checkState();
            if (archiveStoppedHistory) {
              await scope.prepareHistory({ signal });
              await scope.close();
              scope = undefined;
            }
          }
          if (archiveStoppedHistory) {
            if (!historyFinalized) {
              scope = await openWindowsInactiveRollbackHistoryRetirement({ control, pwsh, admission, signal });
              checkProof(scope.observation);
              let history = await scope.check({ signal });
              while (history.archivedEntries < history.totalEntries) {
                await checkState();
                history = await scope.advance({ signal });
              }
              await checkState();
              await scope.finalizeHistory({ signal });
              await scope.close();
              scope = undefined;
            }
            scope = await openWindowsInactiveRollbackHistoryCompletion({ control, pwsh, admission, signal });
            checkProof(scope.observation);
            await checkState();
            await scope.completeHistory({ signal });
            await scope.close();
            scope = undefined;
            scope = await openWindowsInactiveRollbackHistoryArchive({ control, pwsh, admission, signal });
            checkProof(scope.observation);
            await scope.check({ signal });
            await checkState();
            return Object.freeze({ status: 'history-archived', operationId, phase: state.phase });
          }
          await checkState();
          return Object.freeze({ status: 'completed', operationId, phase: state.phase });
        }
        if (state.priorRuntime === 'absent') {
          if (state.operation !== 'deploy' || state.phase !== 'accepted'
            || state.previousPhase !== 'activating' || state.runtimeIdentity !== 'first-install-absent'
            || state.backupId !== null || state.errorCode !== null) {
            throw new Error('First deployment closeout requires its exact accepted absent-prior state.');
          }
          if (!await hasMarker(control, 'deployment.json')) {
            await checkState();
            await completeWindowsFirstDeployment({ control, project, operationId, stateSha256, pwsh, admission, signal });
            await checkState();
            await recoverWindowsFirstDeploymentReceipt({ control, project, operationId, pwsh, admission, signal });
            await checkState();
          }
          scope = await openWindowsFirstDeploymentRetirement({ control, pwsh, admission, signal });
          checkProof(scope.observation);
          let deployment = await scope.check({ signal });
          while (deployment.status !== 'retired') {
            await checkState();
            deployment = await scope.advance({ signal });
          }
          await checkState();
          return Object.freeze({ status: 'completed', operationId, phase: state.phase });
        }
        if (state.priorRuntime === 'stopped' && state.phase === 'accepted') {
          // An accepted update of a stopped task (including a first-attempt stopped-history handoff) closes out
          // through the inactive proof, task receipts and deployment retirement, which also retires the handoff.
          if (state.operation !== 'update' || state.previousPhase !== 'activating' || state.errorCode !== null) {
            throw new Error('Inactive closeout requires its exact accepted stopped-prior update.');
          }
          if (await hasMarker(control, 'worker-retirement.json')) {
            scope = await openWindowsInactiveDeploymentRetirement({ control, pwsh, admission, signal });
            checkProof(scope.observation.manifest.record.task.intent.intent.completion);
          } else {
            if (!await hasMarker(control, 'task-retirement-checkpoint.json')) {
              scope = await openWindowsInactiveTaskCompletionProof({ control, pwsh, admission, signal });
              checkProof(scope.observation);
              await checkState();
              await prepareWindowsInactiveTaskRetirement(control, scope, admission, { signal });
              await prepareWindowsInactiveTaskRetirementCheckpoint(control, scope, admission, { signal });
              await scope.close();
              scope = undefined;
            }
            scope = await openWindowsInactiveTaskRetirement({ control, pwsh, admission, signal });
            checkProof(scope.observation.checkpoint.intent.intent.completion);
            let task = await scope.check({ signal });
            while (task.retiredFiles < task.checkpoint.intent.intent.files.length) {
              await checkState();
              task = await retireNextWindowsTaskFile(control, scope, admission, { signal });
            }
            await checkState();
            scope = await beginWindowsInactiveDeploymentRetirement(control, scope, admission, { signal });
          }
        } else if (await hasMarker(control, 'worker-retirement.json')) {
          const marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
            await readWorkerFile(path.join(control, 'worker-retirement.json'), 1048576, { privateMode: true })));
          if (marker.version === 5) {
            scope = await openWindowsColdRetirementScope({ control, pwsh, admission, signal });
            checkProof(scope.observation);
            if (scope.record.project !== project || state.operation !== 'restore' || state.phase !== 'restored') {
              throw new Error('Cold retirement differs from the requested restored deployment.');
            }
            while (scope.observation.status !== 'retired') {
              await checkState();
              await scope.advance({ signal });
            }
            await checkState();
            return Object.freeze({ status: 'completed', operationId, phase: state.phase });
          }
          scope = await openWindowsDeploymentRetirement({ control, pwsh, admission, signal });
          checkProof(scope.observation.manifest.record.task.intent.intent.completion);
        } else {
          if (await hasMarker(control, 'task-retirement-checkpoint.json')) {
            scope = await openWindowsTaskRetirement({ control, pwsh, admission, signal });
            checkProof(scope.observation.checkpoint.intent.intent.completion);
          } else {
            scope = await openWindowsTaskCompletionProof({ control, pwsh, admission, signal });
            checkProof(scope.observation);
            await checkState();
            scope = await beginWindowsTaskRetirement(control, scope, admission, { signal });
          }
          let task = await scope.check({ signal });
          while (task.retiredFiles < task.checkpoint.intent.intent.files.length) {
            await checkState();
            task = await retireNextWindowsTaskFile(control, scope, admission, { signal });
          }
          await checkState();
          scope = await beginWindowsDeploymentRetirement(control, scope, admission, { signal });
        }
        let deployment = await scope.check({ signal });
        while (deployment.status !== 'retired') {
          await checkState();
          deployment = await retireNextWindowsDeploymentEntry(control, scope, admission, { signal });
        }
        await checkState();
        return Object.freeze({ status: 'completed', operationId, phase: state.phase });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try { await scope?.close(); }
        catch (error) {
          throw new AggregateError(failure ? [failure, error] : [error], 'Completed Windows closeout authority did not settle.');
        }
      }
    });
  } catch (cause) {
    throw Object.assign(new Error('Completed Windows closeout failed; retain original recovery evidence.', { cause }), {
      code: 'DEPLOYMENT_WINDOWS_COMPLETED_CLOSEOUT_REFUSED', recoveryAllowed: false,
      nextAction: 'Inspect the original completed task and saved retirement receipts; do not restart or restore the application.',
    });
  }
}
