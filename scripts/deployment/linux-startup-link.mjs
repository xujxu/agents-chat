import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';

const directoryFields = ['dev', 'ino', 'uid', 'gid', 'mode'];
const linkFields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'];
const directoryIdentity = info => Object.fromEntries(directoryFields.map(name => [name, info[name]]));
const linkIdentity = info => Object.fromEntries(linkFields.map(name => [name, String(info[name])]));
const root = '/etc/systemd/system';
const parent = path.join(root, 'multi-user.target.wants');

function paths(unit) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(unit)) {
    throw new Error('Unsupported persistent startup unit.');
  }
  return { startupLink: path.join(parent, unit), target: path.join(root, unit) };
}

export function captureLinuxStartupIdentity(value, unit) {
  const expected = paths(unit);
  const entry = captureWorkerFields(value, ['unit', 'startupLink', 'target', 'parent', 'link'], 'startup link');
  const directory = captureWorkerFields(entry.parent, directoryFields, 'startup directory');
  const link = captureWorkerFields(entry.link, linkFields, 'startup inode');
  if (entry.unit !== unit || entry.startupLink !== expected.startupLink || entry.target !== expected.target
    || Object.values(directory).some(number => !Number.isSafeInteger(number) || number < 0)
    || directory.uid !== 0 || (directory.mode & 0o170000) !== 0o040000 || directory.mode & 0o022
    || Object.values(link).some(number => typeof number !== 'string' || !/^[0-9]{1,30}$/.test(number))
    || link.uid !== '0' || link.nlink !== '1' || BigInt(link.mode) !== 0o120777n
    || BigInt(link.size) !== BigInt(Buffer.byteLength(expected.target))) {
    throw new Error('Invalid persistent startup link identity.');
  }
  return structuredClone({ ...entry, parent: directory, link });
}

export async function retainLinuxStartupLink({ unit, expected }) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Startup link inspection requires Linux root.');
  const { startupLink, target } = paths(unit);
  let handle;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle?.close();
  };
  try {
    const rootInfo = (await canonicalWorkerDirectory(root)).info;
    const parentInfo = (await canonicalWorkerDirectory(parent)).info;
    const named = await lstat(startupLink, { bigint: true });
    // Linux O_PATH + O_NOFOLLOW retains the symlink inode, not its target.
    handle = await open(startupLink, 0x200000 | constants.O_NOFOLLOW);
    const original = captureLinuxStartupIdentity({
      unit, startupLink, target, parent: directoryIdentity(parentInfo), link: linkIdentity(named),
    }, unit);
    if (expected !== undefined && !same(original, captureLinuxStartupIdentity(expected, unit))) {
      throw new Error('Original persistent startup link changed or was replaced.');
    }
    const check = async () => {
      if (closed) throw new Error('Startup link authority is closed.');
      for (const [directory, initial] of [[root, rootInfo], [parent, parentInfo]]) {
        const { info } = await canonicalWorkerDirectory(directory);
        if (info.uid !== 0 || info.mode & 0o022 || !same(directoryIdentity(info), directoryIdentity(initial))) {
          throw new Error('Persistent startup directory changed.');
        }
      }
      if (!same(linkIdentity(await lstat(startupLink, { bigint: true })), original.link)
        || !same(linkIdentity(await handle.stat({ bigint: true })), original.link)
        || await readlink(startupLink) !== target
        || !same(linkIdentity(await lstat(startupLink, { bigint: true })), original.link)) {
        throw new Error('Original persistent startup link changed or was replaced.');
      }
    };
    await check();
    return Object.freeze({ identity: structuredClone(original), check, close });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Startup link inspection cleanup failed.'); }
    throw error;
  }
}
