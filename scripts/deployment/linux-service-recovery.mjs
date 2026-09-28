import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureLockOwner, loadState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { workerEngineFiles } from './saved-worker-engine.mjs';
import { acquireRecoveryAdmission } from './linux-recovery-admission.mjs';
import { validateWorkerRetirementHandoff } from './linux-worker-retirement-handoff.mjs';
import { finishServiceRecovery, readServiceCompletion, recoveryPathExists, validateRecoveryLease } from './linux-recovery-completion.mjs';
import { canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';

const maximum = 1024 * 1024;
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
  const parsed = parse(bytes);
  const value = captureWorkerFields(parsed, [
    'version', 'lock', 'runtime', 'state', 'stateFile', 'lockFile',
    'controlIdentity', 'lockIdentity', 'heldParentIdentity', 'files', ...(parsed?.version === 3 ? ['workers'] : []),
  ], 'service retirement intent');
  const lock = captureLockOwner(value.lock);
  const unit = value.runtime?.runtime?.unit;
  if (![2, 3].includes(value.version) || lock.project !== project || lock.operationId !== operationId
    || typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(unit)
    || value.runtime.runtime.project !== project || !Array.isArray(value.runtime.executables)
    || value.runtime.executables.length !== 2 || !value.runtime.configuration
    || !Array.isArray(value.files) || value.files.length !== 3) {
    throw new Error('Unsupported or foreign service retirement intent.');
  }
  const inhibition = `/etc/systemd/system/${unit}.d/90-agents-chat-deployment.conf`;
  const files = [`${inhibition}.${lock.token}.held`,
    path.join(control, 'service-activation.ndjson'), path.join(control, 'service-stop.ndjson')];
  let workers = null;
  if (value.version === 3 && value.workers !== null) {
    const fields = captureWorkerFields(value.workers, ['manifestSha256', 'engineIdentity', 'files'], 'service worker handoff');
    if (typeof fields.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fields.manifestSha256)
      || !Array.isArray(fields.files) || fields.files.length > workerEngineFiles.length + 34) {
      throw new Error('Invalid service worker handoff.');
    }
    const helpers = [...workerEngineFiles, 'manifest.json'].sort().map(name => path.join(control, 'worker-engine', name));
    const journals = fields.files.map(entry => entry?.file).filter(file => typeof file === 'string'
      && path.dirname(file) === control && /^worker-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.ndjson$/.test(path.basename(file)));
    const paths = [...journals, ...helpers, path.join(control, 'worker-operation.ndjson')];
    if (journals.length > 32 || new Set(paths).size !== paths.length
      || !same(fields.files.map(entry => entry?.file), paths)) throw new Error('Worker handoff paths are not allowlisted.');
    const entries = fields.files.map((entry, index) => fileEntry(entry, paths[index]));
    if (entries.find(entry => entry.file === path.join(control, 'worker-engine', 'manifest.json')).sha256
      !== fields.manifestSha256) throw new Error('Worker handoff manifest binding changed.');
    workers = { ...fields, engineIdentity: directoryIdentity(fields.engineIdentity), files: entries };
  }
  return {
    ...value, lock, inhibition, workers, files: value.files.map((entry, index) => fileEntry(entry, files[index])),
    stateFile: fileEntry(value.stateFile, path.join(control, 'state.json')),
    lockFile: fileEntry(value.lockFile, path.join(control, 'lock', 'owner.json')),
    controlIdentity: directoryIdentity(value.controlIdentity),
    lockIdentity: directoryIdentity(value.lockIdentity),
    heldParentIdentity: directoryIdentity(value.heldParentIdentity),
  };
}

export async function recoverLinuxServiceRetirement({ control, project, operationId }) {
  const admission = await acquireRecoveryAdmission(control);
  try { return await recoverAdmitted({ control, project, operationId, admission }); }
  catch (cause) {
    if (cause.recoveryAllowed === false) throw cause;
    throw Object.assign(new Error('Service recovery remains blocked; retain evidence.', { cause }),
      { code: 'DEPLOYMENT_RECOVERY_UNSETTLED', recoveryAllowed: false });
  } finally { await admission.close(); }
}

