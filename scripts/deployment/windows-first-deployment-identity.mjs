import { captureWorkerFields } from './worker-identity.mjs';

export function captureWindowsFirstDeploymentIdentity(value) {
  const record = captureWorkerFields(value, ['source', 'build', 'dependencies', 'config'],
    'first deployment identity');
  if (typeof record.source !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.source)
    || ['build', 'dependencies', 'config'].some(name =>
      typeof record[name] !== 'string' || !/^[a-f0-9]{64}$/.test(record[name]))) {
    throw new Error('Invalid original first deployment identity.');
  }
  return Object.freeze(record);
}
