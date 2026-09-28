import { createHash } from 'node:crypto';
import {
  lstat, mkdir, readdir, readlink, statfs, symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual as same } from 'node:util';
import {
  assertSnapshotAbsent, captureSnapshotInventory, fileDigest, inventorySnapshot, readSnapshotJson, realDirectory,
  relativeSnapshotPath, snapshotPathList, writePrivateFile,
} from './snapshot-files.mjs';
export { inventorySnapshot } from './snapshot-files.mjs';
export { rotateSnapshot, reconcileSnapshotSlots } from './snapshot-rotation.mjs';
import { captureExternalSnapshot, validateExternalSnapshot, verifyExternalSnapshot } from './snapshot-external.mjs';
import { syncWorkerDirectory } from './worker-files.mjs';
import { projectSnapshotExclusions } from './snapshot-scope.mjs';

const projectMetadata = info => ({ mode: info.mode & 0o777, uid: info.uid, gid: info.gid });

export function estimateRequiredBytes({ snapshotBytes, metadataBytes, deploymentBytes }) {
  const values = [snapshotBytes, metadataBytes, deploymentBytes];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(values.reduce((sum, value) => sum + value, 0))) {
    throw new Error('Snapshot bytes must be nonnegative safe integers.');
  }
  return values.reduce((sum, value) => sum + value, 0);
}

function validateManifest(manifest) {
  if (manifest?.version !== 1 || !/^[a-zA-Z0-9_-]+$/.test(manifest.id ?? '')
    || typeof manifest.project !== 'string' || !path.isAbsolute(manifest.project)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.source?.commit ?? '')
    || !['observed', 'verified'].includes(manifest.source?.provenance)
    || manifest.runtime?.state !== 'stopped' || !['linux', 'win32'].includes(manifest.runtime?.platform)
    || !Array.isArray(manifest.entries)) throw new Error('Invalid snapshot manifest.');
  if (manifest.scope !== undefined && !['project', 'selected'].includes(manifest.scope)) {
    throw new Error('Invalid snapshot scope.');
  }
  if (manifest.scope === 'project' && (!same(manifest.excludedPaths, projectSnapshotExclusions)
    || !manifest.projectMetadata)) throw new Error('Incomplete project snapshot scope.');
  if (manifest.projectMetadata !== undefined) {
    const info = manifest.projectMetadata;
    if (!info || !Number.isInteger(info.mode) || info.mode < 0 || info.mode > 0o777
      || !Number.isSafeInteger(info.uid) || info.uid < 0 || !Number.isSafeInteger(info.gid) || info.gid < 0
      || !same(Object.keys(info).sort(), ['gid', 'mode', 'uid'])) {
      throw new Error('Invalid snapshot project metadata.');
    }
  }
  validateExternalSnapshot(manifest.externalFiles ?? [], manifest.project);
  const seen = new Map();
  for (const entry of manifest.entries) {
    relativeSnapshotPath(entry.path);
    const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    if (seen.has(key)) throw new Error('Duplicate snapshot manifest path.');
    if (!['directory', 'file', 'link'].includes(entry.kind)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || !Number.isSafeInteger(entry.uid) || entry.uid < 0
      || !Number.isSafeInteger(entry.gid) || entry.gid < 0) throw new Error('Invalid snapshot metadata.');
    if (entry.kind === 'file' && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))) throw new Error('Invalid snapshot checksum metadata.');
    if (entry.kind === 'link' && (typeof entry.target !== 'string' || !entry.target
      || path.isAbsolute(entry.target) || /[\0\r\n]/.test(entry.target))) throw new Error('Invalid snapshot link.');
    seen.set(key, entry);
  }
  const absent = snapshotPathList(manifest.absentPaths ?? []);
  const excluded = snapshotPathList(manifest.excludedPaths ?? []);
  for (const name of absent) {
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if ([...seen].some(([stored, entry]) => stored === key || stored.startsWith(`${key}/`)
      || entry.kind !== 'directory' && key.startsWith(`${stored}/`))) {
      throw new Error('Snapshot absent path conflicts with captured inventory.');
    }
  }
  for (const name of excluded) {
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if ([...seen.keys()].some(stored => stored === key || stored.startsWith(`${key}/`))) {
      throw new Error('Snapshot excluded path conflicts with captured inventory.');
    }
  }
  for (const entry of manifest.entries) {
    const parts = entry.path.split('/');
    while (parts.length > 1) {
      parts.pop();
      const parent = parts.join('/');
      const key = process.platform === 'win32' ? parent.toLowerCase() : parent;
      if (seen.get(key)?.kind !== 'directory') throw new Error('Missing or unsafe snapshot parent directory.');
    }
  }
  return manifest;
}

