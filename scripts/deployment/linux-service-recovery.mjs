import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureLockOwner, loadState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';

const maximum = 512 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const markerName = 'service-retirement.json';

function directoryIdentity(value) {
  const fields = captureWorkerFields(value, ['dev', 'ino'], 'service retirement directory');
  if (!Object.values(fields).every(field => typeof field === 'string' && /^[0-9]+$/.test(field))) {
    throw new Error('Invalid service retirement directory identity.');
  }
  return fields;
}

function fileEntry(value, expected) {
  const entry = captureWorkerFields(value, ['file', 'dev', 'ino', 'bytes', 'sha256'], 'service retirement file');
  directoryIdentity({ dev: entry.dev, ino: entry.ino });
  if (entry.file !== expected || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maximum
    || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error('Invalid service retirement deletion file.');
  }
  return entry;
}

function intent(bytes, control, project, operationId) {
  const value = captureWorkerFields(parse(bytes), [
    'version', 'lock', 'runtime', 'state', 'stateFile', 'lockFile',
    'controlIdentity', 'lockIdentity', 'heldParentIdentity', 'files',
  ], 'service retirement intent');
  const lock = captureLockOwner(value.lock);
  const unit = value.runtime?.runtime?.unit;
  if (value.version !== 2 || lock.project !== project || lock.operationId !== operationId
    || typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(unit)
    || value.runtime.runtime.project !== project || !Array.isArray(value.runtime.executables)
    || value.runtime.executables.length !== 2 || !value.runtime.configuration
    || !Array.isArray(value.files) || value.files.length !== 3) {
    throw new Error('Unsupported or foreign service retirement intent.');
  }
  const inhibition = `/etc/systemd/system/${unit}.d/90-agents-chat-deployment.conf`;
  const files = [`${inhibition}.${lock.token}.held`,
    path.join(control, 'service-activation.ndjson'), path.join(control, 'service-stop.ndjson')];
  return {
    ...value, lock, inhibition, files: value.files.map((entry, index) => fileEntry(entry, files[index])),
    stateFile: fileEntry(value.stateFile, path.join(control, 'state.json')),
    lockFile: fileEntry(value.lockFile, path.join(control, 'lock', 'owner.json')),
    controlIdentity: directoryIdentity(value.controlIdentity),
    lockIdentity: directoryIdentity(value.lockIdentity),
    heldParentIdentity: directoryIdentity(value.heldParentIdentity),
  };
}

