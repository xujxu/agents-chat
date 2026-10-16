import path from 'node:path';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureActivatedRuntime } from './windows-task-controller.mjs';

const fields = [
  'status', 'runtimeAuthority', 'project', 'taskName', 'definition', 'securityDescriptor',
  'principalSid', 'enabled', 'configuration', 'configurationSha256', 'runtime',
];
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);

function captureRetiredRuntime(value) {
  const runtime = captureWorkerFields(value, [
    'pid', 'identity', 'generation', 'sessionId', 'configurationSha256', 'launcherPid', 'readySha256',
  ], 'retired runtime');
  if (![runtime.pid, runtime.launcherPid].every(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647)
    || !Number.isSafeInteger(runtime.sessionId) || runtime.sessionId < 0 || runtime.sessionId > 2147483647
    || typeof runtime.identity !== 'string' || runtime.identity.length > 64
    || !new RegExp(`^${runtime.pid}:[1-9][0-9]*$`).test(runtime.identity)
    || typeof runtime.generation !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runtime.generation)
    || runtime.generation === '00000000-0000-0000-0000-000000000000'
    || ![runtime.configurationSha256, runtime.readySha256].every(hash =>
      typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid retired runtime identity.');
  }
  return runtime;
}

function capture(value, project, taskName, inactive) {
  const record = captureWorkerFields(value, [...fields, inactive ? 'retiredRuntime' : 'lease'],
    'managed task observation');
  if (record.status !== (inactive ? 'inactive-task-observed' : 'managed-task-observed')
    || record.runtimeAuthority !== false || record.project !== project || record.taskName !== taskName
    || typeof record.definition !== 'string' || !record.definition || record.definition.length > 262144
    || record.definition.includes('\0')
    || typeof record.securityDescriptor !== 'string' || !record.securityDescriptor
    || record.securityDescriptor.length > 65536 || /[\0\r\n]/.test(record.securityDescriptor)
    || typeof record.principalSid !== 'string' || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(record.principalSid)
    || typeof record.enabled !== 'boolean' || !canonical(record.configuration)
    || path.basename(record.configuration) !== 'configuration.json'
    || typeof record.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.configurationSha256)
    || (inactive ? record.enabled !== false || record.runtime !== null
      : !['unguarded', 'released'].includes(record.lease))) {
    throw new Error('Invalid managed task observation.');
  }
  const key = inactive ? 'retiredRuntime' : 'runtime';
  const runtime = inactive ? captureRetiredRuntime(record[key]) : captureActivatedRuntime(record[key]);
  if (runtime.configurationSha256 !== record.configurationSha256) {
    throw new Error('Managed runtime configuration differs.');
  }
  return Object.freeze({ ...record, [key]: runtime });
}

export function captureWindowsManagedTaskObservation(value, project, taskName) {
  return capture(value, project, taskName, false);
}

export function captureWindowsInactiveTaskObservation(value, project, taskName) {
  return capture(value, project, taskName, true);
}
