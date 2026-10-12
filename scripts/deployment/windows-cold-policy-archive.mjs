import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { readWorkerFile } from './worker-files.mjs';
import { windowsColdDirectoryIdentity } from './windows-cold-restore-lease.mjs';

export async function captureWindowsColdArchiveFiles({ control, names, identity, signal }) {
  signal?.throwIfAborted();
  const directory = path.join(control, 'recovery-lock');
  if (!Array.isArray(names) || names.length > 262 || new Set(names).size !== names.length
    || names.some(name => typeof name !== 'string'
      || !/^(?:owner|files-restored|activation-(?:intent|start-requested|running|stopped)|policy-[0-9]{6})\.json$/.test(name))) {
    throw new Error('Cold journal archival requires its bounded original inventory.');
  }
  if (!same(await windowsColdDirectoryIdentity(directory), identity)
    || !same((await readdir(directory)).sort(), [...names].sort())) {
    throw new Error('Original cold journal directory or inventory changed.');
  }
  const files = [];
  let total = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    const bytes = await readWorkerFile(path.join(directory, name), 4194304, { privateMode: true });
    total += bytes.length;
    if (total > 29360128) throw new Error('Cold journal archival exceeds its evidence byte budget.');
    files.push({ name, bytes });
  }
  return files;
}

export async function verifyWindowsColdArchiveFiles({ control, archive, files, identity, signal }) {
  signal?.throwIfAborted();
  if (!same(await windowsColdDirectoryIdentity(archive), identity)
    || !same((await readdir(archive)).sort(), files.map(file => file.name).sort())) {
    throw new Error('Archived cold journal identity or inventory changed.');
  }
  for (const { name, bytes } of files) {
    signal?.throwIfAborted();
    if (!(await readWorkerFile(path.join(archive, name), 4194304, { privateMode: true })).equals(bytes)) {
      throw new Error('Archived cold journal bytes changed.');
    }
  }
  try { await lstat(path.join(control, 'recovery-lock')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Archived cold journal still occupies its active name.');
}