export async function recoverLinuxServiceRetirement({ control, project, operationId }) {
  const handles = [];
  const errors = [];
  let service;
  let result;
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Service recovery requires a Linux root controller.');
    const { root } = await externalWorkerDirectory(control, project);
    const markerPath = path.join(root, markerName);
    const markerBytes = await readWorkerFile(markerPath, maximum, { privateMode: true });
    const original = intent(markerBytes, root, project, operationId);
    const marker = { file: markerPath, ...identity(await lstat(markerPath)),
      bytes: markerBytes.length, sha256: digest(markerBytes) };
    const retained = new Map();
    const checkFile = async entry => {
      const named = await lstat(entry.file);
      if (!same(identity(named), { dev: entry.dev, ino: entry.ino })) throw new Error('Service recovery file replaced.');
      const handle = retained.get(entry.file);
      if (handle && (!same(identity(await handle.stat()), identity(named)) || (await handle.stat()).nlink !== 1)) {
        throw new Error('Retained service recovery file replaced.');
      }
      const bytes = await readWorkerFile(entry.file, maximum, { privateMode: true });
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error('Service recovery file changed.');
      return bytes;
    };
    const retain = async entry => {
      const handle = await open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(handle);
      retained.set(entry.file, handle);
      await checkFile(entry);
    };
    const checkDirectory = async (file, expected, privateMode = true) => {
      const { info } = await canonicalWorkerDirectory(file, { privateMode });
      if (!same(identity(info), expected) || info.uid !== 0 || info.mode & 0o022) {
        throw new Error('Original service recovery directory replaced or writable.');
      }
    };
    const absent = async file => {
      try { await lstat(file); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      throw new Error('Unexpected service recovery path exists.');
    };
    const deadOwner = async () => {
      if (await processIdentity(original.lock.pid) === original.lock.processIdentity) {
        throw new Error('Original service controller is still alive.');
      }
    };
    const guardPath = path.join(root, 'recovery-lock');
    await absent(guardPath);
    await deadOwner();
    const state = await loadState(root);
    if (!state || !['accepted', 'prior-runtime-restored'].includes(state.phase)
      || state.operationId !== operationId
      || state.project !== project || !same(state, original.state)) {
      throw new Error('Service recovery requires the original verified completed state.');
    }
    await retain(marker);
    await retain(original.stateFile);
    await retain(original.lockFile);
    if (!same(captureLockOwner(parse(await checkFile(original.lockFile))), original.lock)) {
      throw new Error('Original service lock does not match intent.');
    }
    const remaining = new Map();
    let reachedRemaining = false;
    for (const entry of original.files) {
      try { await lstat(entry.file); }
      catch (error) {
        if (error.code === 'ENOENT' && !reachedRemaining) continue;
        throw error;
      }
      reachedRemaining = true;
      await retain(entry);
      remaining.set(entry.file, entry);
    }
    service = await inspectLinuxService({ unit: original.runtime.runtime.unit, project,
      npm: original.runtime.executables[0].file, node: original.runtime.executables[1].file });
    if (!same(service.identity, original.runtime)) throw new Error('Original verified service generation or policy changed.');
    let guard;
    let lease;
    let completion;
    const checkGuard = async () => {
      if (!guard) return absent(guardPath);
      await checkDirectory(guardPath, guard);
      await checkFile(lease);
      if (completion) await checkFile(completion);
      if (!same((await readdir(guardPath)).sort(), completion ? ['complete.json', 'owner.json'] : ['owner.json'])) {
        throw new Error('Unexpected service recovery guard inventory.');
      }
    };
    const check = async () => {
      await deadOwner();
      await service.check();
      await checkDirectory(root, original.controlIdentity);
      await checkDirectory(path.join(root, 'lock'), original.lockIdentity);
      await checkDirectory(path.dirname(original.inhibition), original.heldParentIdentity, false);
      await absent(original.inhibition);
      await checkFile(marker);
      await checkFile(original.stateFile);
      await checkFile(original.lockFile);
      if (!same((await readdir(path.join(root, 'lock'))).sort(), ['owner.json'])) throw new Error('Unexpected original lock inventory.');
      await checkGuard();
      for (const entry of original.files) {
        if (remaining.has(entry.file)) await checkFile(entry);
        else await absent(entry.file);
      }
      const names = await readdir(root);
      if (names.some(name => name.startsWith('worker-'))) throw new Error('Worker evidence requires a combined recovery handoff.');
      const expected = [markerName, ...[...remaining.keys()].filter(file => path.dirname(file) === root).map(file => path.basename(file))].sort();
      if (!same(names.filter(name => name.startsWith('service-')).sort(), expected)) throw new Error('Unexpected service evidence inventory.');
    };
    await check();
    await mkdir(guardPath, { mode: 0o700 });
    await syncWorkerDirectory(root);
    guard = identity(await lstat(guardPath));
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Recovery controller identity unavailable.');
    const leasePath = path.join(guardPath, 'owner.json');
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, token: randomUUID(), pid: process.pid,
      controllerIdentity, lock: original.lock, intentSha256: marker.sha256, kind: 'service' })}\n`);
    await writeWorkerFile(leasePath, bytes);
    await syncWorkerDirectory(guardPath);
    lease = { file: leasePath, ...identity(await lstat(leasePath)), bytes: bytes.length, sha256: digest(bytes) };
    await retain(lease);
    for (const entry of original.files) {
      if (!remaining.has(entry.file)) continue;
      await check();
      await unlink(entry.file);
      remaining.delete(entry.file);
      await syncWorkerDirectory(path.dirname(entry.file));
    }
    await check();
    result = { status: 'service-retired', operationId, restored: false };
    const completePath = path.join(guardPath, 'complete.json');
    const complete = Buffer.from(`${JSON.stringify({ ...result, intentSha256: marker.sha256 })}\n`);
    await writeWorkerFile(completePath, complete);
    await syncWorkerDirectory(guardPath);
    completion = { file: completePath, ...identity(await lstat(completePath)), bytes: complete.length, sha256: digest(complete) };
    await retain(completion);
    await check();
    await service.close();
    service = null;
    while (handles.length) {
      await handles[0].close();
      handles.shift();
    }
    retained.clear();
    await checkFile(marker);
    await checkFile(original.stateFile);
    await checkFile(original.lockFile);
    await checkDirectory(root, original.controlIdentity);
    await checkDirectory(path.join(root, 'lock'), original.lockIdentity);
    await checkGuard();
    await deadOwner();
    await unlink(markerPath);
    await syncWorkerDirectory(root);
    await checkDirectory(path.join(root, 'lock'), original.lockIdentity);
    await checkFile(original.lockFile);
    await checkFile(original.stateFile);
    await checkGuard();
    await deadOwner();
    await unlink(original.lockFile.file);
    await syncWorkerDirectory(path.join(root, 'lock'));
    await rmdir(path.join(root, 'lock'));
    await syncWorkerDirectory(root);
    if (!(await readWorkerFile(completePath, 4096, { privateMode: true })).equals(complete)) {
      throw new Error('Service recovery completion changed.');
    }
    await checkDirectory(guardPath, guard);
    await checkFile(lease);
    await unlink(completePath);
    await unlink(leasePath);
    await syncWorkerDirectory(guardPath);
    await rmdir(guardPath);
    await syncWorkerDirectory(root);
  } catch (error) { errors.push(error); }
  const closed = await Promise.allSettled([...handles.map(handle => handle.close()), service?.close()]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => value.reason));
  if (errors.length) throw Object.assign(new Error('Service retirement recovery remains blocked; retain lock and evidence.', {
    cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
  }), { code: 'DEPLOYMENT_RECOVERY_UNSETTLED', recoveryAllowed: false });
  return result;
}
