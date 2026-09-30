import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, chown, link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { createSnapshot, verifySnapshot } from './snapshot.mjs';
import { fileDigest, inventorySnapshot, readSnapshotJson, realDirectory } from './snapshot-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { syncWorkerDirectory } from './worker-files.mjs';

const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const totalBytes = entries => {
  const bytes = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  if (!Number.isSafeInteger(bytes)) throw new Error('Git object byte count exceeds supported capacity.');
  return bytes;
};

function validateEntries(entries, commit) {
  const width = commit.length;
  const loose = new RegExp(`^[a-f0-9]{2}/[a-f0-9]{${width - 2}}$`);
  const packed = new RegExp(`^pack/pack-[a-f0-9]{${width}}\\.(pack|idx|rev|bitmap)$`);
  if (!entries.length || !entries.some(entry => entry.kind === 'file')) throw new Error('Git object store is empty.');
  for (const entry of entries) {
    if (entry.kind === 'directory' ? !/^(info|pack|[a-f0-9]{2})$/.test(entry.path)
      : entry.kind !== 'file' || !(loose.test(entry.path) || packed.test(entry.path))) {
      throw new Error('Unsupported Git object entry, alternate, promisor or writer state.');
    }
  }
  const files = new Set(entries.filter(entry => entry.kind === 'file').map(entry => entry.path));
  for (const file of files) {
    if (file.startsWith('pack/')) {
      const base = file.replace(/\.[^.]+$/, '');
      if (!files.has(`${base}.pack`) || !files.has(`${base}.idx`)) throw new Error('Incomplete Git object pack/index pair.');
    }
  }
}

export function validateGitObjects(value) {
  const descriptor = captureWorkerFields(value, ['version', 'bytes', 'sha256'], 'Git object snapshot');
  if (descriptor.version !== 1 || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '')) throw new Error('Invalid Git object snapshot descriptor.');
  return descriptor;
}

export async function prepareGitObjects({ project, commit, signal }) {
  const root = await realDirectory(path.join(project, '.git/objects'));
  const original = identity(await lstat(root, { bigint: true }));
  const names = (await readdir(root)).sort();
  const entries = await inventorySnapshot(root, names, { signal });
  validateEntries(entries, commit);
  const hashes = [];
  for (const entry of entries.filter(entry => entry.kind === 'file')) {
    hashes.push({ path: entry.path, sha256: await fileDigest(path.join(root, entry.path), { signal }) });
  }
  const check = async () => {
    signal?.throwIfAborted();
    if (await realDirectory(root) !== root || !same(identity(await lstat(root, { bigint: true })), original)
      || !same((await readdir(root)).sort(), names)
      || !same(await inventorySnapshot(root, names, { signal }), entries)) {
      throw new Error('Git object inventory changed during snapshot.');
    }
    for (const entry of hashes) {
      if (await fileDigest(path.join(root, entry.path), { signal }) !== entry.sha256) {
        throw new Error('Git object source checksum changed during snapshot.');
      }
    }
  };
  return {
    bytes: totalBytes(entries),
    async copy(destination) {
      await check();
      await createSnapshot({ project: root, destination, id: 'git-objects', files: names,
        source: { commit, provenance: 'observed' }, runtime: { platform: process.platform, state: 'stopped' },
        signal, checkSource: check });
      await check();
      return validateGitObjects({ version: 1, bytes: totalBytes(entries),
        sha256: await fileDigest(path.join(destination, 'manifest.json'), { signal }) });
    },
    check,
  };
}

export async function readGitObjectSnapshot(backup, manifest, { signal } = {}) {
  const descriptor = validateGitObjects(manifest.gitObjects);
  const directory = await realDirectory(path.join(backup, 'git-objects'));
  const file = path.join(directory, 'manifest.json');
  if (await fileDigest(file, { signal }) !== descriptor.sha256) throw new Error('Git object manifest checksum integrity failure.');
  const record = await readSnapshotJson(file);
  if (record.gitMetadata !== undefined || record.gitObjects !== undefined
    || record.project !== path.join(manifest.project, '.git/objects')
    || record.source?.commit !== manifest.source.commit || record.runtime?.platform !== manifest.runtime.platform
    || record.id !== 'git-objects' || record.scope !== 'selected'
    || record.externalFiles?.length || record.absentPaths?.length || record.excludedPaths?.length) {
    throw new Error('Git object snapshot binding is invalid.');
  }
  validateEntries(record.entries, manifest.source.commit);
  if (totalBytes(record.entries) !== descriptor.bytes) throw new Error('Git object snapshot size integrity failure.');
  const verified = await verifySnapshot(directory, { signal });
  if (!same(verified, record)) throw new Error('Git object snapshot changed.');
  return record;
}

export async function restoreGitObjects({ project, backup, manifest, checkStopped, signal }) {
  if (process.platform !== 'linux') throw new Error('Git object restoration requires Linux ownership support.');
  const saved = await readGitObjectSnapshot(backup, manifest, { signal });
  const git = await realDirectory(path.join(project, '.git'));
  const root = await realDirectory(path.join(git, 'objects'));
  const original = identity(await lstat(root, { bigint: true }));
  const check = async () => {
    signal?.throwIfAborted();
    const state = await checkStopped({ signal });
    if (state?.stopped !== true || state.inhibited !== true
      || await realDirectory(root) !== root || !same(identity(await lstat(root, { bigint: true })), original)) {
      throw new Error('Git object restoration authority changed.');
    }
  };
  await check();
  for (const entry of saved.entries.filter(entry => entry.kind === 'directory')) {
    const directory = path.join(root, entry.path);
    await check();
    try { await mkdir(directory, { mode: entry.mode }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await realDirectory(directory);
    await chown(directory, entry.uid, entry.gid);
    await chmod(directory, entry.mode);
  }
  const matches = async (file, entry, links = 1) => {
    let info;
    try { info = await lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== links || info.size !== entry.bytes
      || await fileDigest(file, { signal }) !== entry.sha256) {
      throw new Error('Existing Git object or staged publication differs from backup; retain evidence.');
    }
    return true;
  };
  for (const entry of saved.entries.filter(entry => entry.kind === 'file')
    .sort((a, b) => Number(b.path.endsWith('.pack')) - Number(a.path.endsWith('.pack')) || a.path.localeCompare(b.path))) {
    await check();
    const target = path.join(root, entry.path);
    const parent = await realDirectory(path.dirname(target));
    const stage = `${target}.agents-chat-restore`;
    let staged;
    let published;
    try { staged = await lstat(stage, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { published = await lstat(target, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (staged && published) {
      if (!same(identity(staged), identity(published))) throw new Error('Conflicting Git object publication evidence.');
      await matches(stage, entry, 2);
      await matches(target, entry, 2);
      await check();
      await unlink(stage);
      await syncWorkerDirectory(parent);
    }
    if (!await matches(target, entry)) {
      if (!await matches(stage, entry)) {
        await pipeline(
          createReadStream(path.join(backup, 'git-objects/files', entry.path), { flags: constants.O_RDONLY | constants.O_NOFOLLOW }),
          createWriteStream(stage, { flags: 'wx', mode: 0o600, flush: true }), { signal },
        );
        await matches(stage, entry);
      }
      await chown(stage, entry.uid, entry.gid);
      await chmod(stage, entry.mode);
      const handle = await open(stage, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      await check();
      await link(stage, target);
      await syncWorkerDirectory(parent);
      await unlink(stage);
      await syncWorkerDirectory(parent);
    }
  }
  await check();
  await syncWorkerDirectory(root);
}
