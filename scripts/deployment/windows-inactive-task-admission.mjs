import { captureLockOwner, validateState } from './state.mjs';
import { captureWindowsInactiveTaskObservation } from './windows-managed-task-observation.mjs';

export function createWindowsInactiveTaskAdmissionRecord({ observation, lock: supplied, state: suppliedState }) {
  const lock = captureLockOwner(supplied);
  const state = validateState(suppliedState);
  const original = captureWindowsInactiveTaskObservation(observation, lock.project, observation?.taskName);
  if (typeof original.taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(original.taskName)
    || !['deploy', 'update'].includes(state.operation) || state.phase !== 'preflight'
    || state.previousPhase !== null || state.errorCode !== null || state.priorRuntime !== 'stopped'
    || state.project !== lock.project || state.operationId !== lock.operationId
    || state.startedAt !== lock.createdAt || state.runtimeIdentity !== original.retiredRuntime.generation) {
    throw new Error('Inactive task admission requires its original locked stopped preflight.');
  }
  return Object.freeze({
    version: 2, kind: 'inactive', operationId: lock.operationId,
    controllerPid: lock.pid, controllerIdentity: lock.processIdentity,
    taskName: original.taskName, definition: original.definition, securityDescriptor: original.securityDescriptor,
    configuration: original.configuration, configurationSha256: original.configurationSha256,
    retiredRuntime: original.retiredRuntime,
  });
}
