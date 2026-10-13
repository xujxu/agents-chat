import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureLockOwner } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { workerEngineFiles } from './saved-worker-engine.mjs';
import { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';
import { captureTaskListener } from './windows-task-controller.mjs';
import { windowsColdCompletionPhases } from './windows-cold-runtime-completion.mjs';
import { canonicalRetirementPath, captureRetirementFile, captureRetirementIdentity,
  captureRetirementProcess, captureRetirementCreator } from './windows-task-retirement-record.mjs';

const maintenance = ['admission.json', 'transaction.json', 'task-stop-intent.json',
  'task-stop-inhibited.json', 'task-stop-stop-requested.json', 'task-stop-stopped.json'];
const recovery = ['owner.json', 'files-restored.json', 'activation-intent.json',
  'activation-start-requested.json', 'activation-running.json',
  ...windowsColdCompletionPhases.map(phase => `completion-${phase}.json`)].sort();
export const windowsColdRetirementPaths = Object.freeze([
  ...maintenance.map(name => [`task-maintenance\\${name}`, 'file']), ['task-maintenance', 'directory'],
  ...recovery.map(name => [`recovery-lock\\${name}`, 'file']), ['recovery-lock', 'directory'],
  ...[...workerEngineFiles, 'manifest.json'].map(name => [`worker-engine\\${name}`, 'file']),
  ['worker-engine', 'directory'], ['worker-operation.ndjson', 'file'],
  ['cold-restore-terminal.json', 'file'], ['lock\\owner.json', 'file'], ['lock', 'directory'],
].map(([path, kind]) => Object.freeze({ path, kind })));
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const originalNames = ['restoreController', 'stoppedRuntime', 'coldController', 'activationBridge'];

export function captureWindowsColdRetirementRecord(value) {
  const record = captureWorkerFields(value, [
    'version', 'purpose', 'control', 'project', 'lock', 'controlIdentity', 'state', 'receipt', 'terminal',
    'completion', 'checkpoint', 'originals', 'workerManifestSha256', 'entries', 'creator',
  ], 'cold retirement record');
  const lock = Object.freeze(captureLockOwner(record.lock));
  const proof = captureWindowsTaskCompletionProof(record.completion);
  const completion = Object.freeze({ ...proof, runtime: Object.freeze({ ...proof.runtime }) });
  const state = Object.freeze(captureRetirementFile(record.state, 'state.json'));
  const receipt = Object.freeze(captureRetirementFile(record.receipt, 'deployment.json'));
  const terminal = Object.freeze(captureRetirementFile(record.terminal, 'cold-restore-terminal.json'));
  if (record.version !== 5 || record.purpose !== 'cold-restore'
    || !canonicalRetirementPath(record.control) || !canonicalRetirementPath(record.project)
    || record.project !== lock.project || completion.operationId !== lock.operationId
    || completion.stateSha256 !== state.sha256 || !sha256(record.workerManifestSha256)
    || !Array.isArray(record.entries) || record.entries.length !== windowsColdRetirementPaths.length) {
    throw new Error('Invalid cold retirement scope.');
  }
  const root = record.control.toLowerCase();
  const project = record.project.toLowerCase();
  if (root === project || root.startsWith(`${project.replace(/\\$/, '')}\\`)
    || project.startsWith(`${root.replace(/\\$/, '')}\\`)) throw new Error('Cold retirement control must be external.');
  const checkpoint = captureWorkerFields(record.checkpoint,
    ['configuration', 'definitionSha256', 'securityDescriptorSha256', 'enabled', 'listener'], 'cold retirement checkpoint');
  if (!canonicalRetirementPath(checkpoint.configuration)
    || path.win32.dirname(path.win32.dirname(checkpoint.configuration)) !== record.control
    || !/^runtime-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path.win32.basename(path.win32.dirname(checkpoint.configuration)))
    || path.win32.basename(checkpoint.configuration) !== 'configuration.json'
    || !sha256(checkpoint.definitionSha256) || !sha256(checkpoint.securityDescriptorSha256)
    || typeof checkpoint.enabled !== 'boolean') throw new Error('Invalid cold retirement runtime checkpoint.');
  const listener = captureWorkerFields(checkpoint.listener,
    ['pid', 'processIdentity', 'address', 'createdAt', 'pairedRecords'], 'cold retirement listener');
  captureTaskListener({
    status: 'retained', generation: completion.runtime.generation, port: completion.port,
    pid: listener.pid, identity: listener.processIdentity, address: listener.address,
    createdAt: listener.createdAt, pairedRecords: listener.pairedRecords,
  }, completion.runtime, completion.port);
  const original = captureWorkerFields(record.originals, originalNames, 'cold retirement original processes');
  const originals = Object.freeze(Object.fromEntries(originalNames.map(name => {
    const process = captureRetirementProcess(original[name]);
    if (process.processIdentity === completion.runtime.identity) throw new Error('Cold retirement would retire its active runtime.');
    return [name, Object.freeze(process)];
  })));
  if (!same(originals.restoreController, { pid: lock.pid, processIdentity: lock.processIdentity })) {
    throw new Error('Cold retirement original controller differs from the lock.');
  }
  const identities = new Set();
  const entries = Object.freeze(record.entries.map((value, index) => {
    const expected = windowsColdRetirementPaths[index];
    const fields = expected.kind === 'file'
      ? ['kind', 'path', 'dev', 'ino', 'bytes', 'sha256'] : ['kind', 'path', 'dev', 'ino'];
    const entry = captureWorkerFields(value, fields, 'cold retirement entry');
    if (entry.path !== expected.path || entry.kind !== expected.kind) throw new Error('Invalid cold retirement deletion order.');
    captureRetirementIdentity({ dev: entry.dev, ino: entry.ino });
    const identity = `${entry.dev}:${entry.ino}`;
    if (identities.has(identity)) throw new Error('Duplicate cold retirement file identity.');
    identities.add(identity);
    if (entry.kind === 'file') {
      const { kind, ...descriptor } = entry;
      const maximum = /^recovery-lock\\activation-(?:start-requested|running)\.json$/.test(entry.path) ? 4194304 : 1048576;
      captureRetirementFile(descriptor, entry.path, maximum);
    }
    return Object.freeze(entry);
  }));
  if (entries.find(entry => entry.path === 'recovery-lock\\completion-complete.json').sha256 !== completion.completionSha256
    || entries.find(entry => entry.path === 'worker-engine\\manifest.json').sha256 !== record.workerManifestSha256) {
    throw new Error('Cold retirement completion or worker evidence differs.');
  }
  const { kind, ...terminalEntry } = entries.find(entry => entry.path === terminal.path);
  if (!same(terminalEntry, terminal)) throw new Error('Cold retirement terminal handoff differs.');
  const controlIdentity = Object.freeze(captureRetirementIdentity(record.controlIdentity));
  for (const retained of [controlIdentity, state, receipt]) {
    const identity = `${retained.dev}:${retained.ino}`;
    if (identities.has(identity)) throw new Error('Cold retirement targets or aliases retained deployment evidence.');
    identities.add(identity);
  }
  return Object.freeze({
    ...record, lock, state, receipt, terminal, completion, controlIdentity, originals, entries,
    checkpoint: Object.freeze({ ...checkpoint, listener: Object.freeze(listener) }),
    creator: Object.freeze(captureRetirementCreator(record.creator)),
  });
}
