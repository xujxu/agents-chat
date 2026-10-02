import path from 'node:path';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureLockOwner } from './state.mjs';
import { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';

const records = [
  'stop-intent', 'stop-inhibited', 'stop-stop-requested', 'stop-stopped',
  'retire-requested', 'retire-complete', 'replace-requested', 'replace-complete',
  'activate-requested', 'activate-prepared', 'activate-start-requested', 'activate-running',
  'complete-prepared', 'complete-policy-requested', 'complete-policy-staged', 'complete-release-requested',
  'complete-released', 'complete-policy-restore-requested', 'complete-policy-restored',
  'complete-enable-requested', 'complete-complete',
];
const files = ['admission.json', 'transaction.json', ...records.map(name => `task-${name}.json`)]
  .map(name => `task-maintenance\\${name}`);
const canonical = value => typeof value === 'string' && value.length <= 4096
  && /^[A-Za-z]:\\/.test(value) && !/[\0\r\n]/.test(value)
  && !value.slice(3).includes(':') && path.win32.resolve(value) === value;
const decimal = (value, maximum) => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)
  && BigInt(value) <= maximum;
function identity(value) {
  const result = captureWorkerFields(value, ['dev', 'ino'], 'retirement file identity');
  if (!decimal(result.dev, 4294967295n) || !decimal(result.ino, 18446744073709551615n)) {
    throw new Error('Invalid native retirement identity.');
  }
  return result;
}
function descriptor(value, expected) {
  const result = captureWorkerFields(value, ['path', 'dev', 'ino', 'bytes', 'sha256'], 'retirement file');
  identity({ dev: result.dev, ino: result.ino });
  if (result.path !== expected || !Number.isSafeInteger(result.bytes) || result.bytes < 1
    || result.bytes > 1024 * 1024 || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
    throw new Error('Invalid native retirement file descriptor.');
  }
  return result;
}
export { descriptor as captureRetirementFile, canonical as canonicalRetirementPath };
function processPair(pid, processIdentity) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647
    || typeof processIdentity !== 'string' || processIdentity.length > 64
    || !new RegExp(`^${pid}:[1-9][0-9]*$`).test(processIdentity)) {
    throw new Error('Invalid native retirement creator.');
  }
}
export function captureRetirementProcess(value) {
  const result = captureWorkerFields(value, ['pid', 'processIdentity'], 'retirement process');
  processPair(result.pid, result.processIdentity);
  return result;
}
export function captureRetirementCreator(value) {
  const result = captureWorkerFields(value,
    ['pid', 'processIdentity', 'bridgePid', 'bridgeIdentity'], 'retirement creator');
  processPair(result.pid, result.processIdentity);
  processPair(result.bridgePid, result.bridgeIdentity);
  if (result.pid === result.bridgePid) throw new Error('Ambiguous retirement creator.');
  return result;
}
export function captureWindowsTaskRetirement(value) {
  const result = captureWorkerFields(value, ['status', 'descriptor', 'intent'], 'retirement result');
  const intent = captureWorkerFields(result.intent, [
    'version', 'control', 'project', 'lock', 'lockFile', 'state', 'controlIdentity',
    'lockIdentity', 'maintenanceIdentity', 'completion', 'files', 'creator',
  ], 'retirement intent');
  const lock = captureLockOwner(intent.lock);
  const completion = captureWindowsTaskCompletionProof(intent.completion);
  const creator = captureRetirementCreator(intent.creator);
  processPair(lock.pid, lock.processIdentity);
  const lockFile = descriptor(intent.lockFile, 'lock\\owner.json');
  const state = descriptor(intent.state, 'state.json');
  if (result.status !== 'prepared' || intent.version !== 1
    || !canonical(intent.control) || !canonical(intent.project) || intent.project !== lock.project
    || completion.operationId !== lock.operationId || completion.stateSha256 !== state.sha256
    || !Array.isArray(intent.files) || intent.files.length !== files.length) {
    throw new Error('Invalid native retirement intent scope.');
  }
  const control = intent.control.toLowerCase();
  const project = intent.project.toLowerCase();
  if (control === project || control.startsWith(`${project.replace(/\\$/, '')}\\`)
    || project.startsWith(`${control.replace(/\\$/, '')}\\`)) {
    throw new Error('Retirement control must be external to its project.');
  }
  const capturedFiles = Object.freeze(intent.files.map((entry, index) => descriptor(entry, files[index])));
  if (capturedFiles.at(-1).sha256 !== completion.completionSha256) {
    throw new Error('Retirement completion receipt differs.');
  }
  return Object.freeze({ status: result.status, descriptor: descriptor(result.descriptor, 'task-retirement.json'),
    intent: Object.freeze({ ...intent, lock, lockFile, state, completion, creator, files: capturedFiles,
      controlIdentity: identity(intent.controlIdentity), lockIdentity: identity(intent.lockIdentity),
      maintenanceIdentity: identity(intent.maintenanceIdentity) }) });
}
