import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { acquireWindowsAdmission, assertWindowsAdmission } from './windows-admission.mjs';
import { openWindowsStoppedRestoreProof } from './windows-stopped-restore-proof.mjs';
import { inspectWindowsStoppedRestoreSnapshot } from './windows-stopped-restore-snapshot.mjs';
import { captureLockOwner } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { canonicalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { publishWindowsColdRestoreStaging, publishWindowsColdRestoreFilesReceipt } from './windows-cold-restore-publication.mjs';

const leases = new WeakMap();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const filesReceipt = (control, record, bytes, configurationSha256) => {
  const directory = path.join(control, `runtime-${record.owner.operationId}`);
  return {
    version: 1, phase: 'files-restored', ownerSha256: digest(bytes),
    operationId: record.lock.operationId, backupId: record.backupId,
    snapshotSha256: record.snapshotSha256, stateSha256: record.stateSha256,
    runtimeBundle: { directory, configuration: path.join(directory, 'configuration.json'), sha256: configurationSha256 },
  };
};
async function directoryIdentity(directory) {
  await canonicalWorkerDirectory(directory, { privateMode: true });
  const info = await lstat(directory, { bigint: true });
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

async function inspectLease(control, expected, configurationSha256) {
  const inspect = async name => {
    const directory = path.join(control, name);
    try { await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const identity = await directoryIdentity(directory);
    const names = (await readdir(directory)).sort();
    if (name === 'cold-restore-staging' && !names.length) return { directory, identity, record: null, bytes: null };
    const hasReceipt = name === 'recovery-lock' && names.includes('files-restored.json');
    if (!same(names, [...(hasReceipt ? ['files-restored.json'] : []), 'owner.json'])) {
      throw new Error('Cold restore lease contains incomplete or foreign evidence.');
    }
    const bytes = await readWorkerFile(path.join(directory, 'owner.json'), 65536, { privateMode: true });
    const record = captureWorkerFields(parse(bytes),
      [...Object.keys(expected), 'owner', 'guardIdentity', 'stagingIdentity', 'predecessor'], 'Windows cold restore lease');
    for (const key of Object.keys(expected)) {
      if (!same(record[key], expected[key])) throw new Error('Cold restore lease differs from original recovery evidence.');
    }
    const owner = captureLockOwner(record.owner);
    if (owner.project !== expected.project || owner.operationId === expected.lock.operationId
      || owner.token === expected.lock.token || record.predecessor !== null && !validDigest(record.predecessor)) {
      throw new Error('Cold restore requires a distinct recovery owner and bound predecessor.');
    }
    for (const value of [record.guardIdentity, record.stagingIdentity]) {
      const fields = captureWorkerFields(value, ['dev', 'ino'], 'cold restore directory identity');
      if (!Object.values(fields).every(part => typeof part === 'string' && /^[0-9]+$/.test(part))) {
        throw new Error('Invalid cold restore directory identity.');
      }
    }
    if (!same(name === 'recovery-lock' ? record.guardIdentity : record.stagingIdentity, identity)) {
      throw new Error('Original cold restore lease directory was replaced.');
    }
    let receipt = null;
    if (hasReceipt) {
      const receiptBytes = await readWorkerFile(path.join(directory, 'files-restored.json'), 65536, { privateMode: true });
      const receiptRecord = parse(receiptBytes);
      if (!same(receiptRecord, filesReceipt(control, record, bytes, configurationSha256))) {
        throw new Error('Cold restore completion receipt differs from original owner, archive or runtime.');
      }
      receipt = { record: receiptRecord, bytes: receiptBytes };
    }
    return { directory, identity, record: { ...record, owner }, bytes, receipt };
  };
  const guard = await inspect('recovery-lock');
  const staging = await inspect('cold-restore-staging');
  if (staging?.record) {
    if (!same(staging.record.guardIdentity, guard?.identity ?? staging.identity)
      || staging.record.predecessor !== (guard ? digest(guard.bytes) : null)) {
      throw new Error('Staged cold restore lease does not bind its predecessor.');
    }
  } else if (staging && (!guard || !same(guard.record.stagingIdentity, staging.identity)
    || same(guard.record.guardIdentity, staging.identity))) {
    throw new Error('Empty cold restore staging has no published ownership proof.');
  }
  return { guard, staging };
}

export async function assertWindowsColdRestoreLease(control, lease, options) {
  if (!leases.has(lease) || leases.get(lease) !== control) {
    throw new Error('Original Windows cold restore lease does not match control.');
  }
  return lease.check(options);
}

export async function claimWindowsColdRestore({
  control, project, backup, node, pwsh, profile, acceptDataLoss, signal,
}) {
  if (acceptDataLoss !== true) throw new Error('Cold restore requires explicit data-loss acknowledgement.');
  signal?.throwIfAborted();
  const admission = await acquireWindowsAdmission({ control, pwsh, signal });
  let proof;
  let admitted;
  let closed = false;
  let publishing = false;
  let poisoned = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors = [];
    try { await proof?.close(); } catch (error) { errors.push(error); }
    try { await admission.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Cold restore lease cleanup failed.');
  };
  const open = async (openSignal = signal) => {
    proof = await openWindowsStoppedRestoreProof({ control, pwsh, admission, recovery: true, signal: openSignal });
    admitted = await inspectWindowsStoppedRestoreSnapshot({
      control, project, backup, node, pwsh, profile, admission, proof, signal: openSignal,
    });
  };
  try {
    await open();
    const lock = captureLockOwner(parse(await readWorkerFile(path.join(control, 'lock', 'owner.json'),
      65536, { privateMode: true })));
    const stateBytes = await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
    const state = parse(stateBytes);
    const originalSnapshot = admitted.snapshot;
    const configurationSha256 = originalSnapshot.runtime.task.configurationSha256;
    const expected = {
      version: 1, project, backup, backupId: originalSnapshot.id,
      snapshotSha256: digest(Buffer.from(JSON.stringify(originalSnapshot))),
      recoveryEngine: originalSnapshot.recoveryEngine,
      controlIdentity: await directoryIdentity(control), lockIdentity: await directoryIdentity(path.join(control, 'lock')),
      lock, state, stateSha256: digest(stateBytes),
    };
    const prior = await inspectLease(control, expected, configurationSha256);
    for (const slot of [prior.guard, prior.staging]) {
      if (slot?.record && await processIdentity(slot.record.owner.pid) === slot.record.owner.processIdentity) {
        throw new Error('Previous cold restore lease owner is still alive.');
      }
    }
    await admitted.check({ signal });
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Original cold restore controller identity is unavailable.');
    const owner = captureLockOwner({
      version: 1, project, token: randomUUID(), operationId: randomUUID(), pid: process.pid,
      processIdentity: controllerIdentity, createdAt: new Date().toISOString(),
    });
    await assertWindowsAdmission(control, admission, { signal });
    await proof.close();
    proof = null;
    const stage = path.join(control, 'cold-restore-staging');
    const guard = path.join(control, 'recovery-lock');
    // Release only observer handles; the same named admission spans publication.
    if (prior.guard?.receipt) {
      const file = path.join(guard, 'files-restored.json');
      if (!same(await directoryIdentity(guard), prior.guard.identity)
        || !(await readWorkerFile(path.join(guard, 'owner.json'), 65536, { privateMode: true })).equals(prior.guard.bytes)
        || !(await readWorkerFile(file, 65536, { privateMode: true })).equals(prior.guard.receipt.bytes)) {
        throw new Error('Prior cold restore completion receipt changed before takeover.');
      }
      await unlink(file);
    }
    if (prior.staging) {
      if (!same(await directoryIdentity(stage), prior.staging.identity)) throw new Error('Cold staging directory changed.');
      if (prior.staging.record) {
        const file = path.join(stage, 'owner.json');
        if (!(await readWorkerFile(file, 65536, { privateMode: true })).equals(prior.staging.bytes)) {
          throw new Error('Original staged cold restore owner changed.');
        }
        await unlink(file);
      }
      await rmdir(stage);
    }
    await assertWindowsAdmission(control, admission, { signal });
    const { record, bytes } = await publishWindowsColdRestoreStaging({
      control, pwsh, admission, signal,
      async makeRecord() {
        const stagingIdentity = await directoryIdentity(stage);
        return {
          ...expected, owner, guardIdentity: prior.guard?.identity ?? stagingIdentity, stagingIdentity,
          predecessor: prior.guard ? digest(prior.guard.bytes) : null,
        };
      },
    });
    await assertWindowsAdmission(control, admission, { signal });
    if (prior.guard) {
      if (!same(await directoryIdentity(guard), prior.guard.identity)
        || !(await readWorkerFile(path.join(guard, 'owner.json'), 65536, { privateMode: true })).equals(prior.guard.bytes)) {
        throw new Error('Original cold restore predecessor changed before publication.');
      }
      await rename(path.join(stage, 'owner.json'), path.join(guard, 'owner.json'));
      await rmdir(stage);
    } else { await rename(stage, guard); }
    await open();
    if (!same(admitted.snapshot, originalSnapshot)) throw new Error('Cold restore backup changed during lease publication.');
    let receipt = null;
    const checkStopped = async ({ signal: checkSignal = signal } = {}) => {
      if (closed) throw new Error('Cold restore lease is closed.');
      if (publishing || poisoned) throw new Error('Cold restore lease publication is unavailable or uncertain.');
      await assertWindowsAdmission(control, admission, { signal: checkSignal });
      await proof.check({ signal: checkSignal });
      if (proof.observation.stateSha256 !== expected.stateSha256
        || !same(await directoryIdentity(control), expected.controlIdentity)
        || !same(await directoryIdentity(path.join(control, 'lock')), expected.lockIdentity)) {
        throw new Error('Original cold restore evidence changed during publication.');
      }
      const current = await inspectLease(control, expected, configurationSha256);
      if (current.staging || !current.guard || !same(current.guard.record, record)
        || !current.guard.bytes.equals(bytes) || !same(current.guard.receipt, receipt)
        || await processIdentity(owner.pid) !== owner.processIdentity) {
        throw new Error('Original cold restore recovery owner changed.');
      }
      await proof.check({ signal: checkSignal });
      return Object.freeze({ stopped: true, inhibited: true, operationId: owner.operationId });
    };
    const check = async ({ signal: checkSignal = signal } = {}) => {
      await checkStopped({ signal: checkSignal });
      await admitted.check({ signal: checkSignal });
      return checkStopped({ signal: checkSignal });
    };
    await check();
    const lease = Object.freeze({
      owner: Object.freeze({ ...owner }), lock: Object.freeze({ ...lock }), state: Object.freeze({ ...state }),
      snapshot: structuredClone(originalSnapshot), providers: admitted.providers, authorizedPaths: admitted.authorizedPaths,
      backup, pwsh, admissionIdentity: admission.identity, check, checkStopped, close,
      get identity() {
        if (!proof) throw new Error('Cold restore native proof is unavailable during publication.');
        return proof.identity;
      },
      async markFilesRestored({ runtimeBundle, signal: checkSignal = signal }) {
        await check({ signal: checkSignal });
        const expectedReceipt = filesReceipt(control, record, bytes, configurationSha256);
        if (!same(runtimeBundle, expectedReceipt.runtimeBundle)) {
          throw new Error('Cold file completion requires the original recovery owner runtime bundle.');
        }
        if (receipt) return;
        publishing = true;
        try {
          await proof.close();
          proof = null;
          receipt = await publishWindowsColdRestoreFilesReceipt({
            control, pwsh, admission, signal: checkSignal,
            async makeRecord() {
              if (!same(await directoryIdentity(guard), record.guardIdentity)
                || !(await readWorkerFile(path.join(guard, 'owner.json'), 65536, { privateMode: true })).equals(bytes)) {
                throw new Error('Cold file completion owner changed before publication.');
              }
              return expectedReceipt;
            },
          });
          await open(checkSignal);
          if (!same(admitted.snapshot, originalSnapshot)) throw new Error('Cold file completion backup changed.');
          publishing = false;
          await check({ signal: checkSignal });
        } catch (error) {
          poisoned = true;
          throw error;
        } finally { publishing = false; }
      },
    });
    leases.set(lease, control);
    return lease;
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold restore lease claim and cleanup failed.'); }
    throw error;
  }
}
