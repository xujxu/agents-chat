import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { canonicalWorkerDirectory } from './worker-files.mjs';

const identity = info => ({ dev: info.dev, ino: info.ino });
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest();

function branchRef(value) {
  if (!value.startsWith('refs/heads/') || /[\0-\x20\x7f~^:?*[\]\\]/.test(value)
    || value.includes('..') || value.includes('@{')
    || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Unsupported Git HEAD branch reference.');
  }
  return value;
}

async function readMetadata(file, maximum, optional = false) {
  let named;
  try { named = await lstat(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > maximum
    || await realpath(file) !== file) throw new Error('Unsupported Git metadata file type, links or size.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await lstat(file);
    if (!same(identity(named), identity(opened)) || !same(identity(after), identity(opened))
      || bytes.length !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Git metadata changed during capture.');
    }
    return { ...identity(opened), bytes: bytes.toString('base64'), mode: opened.mode & 0o777,
      uid: opened.uid, gid: opened.gid };
  } finally { await handle.close(); }
}

export async function inspectGitMetadata({ project, commit, signal }) {
  if (!commitPattern.test(commit ?? '')) throw new Error('Git metadata requires an exact source commit.');
  const { root } = await canonicalWorkerDirectory(project);
  const directory = path.join(root, '.git');
  const gitDirectory = await canonicalWorkerDirectory(directory);
  const observe = async () => {
    signal?.throwIfAborted();
    const current = await canonicalWorkerDirectory(directory);
    if (!same(identity(current.info), identity(gitDirectory.info))) throw new Error('Git metadata directory changed.');
    const names = await readdir(directory);
    if (names.some(name => name.endsWith('.lock') || name.startsWith('sharedindex.')
      || ['commondir', 'gitdir', 'worktrees', 'rebase-apply', 'rebase-merge', 'MERGE_HEAD', 'CHERRY_PICK_HEAD',
        'REVERT_HEAD', 'BISECT_LOG', 'shallow'].includes(name))) {
      throw new Error('Git metadata requires a standalone checkout without shared state, active writers or locks.');
    }
    const head = await readMetadata(path.join(directory, 'HEAD'), 4096);
    const index = await readMetadata(path.join(directory, 'index'), 16 * 1024 * 1024);
    const config = await readMetadata(path.join(directory, 'config'), 1024 * 1024);
    const headValue = text(Buffer.from(head.bytes, 'base64')).trimEnd();
    let ref = null;
    let resolved = headValue;
    let reference = null;
    let packed = null;
    if (headValue.startsWith('ref: ')) {
      ref = branchRef(headValue.slice(5));
      const parts = ref.split('/');
      for (let count = 1; count < parts.length; count++) {
        const parent = path.join(directory, ...parts.slice(0, count));
        try {
          const names = await readdir((await canonicalWorkerDirectory(parent)).root);
          if (names.some(name => name.endsWith('.lock'))) throw new Error('Git reference writer lock exists.');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          break;
        }
      }
      reference = await readMetadata(path.join(directory, ref), 4096, true);
      if (reference) resolved = text(Buffer.from(reference.bytes, 'base64')).trimEnd();
      else {
        packed = await readMetadata(path.join(directory, 'packed-refs'), 16 * 1024 * 1024);
        const matches = text(Buffer.from(packed.bytes, 'base64')).split('\n')
          .filter(line => line.endsWith(` ${ref}`));
        if (matches.length !== 1) throw new Error('Git HEAD reference is absent or ambiguous.');
        resolved = matches[0].slice(0, -(ref.length + 1));
      }
    }
    if (resolved !== commit) throw new Error('Git metadata does not match the selected source commit.');
    const indexBytes = Buffer.from(index.bytes, 'base64');
    const checksumBytes = commit.length / 2;
    if (indexBytes.length < 12 + checksumBytes || indexBytes.subarray(0, 4).toString('ascii') !== 'DIRC'
      || ![2, 3, 4].includes(indexBytes.readUInt32BE(4))
      || !digest(indexBytes.subarray(0, -checksumBytes), commit.length === 40 ? 'sha1' : 'sha256')
        .equals(indexBytes.subarray(-checksumBytes))) {
      throw new Error('Git index format or checksum is invalid.');
    }
    signal?.throwIfAborted();
    return { head, index, config, ref, reference, packed };
  };
  const original = await observe();
  const check = async () => {
    if (!same(await observe(), original)) throw new Error('Captured Git HEAD/index metadata changed.');
  };
  await check();
  return Object.freeze({
    record: Object.freeze({
      version: 1, commit, ref: original.ref, head: original.head.bytes, index: original.index.bytes,
    }),
    check,
  });
}
