import { captureWorkerFields } from './worker-identity.mjs';
import { validateReadinessProviders } from './http-readiness.mjs';
import { captureActivatedRuntime } from './windows-task-controller.mjs';

export function captureWindowsTaskCompletionProof(value) {
  const result = captureWorkerFields(value, [
    'status', 'mutationAuthority', 'operationId', 'taskName', 'stateSha256',
    'completionSha256', 'runtime', 'port', 'providers', 'lease',
  ], 'completed task proof');
  if (result.status !== 'observed' || result.mutationAuthority !== false
    || result.lease !== 'released'
    || typeof result.operationId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.operationId)
    || result.operationId === '00000000-0000-0000-0000-000000000000'
    || typeof result.taskName !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(result.taskName)
    || ![result.stateSha256, result.completionSha256].every(hash =>
      typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    || !Number.isSafeInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error('Invalid completed-task proof observation.');
  }
  validateReadinessProviders(result.providers);
  return Object.freeze({ ...result, runtime: captureActivatedRuntime(result.runtime),
    providers: Object.freeze([...result.providers]) });
}
