import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureLockOwner } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';

export const coldRestoreLeaseNames = Object.freeze(['recovery-lock', 'cold-restore-staging']);
const identity = info => ({ dev: info.dev, ino: info.ino });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const coldRestoreSnapshotDigest = snapshot => digest(Buffer.from(JSON.stringify(snapshot)));
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function inspectColdRestoreLease({ control, project, backup, lock, state, retain }) {
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
    if (!same(entries, ['owner.json'])) throw new Error('Cold restore lease contains incomplete or foreign evidence.');
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
    return { directory, info, record: { ...record, owner }, bytes };
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

export async function claimLinuxColdRestore({ control: suppliedControl, project, backup, acceptDataLoss, signal }) {
  const control = path.resolve(suppliedControl);
  const { admitLinuxColdRestore } = await import('./linux-cold-restore-admission.mjs');
  const admitted = await admitLinuxColdRestore({ control, project, backup, acceptDataLoss, signal });
  const stage = path.join(control, 'cold-restore-staging');
  const guard = path.join(control, 'recovery-lock');
  let guardHandle;
  let ownerHandle;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([ownerHandle?.close(), guardHandle?.close()]);
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
    const check = async ({ signal } = {}) => {
      if (closed) throw new Error('Cold restore lease is closed.');
      await admitted.checkRecoverySources({ signal });
      if (owner.pid !== process.pid || await processIdentity(process.pid) !== owner.processIdentity
        || !same(identity((await canonicalWorkerDirectory(guard, { privateMode: true })).info), guardIdentity)
        || !same(identity(await guardHandle.stat()), guardIdentity)
        || (await ownerHandle.stat()).nlink !== 1 || !same(identity(await ownerHandle.stat()), ownerIdentity)
        || !same((await readdir(guard)).sort(), ['owner.json'])
        || !same(identity(await lstat(ownerPath)), ownerIdentity)
        || !(await readWorkerFile(ownerPath, 1024 * 1024, { privateMode: true })).equals(bytes)
        || (await readdir(control)).includes('cold-restore-staging')) {
        throw new Error('Current cold restore lease authority changed.');
      }
    };
    await check();
    return Object.freeze({
      owner: Object.freeze(owner), lock: admitted.lock, state: admitted.state, snapshot: admitted.snapshot,
      service: admitted.service, providers: admitted.providers, authorizedPaths: admitted.authorizedPaths,
      check, close,
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold restore lease and authority cleanup failed.'); }
    throw error;
  }
}
