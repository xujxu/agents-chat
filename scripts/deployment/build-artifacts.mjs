import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { fileDigest, inventorySnapshot, realDirectory } from './snapshot-files.mjs';
import { readWorkerFile } from './worker-files.mjs';

const excludedPaths = ['.next/cache', 'node_modules/.cache'];
const treeHash = entries => createHash('sha256').update(JSON.stringify(entries)).digest('hex');
const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const stamp = info => ({ ...identity(info), size: String(info.size), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs) });

export async function inspectBuildArtifacts({ project, signal }) {
  signal?.throwIfAborted();
  const root = await realDirectory(project);
  const original = identity(await lstat(root, { bigint: true }));
  const observe = async checkSignal => {
    checkSignal?.throwIfAborted();
    if (await realDirectory(project) !== root || !same(identity(await lstat(root, { bigint: true })), original)) {
      throw new Error('Build artifact project directory changed.');
    }
    await realDirectory(path.join(root, '.next'));
    await realDirectory(path.join(root, 'node_modules'));
    const names = ['package.json', 'package-lock.json', '.next', 'node_modules'];
    const entries = await inventorySnapshot(root, names, { signal: checkSignal, excludedPaths });
    const hashes = [];
    const stamps = [];
    for (const entry of entries) {
      checkSignal?.throwIfAborted();
      if (entry.kind !== 'file') { hashes.push(entry); continue; }
      const file = path.join(root, entry.path);
      const before = await lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(entry.bytes)) {
        throw new Error('Build artifact changed before hashing.');
      }
      const sha256 = await fileDigest(file, { signal: checkSignal });
      if (!same(stamp(await lstat(file, { bigint: true })), stamp(before))) throw new Error('Build artifact changed during hashing.');
      hashes.push({ ...entry, sha256 });
      stamps.push({ file, stamp: stamp(before) });
    }
    const buildId = new TextDecoder('utf-8', { fatal: true })
      .decode(await readWorkerFile(path.join(root, '.next/BUILD_ID'), 4096)).trim();
    if (!buildId || !/^[A-Za-z0-9_.-]+$/.test(buildId)) throw new Error('Invalid Next build identity.');
    if (!same(await inventorySnapshot(root, names, { signal: checkSignal, excludedPaths }), entries)) {
      throw new Error('Build artifact inventory changed during hashing.');
    }
    for (const entry of stamps) {
      checkSignal?.throwIfAborted();
      if (!same(stamp(await lstat(entry.file, { bigint: true })), entry.stamp)) {
        throw new Error('Build artifact changed before capture completed.');
      }
    }
    const subtree = name => hashes.filter(entry => entry.path === name || entry.path.startsWith(`${name}/`));
    return Object.freeze({
      version: 1, buildId, build: treeHash(subtree('.next')), dependencies: treeHash(subtree('node_modules')),
      package: hashes.find(entry => entry.path === 'package.json')?.sha256,
      lock: hashes.find(entry => entry.path === 'package-lock.json')?.sha256,
    });
  };
  const captured = await observe(signal);
  if (!captured.package || !captured.lock) throw new Error('Build artifacts require regular package and lock files.');
  return Object.freeze({
    identity: captured,
    async check({ signal: checkSignal = signal } = {}) {
      if (!same(await observe(checkSignal), captured)) throw new Error('Captured build artifacts changed.');
    },
  });
}
