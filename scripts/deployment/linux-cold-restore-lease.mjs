import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureLockOwner } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { createColdActivationState, captureColdActivationIntent } from './linux-cold-activation-state.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';

export const coldRestoreLeaseNames = Object.freeze(['recovery-lock', 'cold-restore-staging']);
const identity = info => ({ dev: info.dev, ino: info.ino });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const coldRestoreSnapshotDigest = snapshot => digest(Buffer.from(JSON.stringify(snapshot)));
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const filesReceipt = record => ({
  version: 1, phase: 'files-restored', project: record.project,
  operationId: record.lock.operationId, token: record.lock.token,
  backupId: record.backupId, snapshotSha256: record.snapshotSha256,
});

export async function inspectColdRestoreLease({ control, project, backup, lock, state, retain, activation = false }) {
  const root = await canonicalWorkerDirectory(control, { privateMode: true });
  const applicationLock = await canonicalWorkerDirectory(path.join(control, 'lock'), { privateMode: true });
  const read = retain ?? (file => readWorkerFile(file, 1024 * 1024, { privateMode: true }));
  const inspect = async name => {
    const directory = path.join(control, name);
    try { await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const location = await canonicalWorkerDirectory(directory, { privateMode: true });
    const entries = (await readdir(directory)).sort();
    const info = identity(location.info);
    if (name === 'cold-restore-staging' && !entries.length) return { directory, info, record: null, bytes: null };
    const hasReceipt = name === 'recovery-lock' && entries.includes('files-restored.json');
    const hasActivation = activation && name === 'recovery-lock' && entries.includes('activation-intent.json');
    const hasReady = hasActivation && entries.includes('activation-ready.json');
    if (!same(entries, [...(hasActivation ? ['activation-intent.json'] : []),
      ...(hasReady ? ['activation-ready.json'] : []), ...(hasReceipt ? ['files-restored.json'] : []), 'owner.json'])) {
      throw new Error('Cold restore lease contains incomplete or foreign evidence.');
    }
    const bytes = await read(path.join(directory, 'owner.json'));
    const record = captureWorkerFields(parse(bytes), [
      'version', 'project', 'backup', 'backupId', 'snapshotSha256', 'controlIdentity', 'lockIdentity',
      'lock', 'state', 'owner', 'guardIdentity', 'stagingIdentity', 'predecessor',
    ], 'cold restore lease');
    const owner = captureLockOwner(record.owner);
    if (record.version !== 1 || record.project !== project || record.backup !== path.resolve(backup)
      || !/^[a-zA-Z0-9_-]+$/.test(record.backupId) || !validDigest(record.snapshotSha256)
      || !same(record.controlIdentity, identity(root.info)) || !same(record.lockIdentity, identity(applicationLock.info))
      || !same(record.lock, lock) || !same(record.state, state)
      || owner.project !== project || owner.operationId === lock.operationId || owner.token === lock.token
      || record.predecessor !== null && !validDigest(record.predecessor)
      || !same(name === 'recovery-lock' ? record.guardIdentity : record.stagingIdentity, info)) {
      throw new Error('Cold restore lease does not match the original recovery evidence.');
    }
    for (const value of [record.guardIdentity, record.stagingIdentity]) {
      const fields = captureWorkerFields(value, ['dev', 'ino'], 'cold lease directory');
      if (!Object.values(fields).every(number => Number.isSafeInteger(number) && number >= 0)) {
        throw new Error('Invalid cold restore lease directory identity.');
      }
    }
    let receipt = null;
    if (hasReceipt) {
      const file = path.join(directory, 'files-restored.json');
      const receiptBytes = await read(file);
      if (!same(parse(receiptBytes), filesReceipt(record))) throw new Error('Cold restore file completion receipt changed.');
      receipt = { bytes: receiptBytes, info: identity(await lstat(file)) };
    }
    let intent = null;
    let ready = null;
    if (hasActivation) {
      if (!receipt) throw new Error('Cold activation intent requires restored-file evidence.');
      const intentBytes = await read(path.join(directory, 'activation-intent.json'));
      intent = captureColdActivationIntent(parse(intentBytes), { ...record, owner });
      if (hasReady) {
        ready = captureWorkerFields(parse(await read(path.join(directory, 'activation-ready.json'))),
          ['version', 'phase', 'owner', 'lock', 'backupId', 'snapshotSha256',
            'activationSha256', 'runtime', 'port', 'providers'], 'cold readiness receipt');
        if (ready.version !== 1 || ready.phase !== 'ready-to-commit'
          || !same(ready.owner, owner) || !same(ready.lock, lock)
          || ready.backupId !== record.backupId || ready.snapshotSha256 !== record.snapshotSha256
          || ready.activationSha256 !== digest(intentBytes)
          || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535
          || !Array.isArray(ready.providers) || !ready.providers.length
          || !ready.providers.every(provider => typeof provider === 'string')) {
          throw new Error('Cold readiness receipt does not match the activation intent.');
        }
      }
    }
    return { directory, info, record: { ...record, owner }, bytes, receipt, intent, ready };
  };
  const guard = await inspect('recovery-lock');
  const staging = await inspect('cold-restore-staging');
  if (staging) {
    if (staging.record) {
      if (!same(staging.record.guardIdentity, guard?.info ?? staging.info)
        || staging.record.predecessor !== (guard ? digest(guard.bytes) : null)) {
        throw new Error('Staged cold restore lease does not bind its predecessor.');
      }
    } else if (!guard || !same(guard.record.stagingIdentity, staging.info)
      || same(guard.record.guardIdentity, staging.info)) {
      throw new Error('Empty cold restore staging has no published ownership proof.');
    }
  }
  return { guard, staging };
}

export async function claimLinuxColdRestore({ control: suppliedControl, project, backup, acceptDataLoss, signal, expectedNative }) {
  const control = path.resolve(suppliedControl);
  const { admitLinuxColdRestore } = await import('./linux-cold-restore-admission.mjs');
  const admitted = await admitLinuxColdRestore({ control, project, backup, acceptDataLoss, signal, expectedNative });
  const stage = path.join(control, 'cold-restore-staging');
  const guard = path.join(control, 'recovery-lock');
  let guardHandle;
  let ownerHandle;
  let receiptHandle;
  let activationHandle;
  let activationIntent;
  let readyHandle;
  let readyReceipt;
  let activationAttempted = false;
  let receipt = admitted.lease.guard?.receipt ?? null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      ownerHandle?.close(), receiptHandle?.close(), activationHandle?.close(), readyHandle?.close(), guardHandle?.close(),
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    try { await admitted.close(); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Cold restore lease handle cleanup failed.');
  };
  try {
    await admitted.check();
    const prior = admitted.lease;
    if (prior.staging) {
      const current = await canonicalWorkerDirectory(stage, { privateMode: true });
      if (!same(identity(current.info), prior.staging.info)) throw new Error('Cold restore staging directory changed.');
      if (prior.staging.record) {
        const file = path.join(stage, 'owner.json');
        if (!(await readWorkerFile(file, 1024 * 1024, { privateMode: true })).equals(prior.staging.bytes)) {
          throw new Error('Staged cold restore owner changed.');
        }
        await unlink(file);
        await syncWorkerDirectory(stage);
      }
      await rmdir(stage);
      await syncWorkerDirectory(control);
    }
    await admitted.checkRecoverySources();
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Cannot establish cold restore controller identity.');
    const owner = captureLockOwner({
      version: 1, token: randomUUID(), operationId: randomUUID(), project,
      pid: process.pid, processIdentity: controllerIdentity, createdAt: new Date().toISOString(),
    });
    await mkdir(stage, { mode: 0o700 });
    const stagingIdentity = identity((await canonicalWorkerDirectory(stage, { privateMode: true })).info);
    const guardIdentity = prior.guard?.info ?? stagingIdentity;
    const record = {
      version: 1, project, backup: path.resolve(backup), backupId: admitted.snapshot.id,
      snapshotSha256: coldRestoreSnapshotDigest(admitted.snapshot),
      controlIdentity: identity((await canonicalWorkerDirectory(control, { privateMode: true })).info),
      lockIdentity: identity((await canonicalWorkerDirectory(path.join(control, 'lock'), { privateMode: true })).info),
      lock: admitted.lock, state: admitted.state, owner, guardIdentity, stagingIdentity,
      predecessor: prior.guard ? digest(prior.guard.bytes) : null,
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    await writeWorkerFile(path.join(stage, 'owner.json'), bytes);
    await syncWorkerDirectory(stage);
    await syncWorkerDirectory(control);
    await admitted.checkRecoverySources();
    if (!(await readWorkerFile(path.join(stage, 'owner.json'), 1024 * 1024, { privateMode: true })).equals(bytes)
      || !same(identity((await canonicalWorkerDirectory(stage, { privateMode: true })).info), stagingIdentity)) {
      throw new Error('Cold restore staged publication changed.');
    }
    if (prior.guard) {
      if (!same(identity((await canonicalWorkerDirectory(guard, { privateMode: true })).info), prior.guard.info)
        || !(await readWorkerFile(path.join(guard, 'owner.json'), 1024 * 1024, { privateMode: true })).equals(prior.guard.bytes)) {
        throw new Error('Previous cold restore lease changed.');
      }
      await rename(path.join(stage, 'owner.json'), path.join(guard, 'owner.json'));
      await syncWorkerDirectory(guard);
      if (!same(identity((await canonicalWorkerDirectory(stage, { privateMode: true })).info), stagingIdentity)) {
        throw new Error('Published cold restore staging directory changed.');
      }
      await rmdir(stage);
    } else {
      await rename(stage, guard);
    }
    await syncWorkerDirectory(control);
    const ownerPath = path.join(guard, 'owner.json');
    guardHandle = await open(guard, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    ownerHandle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const ownerIdentity = identity(await ownerHandle.stat());
    const checkAuthority = async ({ signal } = {}, verifyBackup = true, activating = false) => {
      if (closed) throw new Error('Cold restore lease is closed.');
      if (activating) await admitted.checkActivationEvidence({ signal });
      else if (verifyBackup) await admitted.checkRecoverySources({ signal });
      else await admitted.checkRecoveryStopped({ signal });
      if (owner.pid !== process.pid || await processIdentity(process.pid) !== owner.processIdentity
        || !same(identity((await canonicalWorkerDirectory(guard, { privateMode: true })).info), guardIdentity)
        || !same(identity(await guardHandle.stat()), guardIdentity)
        || (await ownerHandle.stat()).nlink !== 1 || !same(identity(await ownerHandle.stat()), ownerIdentity)
        || !same((await readdir(guard)).sort(),
          [...(activationIntent ? ['activation-intent.json'] : []), ...(readyReceipt ? ['activation-ready.json'] : []),
            ...(receipt ? ['files-restored.json'] : []), 'owner.json'])
        || !same(identity(await lstat(ownerPath)), ownerIdentity)
        || !(await readWorkerFile(ownerPath, 1024 * 1024, { privateMode: true })).equals(bytes)
        || (await readdir(control)).includes('cold-restore-staging')) {
        throw new Error('Current cold restore lease authority changed.');
      }
      if (receipt) {
        const file = path.join(guard, 'files-restored.json');
        if (!same(identity(await lstat(file)), receipt.info)
          || !(await readWorkerFile(file, 1024 * 1024, { privateMode: true })).equals(receipt.bytes)
          || receiptHandle && ((await receiptHandle.stat()).nlink !== 1
            || !same(identity(await receiptHandle.stat()), receipt.info))) {
          throw new Error('Cold restored-files receipt was replaced.');
        }
        if (activationIntent) {
          const file = path.join(guard, 'activation-intent.json');
          if ((await activationHandle.stat()).nlink !== 1
            || !same(identity(await activationHandle.stat()), activationIntent.info)
            || !same(identity(await lstat(file)), activationIntent.info)
            || !(await readWorkerFile(file, 1024 * 1024, { privateMode: true })).equals(activationIntent.bytes)) {
            throw new Error('Cold activation intent was replaced or changed.');
          }
        }
        if (readyReceipt) {
          const file = path.join(guard, 'activation-ready.json');
          if ((await readyHandle.stat()).nlink !== 1
            || !same(identity(await readyHandle.stat()), readyReceipt.info)
            || !same(identity(await lstat(file)), readyReceipt.info)
            || !(await readWorkerFile(file, 1024 * 1024, { privateMode: true })).equals(readyReceipt.bytes)) {
            throw new Error('Cold activation readiness receipt was replaced or changed.');
          }
        }
      }
    };
    const check = options => checkAuthority(options);
    await check();
    return Object.freeze({
      owner: Object.freeze(owner), lock: admitted.lock, state: admitted.state, snapshot: admitted.snapshot,
      service: admitted.service, providers: admitted.providers, authorizedPaths: admitted.authorizedPaths,
      check, close,
      async checkStopped(options) {
        if (activationAttempted) throw new Error('Cold activation already attempted; original stopped authority cannot be reused.');
        await checkAuthority(options, false);
        return Object.freeze({ stopped: true, inhibited: true });
      },
      async markFilesRestored(options) {
        await check(options);
        if (receipt) return;
        const file = path.join(guard, 'files-restored.json');
        const bytes = Buffer.from(`${JSON.stringify(filesReceipt(record))}\n`);
        await writeWorkerFile(file, bytes);
        await syncWorkerDirectory(guard);
        receiptHandle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        receipt = { bytes, info: identity(await receiptHandle.stat()) };
        await check(options);
      },
      async prepareActivation(options) {
        if (activationAttempted || !receipt) throw new Error('Cold activation requires restored files and unused authority.');
        await check(options);
        await admitted.armActivation(options);
        activationAttempted = true;
        const { version, state } = createColdActivationState({ ...record, targetCommit: admitted.snapshot.source.commit,
          runtimeIdentity: record.state.priorRuntime === 'stopped' ? admitted.service.runtimeIdentity
            : admitted.service.identity.runtime.invocationId });
        const file = path.join(guard, 'activation-intent.json');
        const bytes = Buffer.from(`${JSON.stringify({ version, owner, lock: admitted.lock, state })}\n`);
        await writeWorkerFile(file, bytes);
        await syncWorkerDirectory(guard);
        activationHandle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        activationIntent = { bytes, info: identity(await activationHandle.stat()) };
        const checkActivation = async (context = {}) => {
          await checkAuthority(context, false, true);
          return structuredClone(state);
        };
        await checkActivation(options);
        return Object.freeze({
          control, lock: admitted.lock, state: Object.freeze(state), check: checkActivation,
          async markReady({ runtime, port, providers, signal }) {
            if (readyReceipt || runtime?.runtime?.project !== project
              || runtime.runtime.unit !== admitted.service.identity.runtime.unit
              || !runtime.runtime.invocationId
              || runtime.runtime.invocationId === admitted.service.identity.runtime.invocationId
              || !Number.isInteger(port) || port < 1 || port > 65535
              || !Array.isArray(providers) || !providers.length
              || !same([...providers].sort(), [...admitted.providers].sort())) {
              throw new Error('Cold readiness requires the new verified generation and admitted providers.');
            }
            await checkActivation({ signal });
            const file = path.join(guard, 'activation-ready.json');
            const bytes = Buffer.from(`${JSON.stringify({
              version: 1, phase: 'ready-to-commit', owner, lock: admitted.lock,
              backupId: record.backupId, snapshotSha256: record.snapshotSha256,
              activationSha256: digest(activationIntent.bytes), runtime, port, providers,
            })}\n`);
            await writeWorkerFile(file, bytes);
            await syncWorkerDirectory(guard);
            readyHandle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            readyReceipt = { bytes, info: identity(await readyHandle.stat()) };
            await checkActivation({ signal });
          },
        });
      },
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold restore lease and authority cleanup failed.'); }
    throw error;
  }
}
