import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { captureLockOwner, loadState, requireNoServiceMaintenance } from './state.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { externalWorkerDirectory, canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';
import { workerEngineFiles } from './saved-worker-engine.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const markerName = 'worker-retirement.json';
const guardName = 'recovery-lock';
const maximum = 1024 * 1024;
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));

function directoryIdentity(value) {
  const fields = captureWorkerFields(value, ['dev', 'ino'], 'retirement directory');
  if (!Object.values(fields).every(field => typeof field === 'string' && /^[0-9]+$/.test(field))) {
    throw new Error('Invalid retirement directory identity.');
  }
  return fields;
}

function fileEntry(value, expected) {
  const entry = captureWorkerFields(value, ['path', 'dev', 'ino', 'bytes', 'sha256'], 'retirement file');
  directoryIdentity({ dev: entry.dev, ino: entry.ino });
  if (entry.path !== expected || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maximum
    || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error('Invalid retirement file descriptor.');
  }
  return entry;
}

function intent(bytes, project, operationId) {
  const value = captureWorkerFields(parse(bytes), [
    'version', 'lock', 'manifestSha256', 'state', 'files', 'lockFile',
    'controlIdentity', 'lockIdentity', 'engineIdentity',
  ], 'retirement intent');
  const lock = captureLockOwner(value.lock);
  if (value.version !== 2 || lock.project !== project || lock.operationId !== operationId
    || !/^[a-f0-9]{64}$/.test(value.manifestSha256)
    || !Array.isArray(value.files) || value.files.length > workerEngineFiles.length + 34) {
    throw new Error('Unsupported or foreign retirement intent.');
  }
  const helperPaths = [...workerEngineFiles, 'manifest.json'].sort().map(name => path.join('worker-engine', name));
  const workerPaths = value.files.map(entry => entry?.path).filter(name => typeof name === 'string'
    && /^worker-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.ndjson$/.test(name));
  const paths = [...workerPaths, ...helperPaths, 'worker-operation.ndjson'];
  if (workerPaths.length > 32 || new Set(paths).size !== paths.length
    || !same(value.files.map(entry => entry?.path), paths)) throw new Error('Retirement deletion paths are not allowlisted.');
  if (value.files.find(entry => entry.path === path.join('worker-engine', 'manifest.json')).sha256
    !== value.manifestSha256) throw new Error('Retirement manifest binding changed.');
  return Object.freeze({
    ...value, lock, files: Object.freeze(value.files.map((entry, index) => fileEntry(entry, paths[index]))),
    state: fileEntry(value.state, 'state.json'), lockFile: fileEntry(value.lockFile, path.join('lock', 'owner.json')),
    controlIdentity: directoryIdentity(value.controlIdentity),
    lockIdentity: directoryIdentity(value.lockIdentity), engineIdentity: directoryIdentity(value.engineIdentity),
  });
}

