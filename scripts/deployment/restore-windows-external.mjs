import { createHash } from 'node:crypto';
import { lstat, open, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { verifySnapshot } from './snapshot.mjs';
import { realDirectory } from './snapshot-files.mjs';
import { canonicalWorkerDirectory, closeWorkerFile, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';
import { prepareWindowsSourceRestoreSecurity, windowsRestoredSecurityMatches } from './windows-restore-security.mjs';
import { inspectWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';
import { inspectWindowsRuntimeRelocation } from './windows-runtime-relocation.mjs';

const identity = info => ({ dev: info.dev, ino: info.ino });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, file) => {
  const relative = path.relative(parent, file);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function currentFile(file) {
  let info;
  try { info = await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new Error('External restore target has unsupported file type or links.');
  }
  return {
    ...identity(info), bytes: info.size, mode: info.mode, uid: info.uid, gid: info.gid,
    mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs,
  };
}

async function matchesSavedFiles(scope, backup, signal, pwsh) {
  for (const item of scope.items) {
    signal?.throwIfAborted();
    const current = await currentFile(item.entry.path);
    if (!same(current, item.current)) throw new Error('External restore target changed before comparison.');
    if (item.entry.kind === 'absent') {
      if (current) return false;
    } else if (!current || !item.bytes.equals(await readWorkerFile(item.entry.path, 1024 * 1024))) return false;
  }
  const observed = await inspectWindowsSnapshotSecurity({
    project: scope.parent, destinationParent: backup, entries: scope.entries, signal, pwsh,
  });
  const errors = [];
  let matches;
  try { matches = windowsRestoredSecurityMatches(scope.metadata, observed.metadata, scope.entries); }
  catch (error) { errors.push(error); }
  try { await observed.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'External restore comparison or native cleanup failed.');
  return matches;
}

export async function restoreWindowsExternalSnapshot(options) {
  const scopes = [];
  const errors = [];
  let result;
  try { result = await restoreExternal(options, scopes); }
  catch (error) { errors.push(error); }
  for (const scope of scopes.reverse()) {
    try { await scope.security.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'External restoration and native cleanup failed.');
  return result;
}

async function restoreExternal({
  project, backup, authorizedPaths, acceptDataLoss, checkStopped, signal, expectedSnapshot, runtimeBundle, pwsh,
}, scopes) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32') throw new Error('Native external restoration requires Windows.');
  if (acceptDataLoss !== true || typeof checkStopped !== 'function') {
    throw new Error('External restore requires data-loss acknowledgement and stopped runtime authority.');
  }
  const root = await realDirectory(project);
  const original = identity(await lstat(root, { bigint: true }));
  const saved = (await canonicalWorkerDirectory(backup, { privateMode: true })).root;
  if (inside(root, saved) || inside(saved, root)) throw new Error('External restore backup must be outside the project.');
  const manifest = await verifySnapshot(saved, { signal });
  if (expectedSnapshot !== undefined && !same(manifest, expectedSnapshot)) throw new Error('Admitted external restore backup changed.');
  if (manifest.project !== root || manifest.version !== 3 || manifest.runtime.platform !== 'win32') {
    throw new Error('External restoration requires a matching Windows snapshot with native ACL metadata.');
  }
  const originalEntries = manifest.externalFiles ?? [];
  if (!Array.isArray(authorizedPaths) || authorizedPaths.some(file => typeof file !== 'string')
    || !same([...authorizedPaths].sort(), originalEntries.map(entry => entry.path).sort())
    || originalEntries.some(entry => inside(saved, entry.path))) {
    throw new Error('Every external restoration path requires exact native authorization.');
  }
  const relocation = runtimeBundle === undefined ? null : await inspectWindowsRuntimeRelocation({
    project: root, backup: saved, snapshot: manifest, runtimeBundle, signal,
  });
  const entries = relocation?.entries ?? originalEntries;
  const check = async () => {
    signal?.throwIfAborted();
    if (!same(identity(await lstat(await realDirectory(project), { bigint: true })), original)) {
      throw new Error('Original external restore project directory changed.');
    }
    const state = await checkStopped({ signal });
    if (state?.stopped !== true || state.inhibited !== true) throw new Error('External restoration requires a stopped and inhibited runtime.');
    await relocation?.check();
    signal?.throwIfAborted();
    for (const scope of scopes) await scope.security.checkRoot({ signal });
  };
  await check();
  const retained = [];
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted();
    await realDirectory(path.dirname(entry.path));
    const current = await currentFile(entry.path);
    const bytes = entry.kind === 'file'
      ? await readWorkerFile(path.join(saved, 'external', String(index)), 1024 * 1024, { privateMode: true }) : null;
    if (bytes && (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)) {
      throw new Error('External restore payload integrity failure.');
    }
    retained.push({ entry, current, bytes });
  }
  const required = BigInt(entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0));
  for (const parent of relocation?.parents ?? manifest.windowsExternalSecurity?.parents ?? []) {
    const items = retained.filter(item => path.dirname(item.entry.path) === parent.path);
    const capacity = await statfs(parent.path, { bigint: true });
    if (capacity.bavail * capacity.bsize < required) throw new Error('Insufficient space for external restoration.');
    const relative = item => ({ ...item.entry, path: path.basename(item.entry.path) });
    const savedEntries = items.filter(item => item.entry.kind === 'file').map(relative);
    const security = await prepareWindowsSourceRestoreSecurity({
      project: parent.path, backup: saved, metadata: parent.metadata,
      entries: savedEntries,
      current: items.filter(item => item.current).map(item => ({ path: path.basename(item.entry.path), kind: 'file' })),
      signal, pwsh,
    });
    scopes.push({ parent: parent.path, metadata: parent.metadata, entries: savedEntries, items, security });
  }
  await check();
  for (const item of retained) {
    if (!same(await currentFile(item.entry.path), item.current)) throw new Error('External restore target changed before mutation.');
  }
  if (!same(await verifySnapshot(saved, { signal }), manifest)) throw new Error('Admitted external restore backup changed before mutation.');
  for (const scope of scopes) {
    await check();
    if (await matchesSavedFiles(scope, saved, signal, pwsh)) continue;
    await check();
    await scope.security.prepareRemoval({ signal });
    for (const item of scope.items) {
      await check();
      if (!same(await currentFile(item.entry.path), item.current)) throw new Error('External restore target changed before removal.');
      if (item.current) await scope.security.remove({ entry: { path: path.basename(item.entry.path), kind: 'file' }, signal });
    }
    for (const item of scope.items.filter(item => item.entry.kind === 'file')) {
      await check();
      const entry = { ...item.entry, path: path.basename(item.entry.path) };
      await scope.security.createFile({ entry, signal });
      const handle = await open(item.entry.path, 'r+');
      const errors = [];
      try {
        await handle.writeFile(item.bytes);
        signal?.throwIfAborted();
        await handle.sync();
      } catch (error) { errors.push(error); }
      await closeWorkerFile(handle, errors);
      await scope.security.finishFile({ entry, signal });
    }
    await check();
    await scope.security.restore({ signal });
    await syncWorkerDirectory(scope.parent);
  }
  await check();
  for (const item of retained) {
    signal?.throwIfAborted();
    const current = await currentFile(item.entry.path);
    if (item.entry.kind === 'absent') {
      if (current !== null) throw new Error('External restored absence changed.');
    } else if (!current || !item.bytes.equals(await readWorkerFile(item.entry.path, 1024 * 1024))) {
      throw new Error('External restored content integrity failure.');
    }
  }
  if (!same(await verifySnapshot(saved, { signal }), manifest)) throw new Error('Retained backup changed during external restoration.');
  await check();
  for (const scope of scopes) await scope.security.verify({ signal });
  await relocation?.verify();
  return manifest;
}
