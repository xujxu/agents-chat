import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { validateWindowsGitSnapshotSecurity } from './windows-git-snapshot-security.mjs';

const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
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

function validateIndex(indexBytes, commit) {
  const checksumBytes = commit.length / 2;
  if (indexBytes.length < 12 + checksumBytes || indexBytes.subarray(0, 4).toString('ascii') !== 'DIRC'
    || ![2, 3, 4].includes(indexBytes.readUInt32BE(4))
    || !digest(indexBytes.subarray(0, -checksumBytes), commit.length === 40 ? 'sha1' : 'sha256')
      .equals(indexBytes.subarray(-checksumBytes))) {
    throw new Error('Git index format or checksum is invalid.');
  }
}

export function validateGitMetadata(value, commit) {
  const windows = Object.getOwnPropertyDescriptor(value ?? {}, 'version')?.value === 2;
  const record = captureWorkerFields(value, ['version', 'commit', 'ref', 'head', 'index',
    ...(windows ? ['windowsSecurity', 'absentPaths'] : [])], 'Git metadata');
  if (![1, 2].includes(record.version) || !commitPattern.test(record.commit ?? '') || record.commit !== commit) {
    throw new Error('Git metadata does not match snapshot source commit.');
  }
  const decode = (value, maximum) => {
    if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) {
      throw new Error('Git metadata bytes exceed the supported limit.');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > maximum || bytes.toString('base64') !== value) throw new Error('Invalid Git metadata byte encoding.');
    return bytes;
  };
  const head = text(decode(record.head, 4096)).trimEnd();
  if (record.ref !== null) branchRef(record.ref);
  if (head !== (record.ref === null ? record.commit : `ref: ${record.ref}`)) {
    throw new Error('Git metadata HEAD and branch reference differ.');
  }
  validateIndex(decode(record.index, 16 * 1024 * 1024), commit);
  if (windows) return Object.freeze({ ...record, ...validateWindowsGitSnapshotSecurity({
    windowsSecurity: record.windowsSecurity, absentPaths: record.absentPaths,
  }, record.ref) });
  return Object.freeze(record);
}

export async function readGitMetadataFile(file, maximum, optional = false) {
  let named;
  try { named = await lstat(file, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size > BigInt(maximum)
    || await realpath(file) !== file) throw new Error('Unsupported Git metadata file type, links or size.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await lstat(file, { bigint: true });
    if (!same(identity(named), identity(opened)) || !same(identity(after), identity(opened))
      || BigInt(bytes.length) !== opened.size || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error('Git metadata changed during capture.');
    }
    return { ...identity(opened), bytes: bytes.toString('base64'), mode: Number(opened.mode & 0o777n),
      uid: Number(opened.uid), gid: Number(opened.gid) };
  } finally { await handle.close(); }
}

export async function inspectGitDirectory(directory, options) {
  const { root } = await canonicalWorkerDirectory(directory, options);
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error('Git metadata directory changed.');
  }
  return { root, info };
}

export async function inspectGitMetadata({ project, commit, signal }) {
  if (commit !== undefined && !commitPattern.test(commit)) throw new Error('Git metadata requires an exact source commit.');
  const { root } = await canonicalWorkerDirectory(project);
  const directory = path.join(root, '.git');
  const gitDirectory = await inspectGitDirectory(directory);
  const observe = async (checkSignal = signal) => {
    checkSignal?.throwIfAborted();
    const current = await inspectGitDirectory(directory);
    if (!same(identity(current.info), identity(gitDirectory.info))) throw new Error('Git metadata directory changed.');
    const names = await readdir(directory);
    if (names.some(name => name.endsWith('.lock') || name.startsWith('sharedindex.')
      || ['commondir', 'gitdir', 'worktrees', 'rebase-apply', 'rebase-merge', 'MERGE_HEAD', 'CHERRY_PICK_HEAD',
        'REVERT_HEAD', 'BISECT_LOG', 'shallow'].includes(name))) {
      throw new Error('Git metadata requires a standalone checkout without shared state, active writers or locks.');
    }
    const head = await readGitMetadataFile(path.join(directory, 'HEAD'), 4096);
    const index = await readGitMetadataFile(path.join(directory, 'index'), 16 * 1024 * 1024);
    const config = await readGitMetadataFile(path.join(directory, 'config'), 1024 * 1024);
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
      reference = await readGitMetadataFile(path.join(directory, ref), 4096, true);
      if (reference) resolved = text(Buffer.from(reference.bytes, 'base64')).trimEnd();
      else {
        packed = await readGitMetadataFile(path.join(directory, 'packed-refs'), 16 * 1024 * 1024);
        const matches = text(Buffer.from(packed.bytes, 'base64')).split('\n')
          .filter(line => line.endsWith(` ${ref}`));
        if (matches.length !== 1) throw new Error('Git HEAD reference is absent or ambiguous.');
        resolved = matches[0].slice(0, -(ref.length + 1));
      }
    }
    if (!commitPattern.test(resolved) || commit !== undefined && resolved !== commit) {
      throw new Error('Git metadata does not match the selected source commit.');
    }
    const indexBytes = Buffer.from(index.bytes, 'base64');
    validateIndex(indexBytes, resolved);
    checkSignal?.throwIfAborted();
    return { head, index, config, ref, reference, packed, commit: resolved };
  };
  const original = await observe();
  const check = async ({ signal: checkSignal = signal } = {}) => {
    if (!same(await observe(checkSignal), original)) throw new Error('Captured Git HEAD/index metadata changed.');
  };
  await check();
  return Object.freeze({
    record: validateGitMetadata({
      version: 1, commit: original.commit, ref: original.ref, head: original.head.bytes, index: original.index.bytes,
    }, original.commit),
    check,
  });
}
