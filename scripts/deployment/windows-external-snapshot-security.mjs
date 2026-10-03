import path from 'node:path';
import { captureWorkerFields } from './worker-identity.mjs';
import { validateWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';

function externalParents(entries) {
  const parents = new Map();
  for (const entry of entries) {
    const directory = path.dirname(entry.path);
    const key = directory.toLowerCase();
    if (!parents.has(key)) parents.set(key, { path: directory, entries: [] });
    const parent = parents.get(key);
    if (parent.path !== directory) throw new Error('Aliased Windows external snapshot parent.');
    if (entry.kind === 'file') parent.entries.push({ path: path.basename(entry.path), kind: 'file' });
  }
  return [...parents.values()];
}

export function validateWindowsExternalSnapshotSecurity(value, entries) {
  const record = captureWorkerFields(value, ['version', 'parents'], 'Windows external snapshot security');
  const expected = externalParents(entries);
  if (record.version !== 1 || !Array.isArray(record.parents) || record.parents.length !== expected.length) {
    throw new Error('Windows external snapshot parent inventory differs.');
  }
  const parents = record.parents.map((value, index) => {
    const parent = captureWorkerFields(value, ['path', 'metadata'], 'Windows external parent security');
    if (parent.path !== expected[index].path) throw new Error('Windows external snapshot parent differs.');
    return Object.freeze({
      path: parent.path, metadata: validateWindowsSnapshotSecurity(parent.metadata, expected[index].entries),
    });
  });
  return Object.freeze({ version: 1, parents: Object.freeze(parents) });
}

export async function captureWindowsExternalSnapshotSecurity({ entries, destination, retainSecurity, signal }) {
  if (process.platform !== 'win32' || typeof retainSecurity !== 'function') {
    throw new Error('Windows external capture requires snapshot-owned native security observers.');
  }
  const observers = [];
  const parents = [];
  for (const parent of externalParents(entries)) {
    signal?.throwIfAborted();
    const observer = await retainSecurity({
      project: parent.path, destinationParent: path.dirname(destination), entries: parent.entries, signal,
    });
    observers.push(observer);
    parents.push({ path: parent.path, metadata: observer.metadata });
  }
  return Object.freeze({
    metadata: validateWindowsExternalSnapshotSecurity({ version: 1, parents }, entries),
    check: async () => {
      for (const observer of observers) await observer.check({ signal });
    },
  });
}
