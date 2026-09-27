import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export function requirePrivateMode(info) {
  if (process.platform === 'linux' && (info.uid !== process.getuid() || (info.mode & 0o077))) {
    throw new Error('Worker files require private current-user ownership.');
  }
}

export async function canonicalWorkerDirectory(root, { privateMode = false } = {}) {
  const resolved = path.resolve(root);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new Error('Worker files require a canonical directory without links.');
  }
  if (privateMode) requirePrivateMode(info);
  return { root: resolved, info };
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export async function externalWorkerDirectory(root, project) {
  const location = await canonicalWorkerDirectory(root, { privateMode: true });
  if (!path.isAbsolute(project) || contains(project, location.root) || contains(location.root, project)) {
    throw new Error('Worker files require a canonical external control directory.');
  }
  return location;
}

export async function closeWorkerFile(handle, errors = []) {
  try { await handle.close(); }
  catch (error) { errors.push(error); }
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors);
}

export async function syncWorkerDirectory(root) {
  if (process.platform !== 'linux') return;
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  const errors = [];
  try { await handle.sync(); }
  catch (error) { errors.push(error); }
  await closeWorkerFile(handle, errors);
}

export async function writeWorkerFile(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  const errors = [];
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) { errors.push(error); }
  await closeWorkerFile(handle, errors);
}

export async function readWorkerFile(file, maximumBytes, { privateMode = false } = {}) {
  const named = await lstat(file);
  const check = info => {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || info.size > maximumBytes) throw new Error('Invalid worker file type, links or size.');
    if (privateMode) requirePrivateMode(info);
  };
  check(named);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const errors = [];
  let bytes;
  try {
    const opened = await handle.stat();
    check(opened);
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) {
      throw new Error('Worker file changed before reading.');
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Worker file changed during reading.');
      offset += bytesRead;
    }
    const after = await lstat(file);
    check(after);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Worker file changed during reading.');
    }
  } catch (error) { errors.push(error); }
  await closeWorkerFile(handle, errors);
  return bytes;
}
