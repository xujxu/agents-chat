import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { loadState } from './state.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';
import { journalUncertain } from './evidence-journal.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Only live activation authority may authorize this one-shot deletion inventory.
export async function retireLinuxService({ control, lock, held, runtime, verify, verifyEvidence, closeAuthority }) {
  const handles = [];
  const errors = [];
  try {
    const state = await verify();
    const root = await canonicalWorkerDirectory(control, { privateMode: true });
    const lockDirectory = await canonicalWorkerDirectory(path.join(control, 'lock'), { privateMode: true });
    const parent = path.dirname(held);
    const parentInfo = await lstat(parent);
    const markerPath = path.join(control, 'service-retirement.json');
    const capture = async file => {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(handle);
      const opened = await handle.stat();
      const bytes = await readWorkerFile(file, 512 * 1024, { privateMode: true });
      if (!same(identity(opened), identity(await lstat(file))) || opened.nlink !== 1) {
        throw new Error('Service retirement file changed during capture.');
      }
      return { file, ...identity(opened), bytes: bytes.length, sha256: digest(bytes), handle };
    };
    const checkFile = async entry => {
      const named = await lstat(entry.file);
      const opened = await entry.handle.stat();
      if (!same(identity(named), { dev: entry.dev, ino: entry.ino })
        || !same(identity(opened), identity(named)) || opened.nlink !== 1) {
        throw new Error('Original service retirement file was replaced.');
      }
      const bytes = await readWorkerFile(entry.file, 512 * 1024, { privateMode: true });
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
        throw new Error('Original service retirement content changed.');
      }
    };
    const stateFile = await capture(path.join(control, 'state.json'));
    const lockFile = await capture(path.join(control, 'lock', 'owner.json'));
    const entries = [];
    for (const file of [held, path.join(control, 'service-activation.ndjson'), path.join(control, 'service-stop.ndjson')]) {
      entries.push(await capture(file));
    }
    await verifyEvidence();
    const remaining = new Map(entries.map(entry => [entry.file, entry]));
    let marker;
    const check = async () => {
      if (!same(await verify(), state) || !same(await loadState(control), state)) {
        throw new Error('Application acceptance changed during service retirement.');
      }
      const current = await canonicalWorkerDirectory(control, { privateMode: true });
      const currentLock = await canonicalWorkerDirectory(path.join(control, 'lock'), { privateMode: true });
      const currentParent = await lstat(parent);
      if (!same(identity(current.info), identity(root.info))
        || !same(identity(currentLock.info), identity(lockDirectory.info))
        || !same(identity(currentParent), identity(parentInfo)) || currentParent.isSymbolicLink()
        || currentParent.uid !== 0 || currentParent.mode & 0o022) {
        throw new Error('Original service retirement directories changed.');
      }
      await checkFile(stateFile);
      await checkFile(lockFile);
      for (const entry of remaining.values()) await checkFile(entry);
      for (const entry of entries.filter(entry => !remaining.has(entry.file))) {
        try { await lstat(entry.file); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new Error('Removed service retirement file reappeared.');
      }
      if (marker) await checkFile(marker);
      const expected = [...remaining.keys()].filter(file => path.dirname(file) === control).map(file => path.basename(file));
      if (marker) expected.push('service-retirement.json');
      const actual = (await readdir(control)).filter(name => name.startsWith('service-')).sort();
      if (!same(actual, expected.sort())) throw new Error('Unexpected service retirement evidence inventory.');
    };
    await check();
    const serialize = ({ handle, ...entry }) => entry;
    await writeWorkerFile(markerPath, Buffer.from(`${JSON.stringify({
      version: 1, lock, runtime, state, stateFile: serialize(stateFile), lockFile: serialize(lockFile),
      controlIdentity: identity(root.info), lockIdentity: identity(lockDirectory.info),
      heldParentIdentity: identity(parentInfo), files: entries.map(serialize),
    })}\n`));
    await syncWorkerDirectory(control);
    marker = await capture(markerPath);
    for (const entry of entries) {
      await check();
      await unlink(entry.file);
      remaining.delete(entry.file);
      await syncWorkerDirectory(path.dirname(entry.file));
    }
    await check();
    await closeAuthority();
    while (handles.length) {
      await handles[0].close();
      handles.shift();
    }
    await unlink(markerPath);
    await syncWorkerDirectory(control);
  } catch (error) { errors.push(error); }
  const closed = await Promise.allSettled(handles.map(handle => handle.close()));
  errors.push(...closed.filter(result => result.status === 'rejected').map(result => result.reason));
  if (errors.length) throw journalUncertain(errors.length === 1 ? errors[0] : new AggregateError(errors));
}
