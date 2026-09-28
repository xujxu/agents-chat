import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inventorySnapshot, realDirectory } from './snapshot-files.mjs';

const excludedRoots = Object.freeze(['.git', 'logs', '.npm', '.pnpm-store']);
const excludedPaths = Object.freeze([...excludedRoots, '.next/cache', 'node_modules/.cache']);
const optionalPaths = Object.freeze([
  '.data', '.next', 'node_modules', 'agents.json', 'nodes.json',
  '.env', '.env.local', '.env.production', '.env.production.local',
]);

export async function inspectSnapshotScope({ project, signal }) {
  signal?.throwIfAborted();
  const root = await realDirectory(project);
  const original = await lstat(root, { bigint: true });
  const names = (await readdir(root)).sort();
  if (process.platform === 'win32' && names.some(name =>
    [...excludedRoots, ...optionalPaths].some(known => name.toLowerCase() === known.toLowerCase() && name !== known))) {
    throw new Error('Deployment snapshot scope requires canonical runtime path casing.');
  }
  const files = names.filter(name => !excludedRoots.includes(name));
  const absentPaths = optionalPaths.filter(name => !names.includes(name));
  const entries = await inventorySnapshot(root, files, { signal, excludedPaths });
  let snapshotBytes = 0;
  for (const entry of entries) {
    snapshotBytes += entry.bytes ?? 0;
    if (!Number.isSafeInteger(snapshotBytes)) throw new Error('Snapshot scope byte count exceeds safe capacity range.');
  }
  const check = async ({ signal: checkSignal = signal } = {}) => {
    checkSignal?.throwIfAborted();
    const current = await realDirectory(project);
    const info = await lstat(current, { bigint: true });
    const now = (await readdir(current)).sort().filter(name => !excludedRoots.includes(name));
    if (current !== root || info.dev !== original.dev || info.ino !== original.ino || !same(now, files)) {
      throw new Error('Project snapshot scope changed after inspection.');
    }
  };
  await check();
  return Object.freeze({
    files: Object.freeze(files), absentPaths: Object.freeze(absentPaths), excludedPaths,
    snapshotBytes, entryCount: entries.length, check,
  });
}
