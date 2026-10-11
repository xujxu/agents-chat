import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, chown, link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { createSnapshot, verifySnapshot } from './snapshot.mjs';
import { fileDigest, inventorySnapshot, readSnapshotJson, realDirectory } from './snapshot-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { syncWorkerDirectory } from './worker-files.mjs';
import { inspectGitGraphPointers, isGitGraphMetadata, restoreGitGraphMetadata } from './git-graph-metadata.mjs';
import { prepareWindowsGitObjectSecurity } from './windows-git-object-security.mjs';

const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const excludedPaths = ['info/packs'];
const totalBytes = entries => {
  const bytes = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  if (!Number.isSafeInteger(bytes)) throw new Error('Git object byte count exceeds supported capacity.');
  return bytes;
};

function validateEntries(entries, commit, restoring) {
  const width = commit.length;
  const loose = new RegExp(`^[a-f0-9]{2}/[a-f0-9]{${width - 2}}$`);
  const packed = new RegExp(`^pack/pack-[a-f0-9]{${width}}\\.(pack|idx|rev|bitmap)$`);
  const graph = new RegExp(`^info/commit-graphs/graph-[a-f0-9]{${width}}\\.graph$`);
  if (!restoring && (!entries.length || !entries.some(entry => entry.kind === 'file'))) throw new Error('Git object store is empty.');
  for (const entry of entries) {
    const name = restoring && entry.path.endsWith('.agents-chat-restore')
      && restoring.has(entry.path.slice(0, -'.agents-chat-restore'.length))
      && !isGitGraphMetadata(entry.path.slice(0, -'.agents-chat-restore'.length))
      ? entry.path.slice(0, -'.agents-chat-restore'.length) : entry.path;
    if (entry.kind === 'directory' ? !/^(info(?:\/commit-graphs)?|pack|[a-f0-9]{2})$/.test(entry.path)
      : entry.kind !== 'file' || !(loose.test(name) || packed.test(name) || graph.test(name) || isGitGraphMetadata(name))) {
      throw new Error(`Unsupported Git object entry, alternate, promisor or writer state: ${entry.path}`);
    }
  }
  const files = new Set(entries.filter(entry => entry.kind === 'file').map(entry => entry.path));
  for (const file of restoring ? [] : files) {
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

export async function prepareGitObjects({ project, commit, signal, pwsh }) {
  const root = await realDirectory(path.join(project, '.git/objects'));
  const original = identity(await lstat(root, { bigint: true }));
  const names = (await readdir(root)).sort();
  const entries = await inventorySnapshot(root, names, { signal, excludedPaths });
  validateEntries(entries, commit);
  const hashes = [];
  for (const entry of entries.filter(entry => entry.kind === 'file')) {
    hashes.push({ path: entry.path, sha256: await fileDigest(path.join(root, entry.path), { signal }) });
  }
  const check = async () => {
    signal?.throwIfAborted();
    if (await realDirectory(root) !== root || !same(identity(await lstat(root, { bigint: true })), original)
      || !same((await readdir(root)).sort(), names)
      || !same(await inventorySnapshot(root, names, { signal, excludedPaths }), entries)) {
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
        signal, pwsh, excludedPaths, checkSource: check });
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
    || record.externalFiles?.length || record.absentPaths?.length || !same(record.excludedPaths, excludedPaths)) {
    throw new Error('Git object snapshot binding is invalid.');
  }
  validateEntries(record.entries, manifest.source.commit);
  if (totalBytes(record.entries) !== descriptor.bytes) throw new Error('Git object snapshot size integrity failure.');
  const verified = await verifySnapshot(directory, { signal });
  if (!same(verified, record)) throw new Error('Git object snapshot changed.');
  return record;
}

export async function restoreGitObjects({ project, backup, manifest, checkStopped, signal, pwsh }) {
  const resources = { permissions: null };
  let failure;
  try { await restoreObjects({ project, backup, manifest, checkStopped, signal, pwsh, resources }); }
  catch (error) { failure = error; }
  try { await resources.permissions?.close(); }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Git object restoration and cleanup failed.') : error; }
  if (failure) throw failure;
}

async function restoreObjects({ project, backup, manifest, checkStopped, signal, pwsh, resources }) {
  if (!['linux', 'win32'].includes(process.platform)) throw new Error('Git object restoration requires native ownership support.');
  if (typeof checkStopped !== 'function') throw new Error('Git object restoration requires stopped runtime authority.');
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
    signal?.throwIfAborted();
    await resources.permissions?.check({ signal });
    signal?.throwIfAborted();
  };
  await check();
  const currentNames = await readdir(root);
  const current = currentNames.length ? await inventorySnapshot(root, currentNames, { signal, excludedPaths }) : [];
  validateEntries(current, manifest.source.commit,
    new Set(saved.entries.filter(entry => entry.kind === 'file').map(entry => entry.path)));
  if (process.platform === 'win32') {
    await inspectGitGraphPointers(root);
    resources.permissions = await prepareWindowsGitObjectSecurity({
      project: root, backup: path.join(backup, 'git-objects'), manifest: saved, current, signal, pwsh,
    });
  }
  const permissions = resources.permissions;
  for (const entry of saved.entries.filter(entry => entry.kind === 'directory')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const directory = path.join(root, entry.path);
    await check();
    if (permissions) {
      await permissions.directory({ entry, signal });
      continue;
    }
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
  for (const entry of saved.entries.filter(entry => entry.kind === 'file' && !isGitGraphMetadata(entry.path))
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
      if (permissions) await permissions.removeStage({ entry, signal });
      else await unlink(stage);
      await syncWorkerDirectory(parent);
    }
    if (!await matches(target, entry)) {
      if (!await matches(stage, entry)) {
        if (permissions) await permissions.createStage({ entry, signal });
        await pipeline(
          createReadStream(path.join(backup, 'git-objects/files', entry.path), { flags: constants.O_RDONLY | constants.O_NOFOLLOW }),
          createWriteStream(stage, { flags: permissions ? 'r+' : 'wx', mode: 0o600, flush: true }), { signal },
        );
        await matches(stage, entry);
        if (permissions) await permissions.finishStage({ entry, signal });
      }
      if (permissions) await permissions.stagePolicy({ entry, signal });
      else {
        await chown(stage, entry.uid, entry.gid);
        await chmod(stage, entry.mode);
        const handle = await open(stage, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
      }
      await check();
      await link(stage, target);
      await syncWorkerDirectory(parent);
      if (permissions) await permissions.removeStage({ entry, signal });
      else await unlink(stage);
      await syncWorkerDirectory(parent);
    }
    if (!await matches(target, entry)) throw new Error('Restored Git object disappeared.');
    if (permissions) await permissions.targetPolicy({ entry, signal });
  }
  await restoreGitGraphMetadata({ root, backup, entries: saved.entries, check, signal, permissions });
  if (permissions) await permissions.verify({ signal });
  await check();
  for (const entry of saved.entries.filter(entry => entry.kind === 'file')) {
    await realDirectory(path.dirname(path.join(root, entry.path)));
    if (!await matches(path.join(root, entry.path), entry)) throw new Error('Restored Git object disappeared.');
  }
  await syncWorkerDirectory(root);
}
