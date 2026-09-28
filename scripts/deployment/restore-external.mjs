import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { verifySnapshot } from './snapshot.mjs';
import { realDirectory } from './snapshot-files.mjs';
import { canonicalWorkerDirectory, closeWorkerFile, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';

const identity = info => ({ dev: info.dev, ino: info.ino });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

async function currentFile(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o7000) {
    throw new Error('External restore target has unsupported file type, links or permissions.');
  }
  return info;
}

export async function restoreExternalSnapshot({
  project, backup, authorizedPaths, acceptDataLoss, checkStopped, signal,
}) {
  if (process.platform !== 'linux') throw new Error('External restoration requires Linux metadata; Windows requires native ACL restoration.');
  signal?.throwIfAborted();
  if (acceptDataLoss !== true || typeof checkStopped !== 'function') {
    throw new Error('External restore requires data-loss acknowledgement and stopped runtime authority.');
  }
  const root = await realDirectory(project);
  const saved = (await canonicalWorkerDirectory(backup, { privateMode: true })).root;
  if (inside(root, saved) || inside(saved, root)) throw new Error('External restore backup must be outside the project.');
  const manifest = await verifySnapshot(saved, { signal });
  if (manifest.project !== root || manifest.runtime.platform !== 'linux') throw new Error('External restore project owner or platform differs.');
  const entries = manifest.externalFiles ?? [];
  if (!Array.isArray(authorizedPaths) || authorizedPaths.some(file => typeof file !== 'string')
    || !same([...authorizedPaths].sort(), entries.map(entry => entry.path).sort())
    || entries.some(entry => inside(saved, entry.path))) {
    throw new Error('Every external restoration path requires exact native authorization.');
  }
  if (process.getuid() !== 0 && entries.some(entry => entry.kind === 'file'
    && (entry.uid !== process.getuid() || ![process.getgid(), ...process.getgroups()].includes(entry.gid)))) {
    throw new Error('Saved external ownership requires root privileges.');
  }
  const check = async () => {
    signal?.throwIfAborted();
    const state = await checkStopped({ signal });
    if (state?.stopped !== true || state.inhibited !== true) throw new Error('External restoration requires a stopped and inhibited runtime.');
    signal?.throwIfAborted();
  };
  await check();
  const retained = [];
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted();
    const parent = await realDirectory(path.dirname(entry.path));
    const info = await lstat(parent);
    if (![0, process.getuid()].includes(info.uid) || info.mode & 0o022) {
      throw new Error('External restoration parent has unsafe ownership or permissions.');
    }
    const current = await currentFile(entry.path);
    const bytes = entry.kind === 'file'
      ? await readWorkerFile(path.join(saved, 'external', String(index)), 1024 * 1024, { privateMode: true }) : null;
    if (bytes && (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)) {
      throw new Error('External restore payload integrity failure.');
    }
    const capacity = await statfs(parent, { bigint: true });
    if (capacity.bavail * capacity.bsize < BigInt(entry.bytes ?? 0)) throw new Error('Insufficient space for external restoration.');
    retained.push({ entry, parent, parentIdentity: identity(info), current, bytes });
  }
  const checkParent = async item => {
    const info = await lstat(await realDirectory(item.parent));
    if (!same(identity(info), item.parentIdentity) || ![0, process.getuid()].includes(info.uid) || info.mode & 0o022) {
      throw new Error('External restore parent changed.');
    }
  };
  await check();
  for (const item of retained) {
    await checkParent(item);
    if (!same(await currentFile(item.entry.path), item.current)) throw new Error('External restore target changed before mutation.');
  }
  for (const item of retained) {
    await check();
    await checkParent(item);
    const { entry, current, bytes } = item;
    if (!same(await currentFile(entry.path), current)) throw new Error('External restore target changed before writing.');
    if (entry.kind === 'file' && current && current.uid === entry.uid && current.gid === entry.gid
      && (current.mode & 0o777) === entry.mode
      && bytes.equals(await readWorkerFile(entry.path, 1024 * 1024))) continue;
    if (entry.kind === 'absent') {
      if (current) await unlink(entry.path);
    } else {
      const flags = constants.O_RDWR | constants.O_NOFOLLOW
        | (current ? 0 : constants.O_CREAT | constants.O_EXCL);
      const handle = await open(entry.path, flags, 0o600);
      const errors = [];
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1
          || current && !same(identity(opened), identity(current))) throw new Error('External restore file changed before opening.');
        // A partial write is retryable from the unchanged authoritative snapshot.
        await handle.chmod(0o600);
        await handle.truncate(0);
        await handle.writeFile(bytes);
        signal?.throwIfAborted();
        await handle.chown(entry.uid, entry.gid);
        await handle.chmod(entry.mode);
        await handle.sync();
      } catch (error) { errors.push(error); }
      await closeWorkerFile(handle, errors);
    }
    await syncWorkerDirectory(item.parent);
  }
  await check();
  for (const item of retained) {
    signal?.throwIfAborted();
    await checkParent(item);
    const info = await currentFile(item.entry.path);
    const entry = item.entry;
    if (entry.kind === 'absent') {
      if (info !== null) throw new Error('External restored absence changed.');
    } else if (!info || info.uid !== entry.uid || info.gid !== entry.gid || (info.mode & 0o777) !== entry.mode
      || !item.bytes.equals(await readWorkerFile(entry.path, 1024 * 1024))) {
      throw new Error('External restored content or metadata integrity failure.');
    }
  }
  if (!same(await verifySnapshot(saved, { signal }), manifest)) throw new Error('Retained backup changed during external restoration.');
  await check();
  return manifest;
}
