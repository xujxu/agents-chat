import path from 'node:path';
import { captureLockOwner } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { workerEngineFiles } from './saved-worker-engine.mjs';
import { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';
import { captureTaskListener } from './windows-task-controller.mjs';
import { captureRetirementFile, captureRetirementIdentity, captureRetirementCreator } from './windows-task-retirement-record.mjs';

const firstRecords = ['intent', 'registered', 'activation-prepared', 'activation-start-requested',
  'activation-running', 'completion-prepared', 'completion-policy-requested', 'completion-policy-staged',
  'completion-release-requested', 'completion-released', 'completion-policy-restore-requested',
  'completion-policy-restored', 'completion-enable-requested', 'completion-complete'];
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function captureWindowsFirstRetirementRecord(value) {
  const record = captureWorkerFields(value, [
    'version', 'purpose', 'control', 'project', 'lock', 'publisher', 'state', 'receipt', 'controlIdentity',
    'completion', 'checkpoint', 'entries', 'workerManifestSha256', 'creator',
  ], 'first retirement record');
  const lock = captureLockOwner(record.lock);
  const raw = captureWorkerFields(record.completion, [
    'status', 'mutationAuthority', 'phase', 'operationId', 'taskName', 'stateSha256', 'completionSha256',
    'runtime', 'port', 'providers', 'lease',
  ], 'first retirement completion');
  const { status, phase, ...common } = raw;
  const completion = captureWindowsTaskCompletionProof({ ...common, status: 'observed' });
  if (record.version !== 4 || record.purpose !== 'first-deployment' || record.project !== lock.project
    || record.control !== path.join(path.dirname(record.project), `.${path.basename(record.project)}.deployment`)
    || status !== 'first-completion-observed' || phase !== 'complete' || completion.operationId !== lock.operationId
    || !sha256(record.workerManifestSha256) || !Array.isArray(record.entries)
    || record.entries.length > workerEngineFiles.length + 52) {
    throw new Error('Invalid first deployment retirement scope.');
  }
  const publisher = captureWorkerFields(record.publisher, ['pid', 'processIdentity'], 'first publisher');
  if (!Number.isSafeInteger(publisher.pid) || publisher.pid < 1 || publisher.pid > 2147483647
    || typeof publisher.processIdentity !== 'string'
    || !new RegExp(`^${publisher.pid}:[1-9][0-9]*$`).test(publisher.processIdentity)
    || publisher.pid === lock.pid || [publisher.pid, lock.pid].includes(completion.runtime.pid)) {
    throw new Error('Invalid original first publisher.');
  }
  const state = captureRetirementFile(record.state, 'state.json');
  const receipt = captureRetirementFile(record.receipt, 'deployment.json');
  if (state.sha256 !== completion.stateSha256) throw new Error('First retirement acceptance differs.');
  const checkpoint = captureWorkerFields(record.checkpoint,
    ['configuration', 'definitionSha256', 'securityDescriptorSha256', 'enabled', 'listener'], 'first runtime checkpoint');
  const listener = captureWorkerFields(checkpoint.listener,
    ['pid', 'processIdentity', 'address', 'createdAt', 'pairedRecords'], 'first retirement listener');
  if (checkpoint.configuration !== path.join(record.control, `first-runtime-${lock.operationId}`, 'configuration.json')
    || checkpoint.enabled !== true || !sha256(checkpoint.definitionSha256) || !sha256(checkpoint.securityDescriptorSha256)
  ) throw new Error('Invalid first runtime checkpoint.');
  captureTaskListener({
    status: 'retained', generation: completion.runtime.generation, port: completion.port,
    pid: listener.pid, identity: listener.processIdentity, address: listener.address,
    createdAt: listener.createdAt, pairedRecords: listener.pairedRecords,
  }, completion.runtime, completion.port);
  const directory = `first-task-${lock.operationId}`;
  const paths = firstRecords.map(name => [`${directory}\\${name}.json`, 'file']);
  paths.push([directory, 'directory']);
  let index = paths.length;
  const journals = new Set();
  while (/^worker-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.ndjson$/.test(record.entries[index]?.path ?? '')) {
    const name = record.entries[index++].path;
    if (journals.has(name) || journals.size >= 32) throw new Error('Duplicate or excessive first workers.');
    journals.add(name);
    paths.push([name, 'file']);
  }
  for (const name of [...workerEngineFiles, 'manifest.json']) paths.push([`worker-engine\\${name}`, 'file']);
  paths.push(['worker-engine', 'directory'], ['worker-operation.ndjson', 'file'], ['lock\\owner.json', 'file'], ['lock', 'directory']);
  if (paths.length !== record.entries.length) throw new Error('Invalid first retirement inventory.');
  const entries = record.entries.map((value, index) => {
    const [expected, kind] = paths[index];
    const entry = captureWorkerFields(value, kind === 'file'
      ? ['kind', 'path', 'dev', 'ino', 'bytes', 'sha256'] : ['kind', 'path', 'dev', 'ino'], 'first retirement entry');
    if (entry.kind !== kind || entry.path !== expected) throw new Error('Invalid first retirement path or order.');
    if (kind === 'file') {
      const { kind: ignored, ...descriptor } = entry;
      captureRetirementFile(descriptor, expected);
    } else { captureRetirementIdentity({ dev: entry.dev, ino: entry.ino }); }
    return Object.freeze(entry);
  });
  if (entries[firstRecords.length - 1].sha256 !== completion.completionSha256
    || entries.find(entry => entry.path === 'worker-engine\\manifest.json').sha256 !== record.workerManifestSha256) {
    throw new Error('First retirement evidence digest differs.');
  }
  return Object.freeze({
    ...record, lock, publisher: Object.freeze(publisher), state, receipt,
    controlIdentity: captureRetirementIdentity(record.controlIdentity),
    completion: Object.freeze({ ...completion, status, phase }),
    checkpoint: Object.freeze({ ...checkpoint, listener: Object.freeze(listener) }),
    entries: Object.freeze(entries), creator: captureRetirementCreator(record.creator),
  });
}
