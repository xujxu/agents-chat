import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { readWorkerFile } from './worker-files.mjs';
import { realDirectory, writePrivateFile } from './snapshot-files.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = info => ({
  dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid, gid: info.gid,
  nlink: info.nlink, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs,
});
const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);
const validPath = file => typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file
  && !/[\0\r\n]/.test(file) && file.length <= 4096;

async function observe(file, optional) {
  await realDirectory(path.dirname(file));
  let info;
  try { info = await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' && optional) return null; throw error; }
  if (info.mode & 0o7000n) throw new Error('Unsupported external resource permission bits.');
  const bytes = await readWorkerFile(file, 1024 * 1024);
  if (!same(identity(info), identity(await lstat(file, { bigint: true })))) {
    throw new Error('External snapshot resource changed during inspection.');
  }
  return { bytes, identity: identity(info) };
}

export function validateExternalSnapshot(entries, project) {
  if (!Array.isArray(entries) || entries.length > 64 || entries.length && process.platform !== 'linux') {
    throw new Error('External snapshot resources require Linux metadata; Windows ACL capture is not yet supported.');
  }
  const paths = new Set();
  for (const entry of entries) {
    if (!entry || !validPath(entry.path) || inside(project, entry.path) || paths.has(entry.path)) {
      throw new Error('Invalid or duplicate external snapshot resource path.');
    }
    paths.add(entry.path);
    if (entry.kind === 'absent') {
      if (!same(entry, { path: entry.path, kind: 'absent' })) throw new Error('Unexpected absent resource metadata.');
    } else if (entry.kind !== 'file' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 1024 * 1024
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || !Number.isSafeInteger(entry.uid) || entry.uid < 0 || !Number.isSafeInteger(entry.gid) || entry.gid < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')
      || !same(Object.keys(entry).sort(), ['path', 'kind', 'bytes', 'mode', 'uid', 'gid', 'sha256'].sort())) {
      throw new Error('Invalid external resource metadata.');
    }
  }
  return entries;
}

export async function captureExternalSnapshot({ files, project, destination, signal }) {
  if (!Array.isArray(files) || files.length > 64 || files.length && process.platform !== 'linux') {
    throw new Error('External snapshot resources require Linux metadata; Windows ACL capture is not yet supported.');
  }
  const retained = [];
  for (const file of files) {
    signal?.throwIfAborted();
    if (!file || !validPath(file.path) || typeof file.optional !== 'boolean'
      || inside(project, file.path) || inside(destination, file.path)
      || retained.some(item => item.path === file.path)) {
      throw new Error('Invalid external snapshot source.');
    }
    const observed = await observe(file.path, file.optional);
    retained.push({ path: file.path, optional: file.optional, observed });
  }
  const entries = retained.map(({ path: file, observed }) => observed ? {
    path: file, kind: 'file', bytes: observed.bytes.length, sha256: digest(observed.bytes),
    mode: Number(observed.identity.mode & 0o777n), uid: Number(observed.identity.uid), gid: Number(observed.identity.gid),
  } : { path: file, kind: 'absent' });
  validateExternalSnapshot(entries, project);
  const check = async () => {
    for (const item of retained) {
      signal?.throwIfAborted();
      if (!same(await observe(item.path, item.optional), item.observed)) throw new Error('External snapshot source changed.');
    }
  };
  return {
    entries, bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), check,
    async copy() {
      if (!entries.length) return;
      await check();
      const root = path.join(destination, 'external');
      await mkdir(root, { mode: 0o700 });
      for (const [index, item] of retained.entries()) {
        signal?.throwIfAborted();
        if (item.observed) await writePrivateFile(path.join(root, String(index)), item.observed.bytes);
      }
      await check();
    },
  };
}

export async function verifyExternalSnapshot(root, entries, signal) {
  if (!entries.length) return;
  const directory = await realDirectory(path.join(root, 'external'));
  const expected = entries.flatMap((entry, index) => entry.kind === 'file' ? [String(index)] : []).sort();
  if (!same((await readdir(directory)).sort(), expected)) throw new Error('External snapshot inventory differs.');
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted();
    if (entry.kind === 'absent') continue;
    const bytes = await readWorkerFile(path.join(directory, String(index)), 1024 * 1024, { privateMode: true });
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error('External snapshot checksum integrity failure.');
  }
}
