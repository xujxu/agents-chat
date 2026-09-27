import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat, open, readFile, readdir, readlink, realpath,
} from 'node:fs/promises';
import path from 'node:path';

export function relativeSnapshotPath(value) {
  if (typeof value !== 'string' || !value || /[\\:\0\r\n]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..'
      || /[. ]$/.test(part) || /[<>|"*?]/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe snapshot relative path.');
  }
  return value;
}

export async function realDirectory(directory) {
  const info = await lstat(directory);
  const resolved = await realpath(directory);
  const expected = path.resolve(directory);
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!info.isDirectory() || info.isSymbolicLink() || compare(resolved) !== compare(expected)) {
    throw new Error(`Snapshot path must be a real directory without redirected ancestors: ${expected} (resolved: ${resolved}).`);
  }
  return resolved;
}

export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function writePrivateFile(file, data) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally { await handle.close(); }
}

export async function readSnapshotJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) {
    throw new Error('Invalid snapshot manifest type or size.');
  }
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (cause) { throw new Error('Invalid snapshot manifest JSON.', { cause }); }
}

export async function inventorySnapshot(project, files) {
  const root = await realDirectory(project);
  if (!Array.isArray(files) || !files.length) throw new Error('Snapshot requires explicit paths.');
  const entries = [];
  const seen = new Set();
  const rootDevice = (await lstat(root)).dev;
  async function visit(relative) {
    relativeSnapshotPath(relative);
    const identity = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (seen.has(identity)) throw new Error(`Duplicate snapshot path: ${relative}`);
    seen.add(identity);
    const file = path.join(root, relative);
    const info = await lstat(file);
    if (info.dev !== rootDevice) throw new Error(`Snapshot path crosses filesystem: ${relative}`);
    const metadata = { path: relative, mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
    if (info.isSymbolicLink()) {
      const target = await readlink(file);
      if (path.isAbsolute(target) || /[\0\r\n]/.test(target)) {
        throw new Error(`External snapshot link: ${relative}`);
      }
      const actual = await realpath(file);
      if (!actual.startsWith(root + path.sep)) throw new Error(`External snapshot link: ${relative}`);
      entries.push({ ...metadata, kind: 'link', target });
    } else if (info.isDirectory()) {
      await realDirectory(file);
      entries.push({ ...metadata, kind: 'directory' });
      for (const child of (await readdir(file)).sort()) await visit(`${relative}/${child}`);
    } else if (info.isFile()) {
      entries.push({ ...metadata, kind: 'file', bytes: info.size });
    } else {
      throw new Error(`Unsupported snapshot file type: ${relative}`);
    }
  }
  for (const name of files) {
    relativeSnapshotPath(name);
    // Resolve every parent before lstat so a selected file cannot bypass link checks.
    await realDirectory(path.dirname(path.join(root, name)));
    await visit(name);
  }
  for (const entry of entries.filter(item => item.kind === 'link')) {
    const target = path.relative(root, await realpath(path.join(root, entry.path))).split(path.sep).join('/');
    const identity = process.platform === 'win32' ? target.toLowerCase() : target;
    if (!seen.has(identity)) throw new Error(`Snapshot link target not captured: ${entry.path}`);
  }
  return entries;
}
