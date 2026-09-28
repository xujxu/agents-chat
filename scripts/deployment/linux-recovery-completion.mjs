import { createHash } from 'node:crypto';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';
import { captureLockOwner, loadState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const maximum = 2 * 1024 * 1024;
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

export async function recoveryPathExists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function validateRecoveryLease(value, original, intentSha256, guard) {
  const lease = captureWorkerFields(value,
    ['version', 'token', 'pid', 'controllerIdentity', 'lock', 'intentSha256', 'kind', 'guard'], 'recovery lease');
  if (lease.version !== 2 || lease.kind !== 'service' || !same(lease.guard, guard)
    || typeof lease.token !== 'string' || !/^[a-f0-9-]{36}$/.test(lease.token)
    || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || lease.pid > 2147483647
    || typeof lease.controllerIdentity !== 'string' || !lease.controllerIdentity
    || lease.intentSha256 !== intentSha256 || !same(captureLockOwner(lease.lock), original.lock)) {
    throw new Error('Recovery lease does not match original retirement authority.');
  }
  return lease;
}

export async function readServiceCompletion({ control, project, operationId, parseIntent }) {
  const receiptPath = path.join(control, 'recovery-complete.json');
  const receiptBytes = await readWorkerFile(receiptPath, maximum, { privateMode: true });
  const receiptIdentity = identity(await lstat(receiptPath));
  const receipt = captureWorkerFields(parse(receiptBytes),
    ['version', 'intent', 'intentSha256', 'marker', 'guard', 'lease', 'leaseBytes'], 'service completion');
  if (![1, 2].includes(receipt.version) || typeof receipt.intent !== 'string'
    || digest(Buffer.from(receipt.intent)) !== receipt.intentSha256 || typeof receipt.leaseBytes !== 'string') {
    throw new Error('Invalid service completion proof.');
  }
  const original = parseIntent(Buffer.from(receipt.intent), control, project,
    operationId ?? parse(Buffer.from(receipt.intent))?.lock?.operationId);
  if (!original.state || !['accepted', 'prior-runtime-restored'].includes(original.state.phase)
    || original.state.project !== project || original.state.operationId !== original.lock.operationId) {
    throw new Error('Completion proof does not describe a verified terminal operation.');
  }
  const leaseOwner = validateRecoveryLease(parse(Buffer.from(receipt.leaseBytes)), original, receipt.intentSha256, receipt.guard);
  const markerPath = path.join(control, receipt.version === 2 ? 'live-retirement.json' : 'service-retirement.json');
  const lockDirectory = path.join(control, 'lock');
  const guardPath = path.join(control, 'recovery-lock');
  const leasePath = path.join(guardPath, 'owner.json');
  const descriptor = (entry, expected, expectedBytes) => {
    captureWorkerFields(entry, ['file', 'dev', 'ino', 'bytes', 'sha256'], 'completion file');
    if (entry.file !== expected || ![entry.dev, entry.ino].every(value => typeof value === 'string' && /^[0-9]+$/.test(value))
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maximum
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || expectedBytes && (entry.bytes !== expectedBytes.length || entry.sha256 !== digest(expectedBytes))) {
      throw new Error('Invalid completion file binding.');
    }
  };
  descriptor(receipt.marker, markerPath, Buffer.from(receipt.intent));
  descriptor(receipt.lease, leasePath, Buffer.from(receipt.leaseBytes));
  captureWorkerFields(receipt.guard, ['dev', 'ino'], 'completion guard');
  if (![receipt.guard.dev, receipt.guard.ino].every(value => typeof value === 'string' && /^[0-9]+$/.test(value))) {
    throw new Error('Invalid completion guard identity.');
  }
  return { receiptPath, receiptBytes, receiptIdentity, receipt, original, leaseOwner, markerPath,
    lockDirectory, guardPath, leasePath };
}

export async function finishServiceRecovery({ control, project, operationId, parseIntent, admission, ownLease = false }) {
  const { receiptPath, receiptBytes, receiptIdentity, receipt, original, leaseOwner, markerPath,
    lockDirectory, guardPath, leasePath } = await readServiceCompletion({ control, project, operationId, parseIntent });
  const checkFile = async entry => {
    if (!same(identity(await lstat(entry.file)), { dev: entry.dev, ino: entry.ino })) throw new Error('Completion file replaced.');
    const bytes = await readWorkerFile(entry.file, maximum, { privateMode: true });
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error('Completion file changed.');
  };
  const checkDirectory = async (file, expected) => {
    const current = await canonicalWorkerDirectory(file, { privateMode: true });
    if (!same(identity(current.info), expected)) throw new Error('Completion directory replaced.');
  };
  const service = await inspectLinuxService({ unit: original.runtime.runtime.unit, project,
    npm: original.runtime.executables[0].file, node: original.runtime.executables[1].file });
  try {
    if (!same(service.identity, original.runtime)) throw new Error('Completed service generation changed.');
    const lockSteps = [
      { file: original.lockFile.file, entry: original.lockFile },
      { file: lockDirectory, directory: original.lockIdentity },
    ];
    const markerStep = { file: markerPath, entry: receipt.marker };
    const sequence = [
      ...(receipt.version === 2 ? [...lockSteps, markerStep] : [markerStep, ...lockSteps]),
      { file: leasePath, entry: receipt.lease },
      { file: guardPath, directory: receipt.guard },
    ];
    const check = async () => {
      await admission.check();
      await checkDirectory(control, original.controlIdentity);
      if (!same(identity(await lstat(receiptPath)), receiptIdentity)
        || !(await readWorkerFile(receiptPath, maximum, { privateMode: true })).equals(receiptBytes)) {
        throw new Error('Completion authority changed.');
      }
      if (await processIdentity(original.lock.pid) === original.lock.processIdentity) throw new Error('Original controller still alive.');
      const observed = await processIdentity(leaseOwner.pid);
      if (observed === leaseOwner.controllerIdentity
        && !(ownLease && leaseOwner.pid === process.pid)) throw new Error('Recovery lease owner still alive.');
      await service.check();
      const parent = await canonicalWorkerDirectory(path.dirname(original.inhibition));
      if (!same(identity(parent.info), original.heldParentIdentity) || parent.info.uid !== 0 || parent.info.mode & 0o022) {
        throw new Error('Completed service maintenance directory changed.');
      }
      await checkFile(original.stateFile);
      if (!same(await loadState(control), original.state)) throw new Error('Completed application state changed.');
      for (const entry of [...original.files, ...(original.workers?.files ?? [])]) {
        if (await recoveryPathExists(entry.file)) throw new Error('Cleanup is incomplete or evidence reappeared.');
      }
      if (await recoveryPathExists(original.inhibition) || await recoveryPathExists(path.join(control, 'worker-engine'))) {
        throw new Error('Completed service inhibition or helper directory reappeared.');
      }
      const names = await readdir(control);
      if (names.some(name => name.startsWith('worker-')
        || (name.startsWith('service-') || name === 'live-retirement.json') && name !== path.basename(markerPath))) {
        throw new Error('Unexpected completion evidence inventory.');
      }
      let reached = false;
      for (const step of sequence) {
        if (!await recoveryPathExists(step.file)) {
          if (reached) throw new Error('Gap in final recovery deletion sequence.');
          continue;
        }
        reached = true;
        if (step.entry) await checkFile(step.entry);
        else {
          await checkDirectory(step.file, step.directory);
          const children = await readdir(step.file);
          const expected = await recoveryPathExists(path.join(step.file, 'owner.json')) ? ['owner.json'] : [];
          if (!same(children.sort(), expected)) throw new Error('Unexpected completion directory inventory.');
        }
      }
    };
    await check();
    for (const step of sequence) {
      if (!await recoveryPathExists(step.file)) continue;
      await check();
      if (step.directory) await rmdir(step.file);
      else await unlink(step.file);
      await syncWorkerDirectory(path.dirname(step.file));
    }
    await check();
    return { status: 'service-retired', operationId, restored: false };
  } finally { await service.close(); }
}
