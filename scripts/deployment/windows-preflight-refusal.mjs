import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import {
  assertLockOwner, captureLockOwner, loadState, releaseLock, requireNoServiceMaintenance, writeState,
} from './state.mjs';
import { externalWorkerDirectory } from './worker-files.mjs';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';

export async function closeRejectedWindowsPreflight({ control, lock: supplied, scope, operation, pwsh, signal }) {
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'win32' || typeof pwsh !== 'string' || !path.isAbsolute(pwsh)
      || path.resolve(pwsh) !== pwsh || /[\0\r\n]/.test(pwsh)) {
      throw new Error('Windows preflight closeout requires explicit native PowerShell.');
    }
    const lock = captureLockOwner(supplied);
    const { root } = await externalWorkerDirectory(control, lock.project);
    await assertLockOwner(root, lock);
    await requireNoServiceMaintenance(root);
    await assertWindowsManagedTaskScope(scope, { signal });
    const observed = scope.observation;
    const state = await loadState(root);
    if (!state || !['deploy', 'update'].includes(state.operation) || state.phase !== 'preflight'
      || state.previousPhase !== null || state.errorCode !== null || state.backupId !== null
      || state.project !== lock.project || observed.project !== lock.project
      || state.operationId !== lock.operationId || state.startedAt !== lock.createdAt
      || state.priorRuntime !== 'running' || state.runtimeIdentity !== observed.runtime.generation) {
      throw new Error('Original live Windows preflight state differs.');
    }
    const check = async () => {
      signal?.throwIfAborted();
      await assertLockOwner(root, lock);
      await requireNoServiceMaintenance(root);
      await assertWindowsManagedTaskScope(scope, { signal });
      if (!same(await loadState(root), state)) throw new Error('Original Windows preflight state changed.');
    };
    await check();
    await operation.seal();
    await check();
    await writeState(root, {
      ...state, phase: 'preflight-refused', previousPhase: 'preflight',
      updatedAt: new Date().toISOString(), errorCode: 'DEPLOYMENT_ADMISSION_REFUSED',
    });
    await operation.retire();
    await assertWindowsManagedTaskScope(scope, { signal });
    await releaseLock(root, lock, { pwsh });
    return Object.freeze({ status: 'preflight-refused', operationId: lock.operationId });
  } catch (cause) {
    throw Object.assign(new Error(
      'Windows preflight closeout did not establish safe completion; retain original operation evidence.', { cause },
    ), {
      code: hasUnsettledWorker(cause) ? 'DEPLOYMENT_WORKER_UNSETTLED' : 'DEPLOYMENT_PREFLIGHT_CLOSEOUT_REFUSED',
      recoveryAllowed: false,
      nextAction: 'Inspect the original running task, lock and worker receipts; do not restart or restore the application.',
    });
  }
}
