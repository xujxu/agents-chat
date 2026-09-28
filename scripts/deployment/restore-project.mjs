import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, chown, lchown, lstat, mkdir, open, readdir, realpath, rmdir, statfs, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { verifySnapshot } from './snapshot.mjs';
import { assertSnapshotAbsent, fileDigest, inventorySnapshot, realDirectory } from './snapshot-files.mjs';
import { projectSnapshotExclusions } from './snapshot-scope.mjs';
import { canonicalWorkerDirectory, closeWorkerFile, syncWorkerDirectory } from './worker-files.mjs';

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const depth = entry => entry.path.split('/').length;
const metadata = entry => {
  const { sha256, ...rest } = entry;
  return rest;
};
const byPath = entries => [...entries].sort((a, b) => a.path.localeCompare(b.path));

export async function restoreProjectSnapshot({ project, backup, acceptDataLoss, checkStopped, signal, expectedSnapshot }) {
  signal?.throwIfAborted();
  if (process.platform !== 'linux') throw new Error('Project restoration requires Linux metadata; Windows requires native ACL restoration.');
  if (acceptDataLoss !== true || typeof checkStopped !== 'function') {
    throw new Error('Project restore requires data-loss acknowledgement and stopped runtime authority.');
  }
  const root = await realDirectory(project);
  const original = await lstat(root);
  const saved = (await canonicalWorkerDirectory(backup, { privateMode: true })).root;
  if (inside(root, saved) || inside(saved, root)) throw new Error('Restore backup must be outside the project.');
  const manifest = await verifySnapshot(saved, { signal });
  if (expectedSnapshot !== undefined && !same(manifest, expectedSnapshot)) throw new Error('Admitted project restore backup changed.');
  if (manifest.project !== root || manifest.runtime.platform !== 'linux') throw new Error('Restore backup project owner or platform differs.');
  if (manifest.scope !== 'project' || !manifest.projectMetadata
    || !same(manifest.excludedPaths, projectSnapshotExclusions)) {
    throw new Error('Restoration requires a complete-project snapshot scope.');
  }
  if (process.getuid() !== 0 && [manifest.projectMetadata, ...manifest.entries].some(entry =>
    entry.uid !== process.getuid() || ![process.getgid(), ...process.getgroups()].includes(entry.gid))) {
    throw new Error('Saved ownership requires root privileges for project restoration.');
  }
  const check = async () => {
    signal?.throwIfAborted();
    const current = await lstat(await realDirectory(project));
    if (current.dev !== original.dev || current.ino !== original.ino) throw new Error('Original restore project directory changed.');
    const authority = await checkStopped({ signal });
    if (authority?.stopped !== true || authority.inhibited !== true) {
      throw new Error('Project restoration requires a stopped and inhibited managed runtime.');
    }
    signal?.throwIfAborted();
  };
  await check();
  const includedNames = async () => (await readdir(root)).sort().filter(name => !projectSnapshotExclusions.includes(name));
  const names = await includedNames();
  // Inspect caches too: deletion must not traverse hidden mounts or nested worktrees.
  const current = names.length ? await inventorySnapshot(root, names, { signal }) : [];
  const bytes = manifest.entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  if (!Number.isSafeInteger(bytes)) throw new Error('Restore capacity exceeds safe byte range.');
  const capacity = await statfs(root, { bigint: true });
  if (capacity.bavail * capacity.bsize < BigInt(bytes)) throw new Error('Insufficient space for project restoration.');
  await check();
  if (!same(await verifySnapshot(saved, { signal }), manifest) || !same(await includedNames(), names)) {
    throw new Error('Restore backup or project scope changed before mutation.');
  }
  await chmod(root, (original.mode & 0o777) | 0o700);
  for (const entry of current.filter(entry => entry.kind === 'directory').sort((a, b) => depth(a) - depth(b))) {
    signal?.throwIfAborted();
    const directory = await realDirectory(path.join(root, entry.path));
    await chmod(directory, entry.mode | 0o700);
  }
  const remove = async entry => {
    signal?.throwIfAborted();
    const file = path.join(root, entry.path);
    await realDirectory(path.dirname(file));
    const info = await lstat(file);
    const kind = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsupported';
    if (kind !== entry.kind || info.dev !== original.dev) throw new Error('Restore removal path changed type or filesystem.');
    if (kind === 'directory') await rmdir(file);
    else await unlink(file);
  };
  // Remove links before their targets so an interrupted deletion remains inspectable.
  for (const kind of ['link', 'file', 'directory']) {
    for (const entry of [...current].sort((a, b) => depth(b) - depth(a)).filter(entry => entry.kind === kind)) {
      if (!entry.path.includes('/')) await check();
      await remove(entry);
    }
  }
  await syncWorkerDirectory(root);
  await check();
  let group;
  const checkGroup = async entry => {
    signal?.throwIfAborted();
    const next = entry.path.split('/')[0];
    if (group !== next) {
      await check();
      group = next;
    }
  };
  const directories = manifest.entries.filter(entry => entry.kind === 'directory').sort((a, b) => depth(a) - depth(b));
  for (const entry of directories) {
    signal?.throwIfAborted();
    await realDirectory(path.dirname(path.join(root, entry.path)));
    await mkdir(path.join(root, entry.path), { mode: 0o700 });
  }
  for (const entry of manifest.entries.filter(entry => entry.kind === 'file')) {
    await checkGroup(entry);
    const source = path.join(saved, 'files', entry.path);
    const target = path.join(root, entry.path);
    await realDirectory(path.dirname(source));
    await realDirectory(path.dirname(target));
    await pipeline(
      createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }),
      createWriteStream(target, { flags: 'wx', mode: 0o600, flush: true }), { signal },
    );
    if (await fileDigest(target, { signal }) !== entry.sha256) throw new Error('Restored project checksum integrity failure.');
    await chown(target, entry.uid, entry.gid);
    await chmod(target, entry.mode);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const errors = [];
    try { await handle.sync(); }
    catch (error) { errors.push(error); }
    await closeWorkerFile(handle, errors);
  }
  for (const entry of [...directories].reverse()) {
    signal?.throwIfAborted();
    await syncWorkerDirectory(path.join(root, entry.path));
  }
  await syncWorkerDirectory(root);
  let pendingLinks = manifest.entries.filter(entry => entry.kind === 'link');
  while (pendingLinks.length) {
    const deferred = [];
    for (const entry of pendingLinks) {
      await checkGroup(entry);
      const target = path.join(root, entry.path);
      await realDirectory(path.dirname(target));
      let actual;
      try { actual = await realpath(path.resolve(path.dirname(target), entry.target)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        deferred.push(entry);
        continue;
      }
      const savedTarget = await realpath(path.join(saved, 'files', entry.path));
      if (actual !== path.join(root, path.relative(path.join(saved, 'files'), savedTarget))) {
        throw new Error('Restored link target differs from the retained snapshot.');
      }
      await symlink(entry.target, target);
      await lchown(target, entry.uid, entry.gid);
      await syncWorkerDirectory(path.dirname(target));
    }
    if (deferred.length === pendingLinks.length) throw new Error('Restored links have missing or circular targets.');
    pendingLinks = deferred;
  }
  for (const entry of [...directories].reverse()) {
    signal?.throwIfAborted();
    const directory = path.join(root, entry.path);
    await chown(directory, entry.uid, entry.gid);
    await chmod(directory, entry.mode);
    await syncWorkerDirectory(directory);
  }
  await chown(root, manifest.projectMetadata.uid, manifest.projectMetadata.gid);
  await chmod(root, manifest.projectMetadata.mode);
  await syncWorkerDirectory(root);
  await check();
  await assertSnapshotAbsent(root, manifest.absentPaths);
  const restoredNames = await includedNames();
  const observed = restoredNames.length ? await inventorySnapshot(root, restoredNames, { signal }) : [];
  if (!same(byPath(observed), byPath(manifest.entries.map(metadata)))
    || !same(await verifySnapshot(saved, { signal }), manifest)) {
    throw new Error('Restored project metadata or retained backup integrity failure.');
  }
  for (const entry of manifest.entries.filter(entry => entry.kind === 'file')) {
    if (await fileDigest(path.join(root, entry.path), { signal }) !== entry.sha256) {
      throw new Error('Restored project checksum changed before acceptance.');
    }
  }
  await check();
  return manifest;
}