async function recoverAdmitted({ control, project, operationId, admission }) {
  const handles = [];
  const errors = [];
  let service;
  let result;
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Service recovery requires a Linux root controller.');
    const { root } = await externalWorkerDirectory(control, project);
    const live = await recoveryPathExists(path.join(root, 'live-retirement.json'));
    const activeMarkerName = live ? 'live-retirement.json' : markerName;
    const markerPath = path.join(root, activeMarkerName);
    if (live && await recoveryPathExists(path.join(root, markerName))) throw new Error('Competing service retirement intents.');
    const receiptPath = path.join(root, 'recovery-complete.json');
    let superseded;
    if (await recoveryPathExists(receiptPath)) {
      const proof = await readServiceCompletion({ control: root, project, parseIntent: intent });
      if (proof.original.lock.operationId === operationId) {
        return await finishServiceRecovery({ control: root, project, operationId, parseIntent: intent, admission });
      }
      if (await recoveryPathExists(path.join(root, 'recovery-lock'))
        || await processIdentity(proof.leaseOwner.pid) === proof.leaseOwner.controllerIdentity) {
        throw new Error('Prior recovery is incomplete or still owned.');
      }
      superseded = proof;
    }
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
    await deadOwner();
    const state = await loadState(root);
    if (!state || !['accepted', 'prior-runtime-restored'].includes(state.phase)
      || state.operationId !== operationId
      || state.project !== project || !same(state, original.state)) {
      throw new Error('Service recovery requires the original verified completed state.');
    }
    await retain(marker);
    await retain(original.stateFile);
    const lockPresent = await recoveryPathExists(path.join(root, 'lock'));
    const ownerPresent = await recoveryPathExists(original.lockFile.file);
    if (!live || ownerPresent) await retain(original.lockFile);
    if (ownerPresent && !same(captureLockOwner(parse(await checkFile(original.lockFile))), original.lock)) {
      throw new Error('Original service lock does not match intent.');
    }
    const workerMarkerPath = path.join(root, 'worker-retirement.json');
    let workerMarker;
    if (await recoveryPathExists(workerMarkerPath)) {
      if (!live || !lockPresent || !ownerPresent) {
        throw new Error('Worker handoff requires the original live service receipt and lock.');
      }
      for (const entry of original.files) await absent(entry.file);
      const bytes = await readWorkerFile(workerMarkerPath, maximum, { privateMode: true });
      validateWorkerRetirementHandoff(bytes, root, original);
      workerMarker = { file: workerMarkerPath, ...identity(await lstat(workerMarkerPath)),
        bytes: bytes.length, sha256: digest(bytes) };
      await retain(workerMarker);
    }
    const entries = [...original.files, ...(original.workers?.files ?? [])];
    const enginePath = path.join(root, 'worker-engine');
    let enginePresent = false;
    if (original.workers) {
      try { await lstat(enginePath); enginePresent = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const remaining = new Map();
    let reachedRemaining = false;
    for (const entry of entries) {
      try { await lstat(entry.file); }
      catch (error) {
        if (error.code === 'ENOENT' && !reachedRemaining) continue;
        throw error;
      }
      reachedRemaining = true;
      await retain(entry);
      remaining.set(entry.file, entry);
    }
    if (live && (!lockPresent || !ownerPresent) && (remaining.size || enginePresent)) {
      throw new Error('Live unlock started before combined cleanup completed.');
    }
    service = await inspectLinuxService({ unit: original.runtime.runtime.unit, project,
      npm: original.runtime.executables[0].file, node: original.runtime.executables[1].file });
    if (!same(service.identity, original.runtime)) throw new Error('Original verified service generation or policy changed.');
    let guard;
    let lease;
    let leaseOwner;
    let ownLease = false;
    const leasePath = path.join(guardPath, 'owner.json');
    if (await recoveryPathExists(guardPath)) {
      guard = identity((await canonicalWorkerDirectory(guardPath, { privateMode: true })).info);
      const bytes = await readWorkerFile(leasePath, 65536, { privateMode: true });
      leaseOwner = validateRecoveryLease(parse(bytes), original, marker.sha256, guard);
      if (await processIdentity(leaseOwner.pid) === leaseOwner.controllerIdentity) {
        throw new Error('Recovery lease controller is still alive.');
      }
      lease = { file: leasePath, ...identity(await lstat(leasePath)), bytes: bytes.length, sha256: digest(bytes) };
      await retain(lease);
    }
    const checkGuard = async () => {
      if (!guard) return absent(guardPath);
      await checkDirectory(guardPath, guard);
      await checkFile(lease);
      if (!ownLease && await processIdentity(leaseOwner.pid) === leaseOwner.controllerIdentity) {
        throw new Error('Recovery lease controller is still alive.');
      }
      if (!same((await readdir(guardPath)).sort(), ['owner.json'])) {
        throw new Error('Unexpected service recovery guard inventory.');
      }
    };
    const check = async () => {
      await admission.check();
      await deadOwner();
      await service.check();
      await checkDirectory(root, original.controlIdentity);
      if (!live || lockPresent) await checkDirectory(path.join(root, 'lock'), original.lockIdentity);
      else await absent(path.join(root, 'lock'));
      await checkDirectory(path.dirname(original.inhibition), original.heldParentIdentity, false);
      await absent(original.inhibition);
      await checkFile(marker);
      if (workerMarker) await checkFile(workerMarker);
      else await absent(workerMarkerPath);
      await checkFile(original.stateFile);
      if (!live || ownerPresent) await checkFile(original.lockFile);
      else await absent(original.lockFile.file);
      if (lockPresent && !same((await readdir(path.join(root, 'lock'))).sort(), ownerPresent ? ['owner.json'] : [])) {
        throw new Error('Unexpected original lock inventory.');
      }
      await checkGuard();
      for (const entry of entries) {
        if (remaining.has(entry.file)) await checkFile(entry);
        else await absent(entry.file);
      }
      const names = await readdir(root);
      const workerNames = [...remaining.keys()].filter(file => path.dirname(file) === root
        && path.basename(file).startsWith('worker-')).map(file => path.basename(file));
      if (enginePresent) workerNames.push('worker-engine');
      if (workerMarker) workerNames.push('worker-retirement.json');
      if (!same(names.filter(name => name.startsWith('worker-')).sort(), workerNames.sort())) {
        throw new Error('Worker evidence differs from the pinned combined handoff.');
      }
      if (enginePresent) {
        await checkDirectory(enginePath, original.workers.engineIdentity);
        const helpers = [...remaining.keys()].filter(file => path.dirname(file) === enginePath).map(file => path.basename(file)).sort();
        if (!same((await readdir(enginePath)).sort(), helpers)) throw new Error('Worker helper handoff inventory changed.');
      } else await absent(enginePath);
      const expected = [activeMarkerName, ...[...remaining.keys()].filter(file => path.dirname(file) === root
        && path.basename(file).startsWith('service-')).map(file => path.basename(file))].sort();
      if (!same(names.filter(name => name.startsWith('service-') || name === 'live-retirement.json').sort(), expected)) {
        throw new Error('Unexpected service evidence inventory.');
      }
    };
    await check();
    if (superseded) {
      if (superseded.original.lock.token === original.lock.token
        || !same(superseded.original.controlIdentity, original.controlIdentity)
        || !same(identity(await lstat(receiptPath)), superseded.receiptIdentity)
        || !(await readWorkerFile(receiptPath, 2 * maximum, { privateMode: true })).equals(superseded.receiptBytes)) {
        throw new Error('Superseded recovery receipt no longer matches the prior operation.');
      }
      await unlink(receiptPath);
      await syncWorkerDirectory(root);
    }
    if (!guard) {
      await mkdir(guardPath, { mode: 0o700 });
      await syncWorkerDirectory(root);
      guard = identity(await lstat(guardPath));
      const controllerIdentity = await processIdentity(process.pid);
      if (!controllerIdentity) throw new Error('Recovery controller identity unavailable.');
      leaseOwner = { version: 2, token: randomUUID(), pid: process.pid,
        controllerIdentity, lock: original.lock, intentSha256: marker.sha256, kind: 'service', guard };
      const bytes = Buffer.from(`${JSON.stringify(leaseOwner)}\n`);
      await writeWorkerFile(leasePath, bytes);
      await syncWorkerDirectory(guardPath);
      lease = { file: leasePath, ...identity(await lstat(leasePath)), bytes: bytes.length, sha256: digest(bytes) };
      ownLease = true;
      await retain(lease);
    }
    if (workerMarker) {
      await check();
      // The original service receipt still pins every remaining worker file.
      await unlink(workerMarkerPath);
      workerMarker = null;
      await syncWorkerDirectory(root);
    }
    for (const entry of entries) {
      if (!remaining.has(entry.file)) continue;
      await check();
      await unlink(entry.file);
      remaining.delete(entry.file);
      await syncWorkerDirectory(path.dirname(entry.file));
    }
    await check();
    if (enginePresent) {
      await rmdir(enginePath);
      enginePresent = false;
      await syncWorkerDirectory(root);
    }
    await check();
    const completePath = path.join(root, 'recovery-complete.pending');
    const complete = Buffer.from(`${JSON.stringify({
      version: live ? 2 : 1, intent: markerBytes.toString('utf8'), intentSha256: marker.sha256,
      marker, guard, lease, leaseBytes: (await checkFile(lease)).toString('utf8'),
    })}\n`);
    if (await recoveryPathExists(completePath)) {
      if (!(await readWorkerFile(completePath, maximum, { privateMode: true })).equals(complete)) {
        throw new Error('Incomplete or changed pending recovery completion.');
      }
    } else await writeWorkerFile(completePath, complete);
    await check();
    await absent(receiptPath);
    await rename(completePath, receiptPath);
    await syncWorkerDirectory(root);
    await service.close();
    service = null;
    while (handles.length) {
      await handles[0].close();
      handles.shift();
    }
    retained.clear();
    result = await finishServiceRecovery({ control: root, project, operationId, parseIntent: intent, admission, ownLease });
  } catch (error) { errors.push(error); }
  const closed = await Promise.allSettled([...handles.map(handle => handle.close()), service?.close()]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => value.reason));
  if (errors.length) throw Object.assign(new Error('Service retirement recovery remains blocked; retain lock and evidence.', {
    cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
  }), { code: 'DEPLOYMENT_RECOVERY_UNSETTLED', recoveryAllowed: false });
  return result;
}
