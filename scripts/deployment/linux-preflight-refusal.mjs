import {
  assertLockOwner, loadState, releaseLock, requireNoServiceMaintenance, writeState,
} from './state.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { linuxOriginalServiceHistory } from './linux-service-stop-evidence.mjs';

function refusal(blocked = false) {
  return Object.assign(new Error('Refused preflight closeout did not establish safe completion; retain the operation evidence.'), {
    code: blocked ? 'DEPLOYMENT_WORKER_UNSETTLED' : 'DEPLOYMENT_PREFLIGHT_CLOSEOUT_REFUSED',
    recoveryAllowed: false,
    nextAction: 'Inspect the original runtime, lock and worker receipts; do not restart or restore the application.',
  });
}

export async function closeRejectedLinuxPreflight({ control, lock, service, operation, signal }) {
  try {
    signal?.throwIfAborted();
    await assertLockOwner(control, lock);
    await requireNoServiceMaintenance(control);
    const state = await loadState(control);
    const runtime = service.identity.runtime;
    const history = linuxOriginalServiceHistory(service);
    if (!state || state.phase !== 'preflight' || state.operation === 'restore'
      || state.operationId !== lock.operationId || state.project !== lock.project
      || runtime.project !== state.project || state.priorRuntime !== history.priorRuntime
      || state.runtimeIdentity !== history.runtimeIdentity) throw refusal();
    await service.check();
    await operation.seal();
    await service.check();
    await requireNoServiceMaintenance(control);
    signal?.throwIfAborted();
    await writeState(control, {
      ...state, phase: 'preflight-refused', previousPhase: 'preflight',
      updatedAt: new Date().toISOString(), errorCode: 'DEPLOYMENT_ADMISSION_REFUSED',
    });
    await operation.retire();
    await releaseLock(control, lock);
    return Object.freeze({ status: 'preflight-refused', operationId: lock.operationId });
  } catch (error) {
    if (error?.code === 'DEPLOYMENT_PREFLIGHT_CLOSEOUT_REFUSED') throw error;
    throw refusal(hasUnsettledWorker(error));
  }
}