export async function recoverRetirement({ control, project, operationId }) {
  const handles = [];
  const errors = [];
  let result;
  try {
    const { root } = await externalWorkerDirectory(control, project);
    await requireNoServiceMaintenance(root);
    const markerPath = path.join(root, markerName);
    const markerBytes = await readWorkerFile(markerPath, maximum, { privateMode: true });
    const original = intent(markerBytes, project, operationId);
    const markerInfo = await lstat(markerPath, { bigint: true });
    const marker = { path: markerName, ...identity(markerInfo), bytes: markerBytes.length, sha256: digest(markerBytes) };
    const checkFile = async entry => {
      const file = path.join(root, entry.path);
      const info = await lstat(file, { bigint: true });
      if (!same(identity(info), { dev: entry.dev, ino: entry.ino })) throw new Error('Recovery file was replaced.');
      const content = await readWorkerFile(file, maximum, { privateMode: true });
      if (content.length !== entry.bytes || digest(content) !== entry.sha256) throw new Error('Recovery content changed.');
      return content;
    };
    const retain = async entry => {
      const handle = await open(path.join(root, entry.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      handles.push(handle);
      if (!same(identity(await handle.stat({ bigint: true })), { dev: entry.dev, ino: entry.ino })) {
        throw new Error('Recovery evidence changed before retaining it.');
      }
      await checkFile(entry);
    };
    const checkDirectory = async (relative, expected) => {
      const current = await canonicalWorkerDirectory(path.join(root, relative), { privateMode: true });
      if (!same(identity(current.info), expected)) throw new Error('Original recovery directory was replaced.');
    };
    const requireDeadOwner = async () => {
      if (await processIdentity(original.lock.pid) === original.lock.processIdentity) {
        throw new Error('Original retirement controller is still alive.');
      }
    };
    const state = await loadState(root);
    if (!state || !['accepted', 'restored'].includes(state.phase)
      || state.project !== project || state.operationId !== operationId) throw new Error('Recovery requires accepted application state.');
    await checkDirectory('', original.controlIdentity);
    await checkDirectory('lock', original.lockIdentity);
    if (!same((await readdir(path.join(root, 'lock'))).sort(), ['owner.json'])) throw new Error('Unexpected lock evidence.');
    if (!same(captureLockOwner(parse(await checkFile(original.lockFile))), original.lock)) {
      throw new Error('Original lock no longer matches retirement intent.');
    }
    await checkFile(original.state);
    await checkFile(marker);
    await requireDeadOwner();
    await retain(marker);
    await retain(original.lockFile);
    await retain(original.state);
    const remaining = new Map();
    let reachedRemaining = false;
    for (const entry of original.files) {
      try { await lstat(path.join(root, entry.path)); }
      catch (error) {
        if (error.code === 'ENOENT' && !reachedRemaining) continue;
        throw error;
      }
      reachedRemaining = true;
      await retain(entry);
      remaining.set(entry.path, entry);
    }
    let enginePresent = true;
    try { await lstat(path.join(root, 'worker-engine')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      enginePresent = false;
    }
    let guard;
    let guardFile;
    const checkGuard = async () => {
      if (!guard) return;
      await checkDirectory(guardName, guard);
      await checkFile(guardFile);
    };
    const checkAuthority = async () => {
      await requireNoServiceMaintenance(root);
      await checkDirectory('', original.controlIdentity);
      await checkDirectory('lock', original.lockIdentity);
      await checkFile(original.lockFile);
      await checkFile(original.state);
      await checkFile(marker);
      if (!same(await loadState(root), state)) throw new Error('Application state changed during recovery.');
      await requireDeadOwner();
      await checkGuard();
    };
    const checkInventory = async () => {
      await checkAuthority();
      const expected = [...remaining.keys()].filter(file => !file.startsWith(`worker-engine${path.sep}`));
      expected.push(markerName);
      if (enginePresent) expected.push('worker-engine');
      const actual = (await readdir(root)).filter(file => file.startsWith('worker-')).sort();
      if (!same(actual, expected.sort())) throw new Error('Unexpected cold recovery inventory.');
      if (enginePresent) {
        await checkDirectory('worker-engine', original.engineIdentity);
        const expectedEngine = [...remaining.keys()].filter(file => file.startsWith(`worker-engine${path.sep}`))
          .map(file => path.basename(file)).sort();
        if (!same((await readdir(path.join(root, 'worker-engine'))).sort(), expectedEngine)) {
          throw new Error('Unexpected cold helper inventory.');
        }
      }
    };
    await checkInventory();
    const guardPath = path.join(root, guardName);
    await mkdir(guardPath, { mode: 0o700 });
    await syncWorkerDirectory(root);
    guard = identity(await lstat(guardPath));
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Cannot identify recovery controller.');
    const lease = Buffer.from(`${JSON.stringify({
      version: 1, token: randomUUID(), pid: process.pid, controllerIdentity, lock: original.lock,
      intentSha256: marker.sha256,
    })}\n`);
    const leasePath = path.join(guardPath, 'owner.json');
    await writeWorkerFile(leasePath, lease);
    await syncWorkerDirectory(guardPath);
    guardFile = { path: path.join(guardName, 'owner.json'), ...identity(await lstat(leasePath, { bigint: true })),
      bytes: lease.length, sha256: digest(lease) };
    await retain(guardFile);
    await checkInventory();
    for (const entry of original.files) {
      if (!remaining.has(entry.path)) continue;
      await checkInventory();
      await checkFile(entry);
      await unlink(path.join(root, entry.path));
      remaining.delete(entry.path);
      await syncWorkerDirectory(path.dirname(path.join(root, entry.path)));
    }
    await checkInventory();
    if (enginePresent) {
      await rmdir(path.join(root, 'worker-engine'));
      enginePresent = false;
      await syncWorkerDirectory(root);
    }
    await checkInventory();
    result = { status: 'retired', operationId, restored: false };
    const complete = Buffer.from(`${JSON.stringify({ ...result, intentSha256: marker.sha256 })}\n`);
    const completePath = path.join(guardPath, 'complete.json');
    await writeWorkerFile(completePath, complete);
    await syncWorkerDirectory(guardPath);
    for (const handle of handles.splice(0)) {
      try { await handle.close(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new Error('Recovery evidence handles did not all close.');
    await checkInventory();
    await unlink(markerPath);
    await syncWorkerDirectory(root);
    await checkGuard();
    await checkDirectory('lock', original.lockIdentity);
    await checkFile(original.lockFile);
    await checkFile(original.state);
    await unlink(path.join(root, original.lockFile.path));
    await syncWorkerDirectory(path.join(root, 'lock'));
    await rmdir(path.join(root, 'lock'));
    await syncWorkerDirectory(root);
    await checkGuard();
    if (!(await readWorkerFile(completePath, 4096, { privateMode: true })).equals(complete)) {
      throw new Error('Recovery completion evidence changed.');
    }
    await unlink(completePath);
    await unlink(leasePath);
    await syncWorkerDirectory(guardPath);
    await rmdir(guardPath);
    await syncWorkerDirectory(root);
  } catch (error) { errors.push(error); }
  for (const handle of handles) {
    try { await handle.close(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw Object.assign(new Error('Interrupted retirement remains blocked; retain recovery evidence.', {
    cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
  }), { code: 'DEPLOYMENT_RECOVERY_UNSETTLED', recoveryAllowed: false });
  return result;
}
