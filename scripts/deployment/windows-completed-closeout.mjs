import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { withWindowsAdmission } from './windows-admission.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { validateState } from './state.mjs';
import {
  openWindowsTaskCompletionProof, beginWindowsTaskRetirement, openWindowsTaskRetirement,
  retireNextWindowsTaskFile, beginWindowsDeploymentRetirement, openWindowsDeploymentRetirement,
  retireNextWindowsDeploymentEntry,
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

export async function closeCompletedWindowsDeployment({ control, project, operationId, pwsh, signal }) {
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'win32' || ![control, project, pwsh].every(value =>
      typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
      && path.resolve(value) === value && !/[\0\r\n]/.test(value))
      || typeof operationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)) {
      throw new Error('Completed Windows closeout requires explicit original project, operation and native paths.');
    }
    await externalWorkerDirectory(control, project);
    return await withWindowsAdmission(control, { pwsh }, async admission => {
      signal?.throwIfAborted();
      const stateFile = path.join(control, 'state.json');
      const bytes = await readWorkerFile(stateFile, 65536, { privateMode: true });
      const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (state.project !== project || state.operationId !== operationId
        || !['accepted', 'restored'].includes(state.phase) || state.errorCode !== null) {
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
        if (await hasMarker(control, 'worker-retirement.json')) {
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
