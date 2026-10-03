import { constants, createReadStream } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { fileDigest, realDirectory } from './snapshot-files.mjs';
import { closeWorkerFile, syncWorkerDirectory } from './worker-files.mjs';

const names = ['info/commit-graph', 'info/commit-graphs/commit-graph-chain'];
const identity = info => ({ dev: info.dev, ino: info.ino });
const metadata = info => ({
  ...identity(info), mode: info.mode, uid: info.uid, gid: info.gid, nlink: info.nlink,
  size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs,
});
export const isGitGraphMetadata = name => names.includes(name);

async function observe(file) {
  let info;
  try { info = await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.mode & 0o7000n) {
    throw new Error('Git graph metadata has unsupported type, links or permissions.');
  }
  return metadata(info);
}

export async function inspectGitGraphPointers(root) {
  for (const name of names) await observe(path.join(root, name));
}

export async function restoreGitGraphMetadata({ root, backup, entries, check, signal, permissions }) {
  await check();
  const retained = [];
  for (const name of names) {
    const file = path.join(root, name);
    const entry = entries.find(entry => entry.path === name);
    const current = await observe(file);
    if (!entry && !current) continue;
    if (entry && entry.kind !== 'file') throw new Error('Saved Git graph metadata is not a file.');
    const parent = await realDirectory(path.dirname(file));
    retained.push({ name, file, parent, parentIdentity: identity(await lstat(parent, { bigint: true })), entry, current });
  }
  const checkParent = async item => {
    await check();
    if (!same(identity(await lstat(await realDirectory(item.parent), { bigint: true })), item.parentIdentity)) {
      throw new Error('Git graph metadata parent changed.');
    }
  };
  for (const item of retained) {
    await checkParent(item);
    if (!same(await observe(item.file), item.current)) throw new Error('Git graph metadata changed before restoration.');
  }
  for (const item of retained) {
    await checkParent(item);
    if (!same(await observe(item.file), item.current)) throw new Error('Git graph metadata changed before writing.');
    if (!item.entry) {
      if (permissions) await permissions.removeGraph({ entry: { path: item.name }, signal });
      else await unlink(item.file);
    } else {
      const entry = item.entry;
      const source = path.join(backup, 'git-objects/files', entry.path);
      if (await fileDigest(source, { signal }) !== entry.sha256) throw new Error('Saved Git graph metadata changed.');
      if (permissions) {
        if (item.current) await permissions.removeGraph({ entry, signal });
        await permissions.createGraph({ entry, signal });
      }
      const handle = await open(item.file, constants.O_RDWR | constants.O_NOFOLLOW
        | (permissions || item.current ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
      const errors = [];
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n
          || !permissions && item.current && !same(metadata(opened), item.current)) {
          throw new Error('Git graph metadata changed while opening.');
        }
        if (!permissions) {
          await handle.chmod(0o600);
          await handle.truncate(0);
        }
        // Only graph pointers are mutable; partial writes are retryable before activation.
        await handle.writeFile(createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, signal }), { signal });
        signal?.throwIfAborted();
        if (!permissions) {
          await handle.chown(entry.uid, entry.gid);
          await handle.chmod(entry.mode);
        }
        await handle.sync();
        if (!same(identity(await lstat(item.file, { bigint: true })), identity(opened))) {
          throw new Error('Git graph metadata was replaced during restoration.');
        }
      } catch (error) { errors.push(error); }
      await closeWorkerFile(handle, errors);
      if (permissions) {
        await checkParent(item);
        if (await fileDigest(item.file, { signal }) !== entry.sha256) throw new Error('Restored Git graph checksum differs.');
        await permissions.finishGraph({ entry, signal });
        await permissions.graphPolicy({ entry, signal });
      }
    }
    await syncWorkerDirectory(item.parent);
  }
  for (const item of retained) {
    await checkParent(item);
    const actual = await observe(item.file);
    const entry = item.entry;
    if (entry ? !actual || actual.size !== BigInt(entry.bytes)
      || !permissions && (actual.uid !== BigInt(entry.uid) || actual.gid !== BigInt(entry.gid)
        || (actual.mode & 0o777n) !== BigInt(entry.mode))
      || await fileDigest(item.file, { signal }) !== entry.sha256 : actual !== null) {
      throw new Error('Restored Git graph metadata differs from the saved layout.');
    }
  }
}
