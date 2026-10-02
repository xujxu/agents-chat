import { isDeepStrictEqual } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import { workerEngineFiles } from './saved-worker-engine.mjs';
import { captureWindowsTaskRetirementCheckpoint } from './windows-task-retirement-checkpoint.mjs';
import { captureRetirementFile, captureRetirementIdentity,
  captureRetirementCreator } from './windows-task-retirement-record.mjs';

const journal = /^worker-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.ndjson$/;
const directory = (value, expected) => {
  const entry = captureWorkerFields(value, ['kind', 'path', 'dev', 'ino'], 'retirement directory');
  captureRetirementIdentity({ dev: entry.dev, ino: entry.ino });
  if (entry.kind !== 'directory' || entry.path !== expected) throw new Error('Invalid retirement directory.');
  return entry;
};
const file = (value, expected) => {
  const entry = captureWorkerFields(value, ['kind', 'path', 'dev', 'ino', 'bytes', 'sha256'], 'retirement entry');
  const { kind, ...descriptor } = entry;
  if (kind !== 'file') throw new Error('Invalid retirement entry kind.');
  captureRetirementFile(descriptor, expected);
  return entry;
};
const identity = entry => ({ dev: entry.dev, ino: entry.ino });
const descriptor = ({ kind, ...entry }) => entry;

export function captureWindowsDeploymentRetirementRecord(value) {
  const record = captureWorkerFields(value,
    ['version', 'control', 'task', 'workerManifestSha256', 'entries', 'creator'], 'deployment retirement');
  const task = captureWindowsTaskRetirementCheckpoint(record.task);
  const intent = task.intent.intent;
  if (record.version !== 3 || record.control !== intent.control
    || typeof record.workerManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.workerManifestSha256)
    || !Array.isArray(record.entries) || record.entries.length < workerEngineFiles.length + 8
    || record.entries.length > workerEngineFiles.length + 40) {
    throw new Error('Invalid deployment retirement scope.');
  }
  const entries = [directory(record.entries[0], 'task-maintenance')];
  const journals = new Set();
  let index = 1;
  while (journal.test(record.entries[index]?.path)) {
    const entry = file(record.entries[index], record.entries[index].path);
    if (journals.has(entry.path) || journals.size >= 32) throw new Error('Duplicate or excessive retired workers.');
    journals.add(entry.path);
    entries.push(entry);
    index++;
  }
  for (const name of [...workerEngineFiles, 'manifest.json']) {
    entries.push(file(record.entries[index++], `worker-engine\\${name}`));
  }
  if (entries.at(-1).sha256 !== record.workerManifestSha256) throw new Error('Worker manifest digest differs.');
  entries.push(directory(record.entries[index++], 'worker-engine'));
  entries.push(file(record.entries[index++], 'worker-operation.ndjson'));
  for (const original of [task.intent.descriptor, task.descriptor, intent.lockFile]) {
    const entry = file(record.entries[index++], original.path);
    if (!isDeepStrictEqual(descriptor(entry), original)) throw new Error('Original task cleanup descriptor differs.');
    entries.push(entry);
  }
  entries.push(directory(record.entries[index++], 'lock'));
  if (index !== record.entries.length
    || !isDeepStrictEqual(identity(entries[0]), intent.maintenanceIdentity)
    || !isDeepStrictEqual(identity(entries.at(-1)), intent.lockIdentity)) {
    throw new Error('Original retirement directories or inventory differ.');
  }
  return Object.freeze({ ...record, task, entries: Object.freeze(entries),
    creator: captureRetirementCreator(record.creator) });
}

export function captureWindowsDeploymentRetirement(value) {
  const result = captureWorkerFields(value, ['status', 'retiredEntries', 'manifest'], 'deployment retirement observation');
  const manifest = captureWorkerFields(result.manifest, ['descriptor', 'record'], 'deployment retirement manifest');
  const record = captureWindowsDeploymentRetirementRecord(manifest.record);
  if (!['retiring-deployment', 'retired'].includes(result.status)
    || !Number.isSafeInteger(result.retiredEntries) || result.retiredEntries < 0
    || result.retiredEntries > record.entries.length
    || (result.status === 'retired' && result.retiredEntries !== record.entries.length)) {
    throw new Error('Invalid deployment retirement progress.');
  }
  return Object.freeze({ ...result, manifest: Object.freeze({
    descriptor: captureRetirementFile(manifest.descriptor, 'worker-retirement.json'), record,
  }) });
}