export async function createSnapshot({
  project, destination, id, files, source, runtime, signal, absentPaths = [], excludedPaths = [],
  externalFiles = [], checkSource, projectScope = false,
}) {
  signal?.throwIfAborted();
  if (checkSource !== undefined && typeof checkSource !== 'function') throw new Error('Snapshot source check must be callable.');
  await checkSource?.();
  if (runtime?.state !== 'stopped') throw new Error('Snapshot requires a stopped runtime.');
  const root = await realDirectory(project);
  const rootInfo = await lstat(root);
  if (rootInfo.mode & 0o7000 || typeof projectScope !== 'boolean') throw new Error('Unsupported project snapshot metadata.');
  const checkProject = async () => {
    signal?.throwIfAborted();
    const current = await lstat(await realDirectory(project));
    if (current.dev !== rootInfo.dev || current.ino !== rootInfo.ino
      || !same(projectMetadata(current), projectMetadata(rootInfo))) throw new Error('Snapshot project metadata changed.');
    if (projectScope) {
      const included = (await readdir(root)).sort().filter(name => !projectSnapshotExclusions.includes(name));
      if (!Array.isArray(files) || !same([...files].sort(), included)
        || !same(excludedPaths, projectSnapshotExclusions)) throw new Error('Incomplete project snapshot scope inventory.');
    }
  };
  await checkProject();
  const parent = await realDirectory(path.dirname(destination));
  const target = path.resolve(destination);
  if (target === root || target.startsWith(root + path.sep)) {
    throw new Error('Snapshot destination must be outside the application.');
  }
  const external = await captureExternalSnapshot({ files: externalFiles, project: root, destination: target, signal });
  absentPaths = snapshotPathList(absentPaths);
  excludedPaths = snapshotPathList(excludedPaths);
  await assertSnapshotAbsent(root, absentPaths);
  const entries = await captureSnapshotInventory(root, files, { signal, excludedPaths });
  const manifest = {
    version: 1, id, project: root, createdAt: new Date().toISOString(), source, runtime, absentPaths, excludedPaths,
    scope: projectScope ? 'project' : 'selected', projectMetadata: projectMetadata(rootInfo),
    externalFiles: external.entries,
    entries: entries.map(entry => entry.kind === 'file' ? { ...entry, sha256: '0'.repeat(64) } : entry),
  };
  validateManifest(manifest);
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  if (manifestBytes > 32 * 1024 * 1024) throw new Error('Snapshot manifest exceeds size limit.');
  const snapshotBytes = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), external.bytes);
  const required = estimateRequiredBytes({ snapshotBytes, metadataBytes: manifestBytes + 64 * 1024, deploymentBytes: 0 });
  const space = await statfs(parent, { bigint: true });
  if (space.bavail * space.bsize < BigInt(required)) throw new Error('Insufficient space for snapshot bytes.');
  signal?.throwIfAborted();
  await mkdir(target, { mode: 0o700 });
  await writePrivateFile(path.join(target, 'owner.json'), JSON.stringify({ version: 1, project: root, id }));
  const contents = path.join(target, 'files');
  await mkdir(contents, { mode: 0o700 });
  const ordered = [...manifest.entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const entry of ordered.filter(item => item.kind === 'directory')) {
    signal?.throwIfAborted();
    await mkdir(path.join(contents, entry.path), { mode: 0o700 });
  }
  for (const entry of ordered.filter(item => item.kind === 'file')) {
    signal?.throwIfAborted();
    const from = path.join(root, entry.path);
    const to = path.join(contents, entry.path);
    await realDirectory(path.dirname(from));
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) {
      throw new Error('Snapshot source changed during copying.');
    }
    signal?.throwIfAborted();
    await pipeline(
      createReadStream(from, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }),
      createWriteStream(to, { flags: 'wx', mode: 0o600, flush: true }), { signal },
    );
    entry.sha256 = await fileDigest(to, { signal });
    if (entry.sha256 !== await fileDigest(from, { signal })) throw new Error('Snapshot source checksum changed during copying.');
  }
  for (const entry of ordered.filter(item => item.kind === 'link')) {
    signal?.throwIfAborted();
    if (process.platform === 'win32') {
      throw new Error('Windows snapshot links require native ACL/reparse support before capture.');
    }
    await symlink(entry.target, path.join(contents, entry.path));
  }
  await external.copy();
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('Snapshot manifest exceeds size limit.');
  await assertSnapshotAbsent(root, absentPaths);
  await external.check();
  signal?.throwIfAborted();
  await writePrivateFile(path.join(target, 'manifest.json'), serialized);
  signal?.throwIfAborted();
  await checkSource?.();
  await checkProject();
  await assertSnapshotAbsent(root, absentPaths);
  if (!same(entries, await captureSnapshotInventory(root, files, { signal, excludedPaths }))) {
    throw new Error('Snapshot source inventory or metadata changed during capture.');
  }
  for (const entry of manifest.entries.filter(item => item.kind === 'file')) {
    if (entry.sha256 !== await fileDigest(path.join(root, entry.path), { signal })) {
      throw new Error('Snapshot source checksum changed before completion.');
    }
  }
  await external.check();
  await verifySnapshotContents(target, manifest, { signal, complete: false });
  const manifestDigest = createHash('sha256').update(serialized).digest('hex');
  if (manifestDigest !== await fileDigest(path.join(target, 'manifest.json'), { signal })) {
    throw new Error('Snapshot manifest integrity failure before completion.');
  }
  for (const entry of ordered.filter(item => item.kind === 'directory').reverse()) {
    signal?.throwIfAborted();
    await syncWorkerDirectory(path.join(contents, entry.path));
  }
  await syncWorkerDirectory(contents);
  if (external.entries.length) await syncWorkerDirectory(path.join(target, 'external'));
  await syncWorkerDirectory(target);
  signal?.throwIfAborted();
  await writePrivateFile(path.join(target, 'complete.json'), JSON.stringify({
    version: 1, id, sha256: manifestDigest,
  }));
  await syncWorkerDirectory(target);
  await syncWorkerDirectory(parent);
  return verifySnapshot(target, { signal });
}

