import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export const linuxServiceFileIdentity = info => ({
  dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
  uid: info.uid, gid: info.gid, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
});
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function sourceDirectory(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022) {
      throw new Error('Service source directory is writable, linked or not root-owned.');
    }
    if (current === '/') break;
  }
}

export async function inspectLinuxServiceSource(file) {
  await sourceDirectory(path.dirname(file));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022
    || info.nlink !== 1 || info.size > 256 * 1024) {
    throw new Error('Service source file has unsupported type, permissions or size.');
  }
  return linuxServiceFileIdentity(info);
}

export async function captureLinuxServiceSources(files) {
  if (!Array.isArray(files) || !files.length || files.length > 33
    || new Set(files).size !== files.length || files.some(file => typeof file !== 'string'
      || !path.isAbsolute(file) || path.resolve(file) !== file || /[\0\r\n]/.test(file))) {
    throw new Error('Noncanonical or duplicate service source paths.');
  }
  const names = [...files];
  const sources = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled(sources.map(source => source.handle.close()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Service source inspection handles could not all be closed.');
  };
  try {
    for (const file of names) {
      const original = await inspectLinuxServiceSource(file);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const source = { file, handle, original };
      sources.push(source);
      const bytes = Buffer.alloc(original.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length || !same(linuxServiceFileIdentity(await handle.stat()), original)
        || !same(await inspectLinuxServiceSource(file), original)) throw new Error('Service source file changed while reading.');
      source.sha256 = hash(bytes);
    }
    const check = async () => {
      if (closed) throw new Error('Service source inspection is closed.');
      for (const source of sources) {
        const bytes = Buffer.alloc(source.original.size);
        const { bytesRead } = await source.handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length || hash(bytes) !== source.sha256
          || !same(linuxServiceFileIdentity(await source.handle.stat()), source.original)
          || !same(await inspectLinuxServiceSource(source.file), source.original)) {
          throw new Error('Retained service source file was changed or replaced.');
        }
      }
    };
    await check();
    const identity = Object.freeze(sources.map(source => Object.freeze({
      path: source.file, ...source.original, sha256: source.sha256,
    })));
    return Object.freeze({ identity, check, close });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Service source capture and handle cleanup failed.'); }
    throw error;
  }
}
