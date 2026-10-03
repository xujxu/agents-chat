import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import { assertSnapshotAbsent, realDirectory, relativeSnapshotPath, snapshotPathList } from './snapshot-files.mjs';
import { validateWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';

export function windowsGitMetadataInventory(ref) {
  const entries = [{ path: 'HEAD', kind: 'file' }, { path: 'index', kind: 'file' }];
  if (ref !== null) {
    relativeSnapshotPath(ref);
    if (!ref.startsWith('refs/heads/')) throw new Error('Windows Git metadata requires a branch reference.');
    const parts = ref.split('/');
    for (let count = 1; count < parts.length; count++) {
      entries.push({ path: parts.slice(0, count).join('/'), kind: 'directory' });
    }
    entries.push({ path: ref, kind: 'file' });
  }
  return entries;
}

export function validateWindowsGitSnapshotSecurity(value, ref) {
  const fields = captureWorkerFields(value, ['windowsSecurity', 'absentPaths'], 'Windows Git snapshot security');
  const inventory = windowsGitMetadataInventory(ref);
  const absentPaths = snapshotPathList(fields.absentPaths);
  const absent = new Set(absentPaths);
  const ordered = inventory.filter(entry => absent.has(entry.path)).map(entry => entry.path);
  if (absent.has('HEAD') || absent.has('index') || !same(ordered, absentPaths)) {
    throw new Error('Windows Git metadata absence must match its permitted inventory.');
  }
  const entries = inventory.filter(entry => !absent.has(entry.path));
  if (entries.some(entry => absentPaths.some(parent => entry.path.startsWith(`${parent}/`)))) {
    throw new Error('Windows Git metadata descendants of absent parents must also be absent.');
  }
  const windowsSecurity = validateWindowsSnapshotSecurity(fields.windowsSecurity, entries);
  return Object.freeze({ windowsSecurity, absentPaths: Object.freeze(absentPaths) });
}

export async function prepareWindowsGitSnapshotSecurity({
  project, destinationParent, record, retainSecurity, signal,
}) {
  signal?.throwIfAborted();
  const directory = await realDirectory(path.join(project, '.git'));
  const entries = [];
  const absentPaths = [];
  for (const entry of windowsGitMetadataInventory(record.ref)) {
    signal?.throwIfAborted();
    let info;
    try { info = await lstat(path.join(directory, entry.path)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      absentPaths.push(entry.path);
      continue;
    }
    if (info.isSymbolicLink() || (entry.kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw new Error('Unsupported Windows Git metadata source type or links.');
    }
    entries.push(entry);
  }
  const observer = await retainSecurity({ project: directory, destinationParent, entries, signal });
  const captured = validateWindowsGitSnapshotSecurity({ windowsSecurity: observer.metadata, absentPaths }, record.ref);
  const check = async () => {
    signal?.throwIfAborted();
    await assertSnapshotAbsent(directory, captured.absentPaths);
    await observer.check({ signal });
    await assertSnapshotAbsent(directory, captured.absentPaths);
  };
  await check();
  return Object.freeze({ ...captured, check });
}