export async function verifySnapshot(destination, { signal } = {}) {
  signal?.throwIfAborted();
  const root = await realDirectory(destination);
  let completion;
  try { completion = await readSnapshotJson(path.join(root, 'complete.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Incomplete snapshot: completion marker missing.', { cause: error });
    throw error;
  }
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = validateManifest(await readSnapshotJson(manifestFile));
  if (completion.version !== 1 || completion.id !== manifest.id
    || completion.sha256 !== await fileDigest(manifestFile, { signal })) throw new Error('Snapshot manifest integrity failure.');
  await verifySnapshotContents(root, manifest, { signal });
  return manifest;
}

async function verifySnapshotContents(root, manifest, { signal, complete = true }) {
  const owner = await readSnapshotJson(path.join(root, 'owner.json'));
  if (owner.version !== 1 || owner.id !== manifest.id || owner.project !== manifest.project) {
    throw new Error('Snapshot owner does not match manifest.');
  }
  const topLevel = (await readdir(root)).sort();
  const expectedTopLevel = [...(complete ? ['complete.json'] : []), 'files', 'manifest.json', 'owner.json',
    ...(manifest.externalFiles?.length ? ['external'] : [])].sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel)) {
    throw new Error('Unexpected snapshot files; inspection required.');
  }
  await verifyExternalSnapshot(root, manifest.externalFiles ?? [], signal);
  const contents = await realDirectory(path.join(root, 'files'));
  await assertSnapshotAbsent(contents, manifest.absentPaths ?? []);
  const observed = await inventorySnapshot(contents, await readdir(contents), { signal });
  const byPath = new Map(observed.map(entry => [entry.path, entry]));
  if (byPath.size !== manifest.entries.length) throw new Error('Snapshot inventory integrity failure.');
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    const actual = byPath.get(entry.path);
    if (!actual || actual.kind !== entry.kind) throw new Error('Snapshot file type integrity failure.');
    const file = path.join(contents, entry.path);
    if (entry.kind === 'file' && (actual.bytes !== entry.bytes || await fileDigest(file, { signal }) !== entry.sha256)) {
      throw new Error(`Snapshot file size or checksum integrity failure: ${entry.path}`);
    }
    if (entry.kind === 'link' && await readlink(file) !== entry.target) throw new Error('Snapshot link integrity failure.');
  }
}
