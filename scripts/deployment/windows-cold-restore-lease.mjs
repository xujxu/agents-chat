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
import { publishWindowsColdRestoreStaging, publishWindowsColdRestoreFilesReceipt, publishWindowsColdActivationIntent } from './windows-cold-restore-publication.mjs';
import { retireWindowsColdRestoreOwner } from './windows-cold-restore-retirement.mjs';
import { inspectWindowsColdConfiguration } from './windows-cold-restore-configuration.mjs';
import { createWindowsColdActivationIntent } from './windows-cold-activation-intent.mjs';
import { openWindowsColdActivation } from './windows-cold-activation.mjs';
import { waitWindowsReadiness } from './windows-readiness.mjs';
import { captureWindowsColdActivationHistory } from './windows-cold-activation-history.mjs';
import { windowsColdCompletionPhases } from './windows-cold-runtime-completion.mjs';

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

async function inspectLease(control, expected, configurationSha256, targetCommit, activationTaskName,
  policyRecovery = false, completionHistory = false) {
  if (![false, true, 'released-prefix'].includes(completionHistory)) throw new Error('Unsupported cold completion inventory mode.');
  if (completionHistory && (policyRecovery || activationTaskName === undefined)) {
    throw new Error('Cold completion observation conflicts with inactive recovery.');
  }
  const inspect = async name => {
    const directory = path.join(control, name);
    try { await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const identity = await directoryIdentity(directory);
    const names = (await readdir(directory)).sort();
    if (name === 'cold-restore-staging' && !names.length) return { directory, identity, record: null, bytes: null };
    const hasReceipt = name === 'recovery-lock' && names.includes('files-restored.json');
    const hasIntent = hasReceipt && names.includes('activation-intent.json');
    const phases = activationTaskName !== undefined && hasIntent
      ? ['start-requested', 'running', 'stopped'].filter(phase => names.includes(`activation-${phase}.json`)) : [];
    const policyNames = policyRecovery && phases.length ? names.filter(name => /^policy-[0-9]{6}\.json$/.test(name)) : [];
    let completionPhases = completionHistory && hasIntent ? [...windowsColdCompletionPhases] : [];
    if (completionHistory === 'released-prefix') {
      const missing = completionPhases.findIndex(phase => !names.includes(`completion-${phase}.json`));
      if (missing !== -1) completionPhases = completionPhases.slice(0, missing);
      if (completionPhases.length < 4) throw new Error('Cold completion recovery requires at least release intent.');
    }
    const completionNames = completionPhases.map(phase => `completion-${phase}.json`);
    if (!same(names, [...(hasIntent ? ['activation-intent.json'] : []),
      ...(hasReceipt ? ['files-restored.json'] : []), 'owner.json',
      ...phases.map(phase => `activation-${phase}.json`), ...policyNames, ...completionNames].sort())
      || completionHistory && name === 'recovery-lock' && !same(phases, ['start-requested', 'running'])) {
      throw new Error('Cold restore lease contains incomplete or foreign evidence.');
    }
    if (policyNames.length > 256) throw new Error('Cold policy recovery exceeds its record budget.');
    const policyRecords = [];
    let policyBytes = 0;
    for (const name of policyNames) {
      if (name !== `policy-${String(policyRecords.length + 1).padStart(6, '0')}.json`) {
        throw new Error('Cold policy recovery sequence is incomplete.');
      }
      const bytes = await readWorkerFile(path.join(directory, name), 4194304, { privateMode: true });
      policyBytes += bytes.length;
      if (policyBytes > 16777216) throw new Error('Cold policy recovery exceeds its total byte budget.');
      policyRecords.push(bytes);
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
    let intent = null;
    if (hasIntent) {
      const intentBytes = await readWorkerFile(path.join(directory, 'activation-intent.json'), 65536, { privateMode: true });
      const intentRecord = parse(intentBytes);
      if (!same(intentRecord, createWindowsColdActivationIntent(record, bytes, receipt, targetCommit))) {
        throw new Error('Cold activation intent differs from original owner, completion receipt or snapshot.');
      }
      intent = { record: intentRecord, bytes: intentBytes };
    }
    const history = phases.length ? captureWindowsColdActivationHistory({
      intent: intent.record, intentBytes: intent.bytes, taskName: activationTaskName,
      records: await Promise.all(phases.map(phase =>
        readWorkerFile(path.join(directory, `activation-${phase}.json`), 4194304, { privateMode: true }))),
    }) : null;
    return { directory, identity, record: { ...record, owner }, bytes, receipt, intent, history,
      ...(policyRecovery ? { policyRecords } : {}), ...(completionHistory ? { completionPhases } : {}) };
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

export { inspectLease as inspectWindowsColdRestoreEvidence, directoryIdentity as windowsColdDirectoryIdentity };

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
  let active;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors = [];
    try { await active?.close(); } catch (error) { errors.push(error); }
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
    const targetCommit = originalSnapshot.source.commit;
    const prior = await inspectLease(control, expected, configurationSha256, targetCommit);
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
    if (prior.guard?.intent) {
      const file = path.join(guard, 'activation-intent.json');
      if (!same(await directoryIdentity(guard), prior.guard.identity)
        || !(await readWorkerFile(path.join(guard, 'owner.json'), 65536, { privateMode: true })).equals(prior.guard.bytes)
        || !(await readWorkerFile(file, 65536, { privateMode: true })).equals(prior.guard.intent.bytes)) {
        throw new Error('Unused cold activation intent changed before takeover.');
      }
      await unlink(file);
    }
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
    let activationIntent = null;
    let retired = false;
    const configurations = new WeakSet();
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
      const current = await inspectLease(control, expected, configurationSha256, targetCommit);
      if (current.staging || !current.guard || !same(current.guard.record, record)
        || !current.guard.bytes.equals(bytes) || !same(current.guard.receipt, receipt)
        || !same(current.guard.intent, activationIntent)
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
    const checkUnused = async ({ signal: checkSignal = signal } = {}) => {
      checkSignal?.throwIfAborted();
      if (closed) throw new Error('Cold restore lease is closed.');
      if (activationIntent) throw new Error('Cold activation is already prepared; original file authority is consumed.');
      return check({ signal: checkSignal });
    };
    await check();
    const lease = Object.freeze({
      owner: Object.freeze({ ...owner }), lock: Object.freeze({ ...lock }), state: Object.freeze({ ...state }),
      snapshot: structuredClone(originalSnapshot), providers: admitted.providers, authorizedPaths: admitted.authorizedPaths,
      backup, pwsh, admissionIdentity: admission.identity, check: checkUnused, close,
      async checkStopped(options) {
        if (closed) throw new Error('Cold restore lease is closed.');
        if (activationIntent) throw new Error('Cold activation is already prepared; original file authority is consumed.');
        return checkStopped(options);
      },
      get identity() {
        if (!proof) throw new Error('Cold restore native proof is unavailable during publication.');
        return proof.identity;
      },
      async inspectRestoredConfiguration({ signal: checkSignal = signal } = {}) {
        checkSignal?.throwIfAborted();
        await checkUnused({ signal: checkSignal });
        if (!receipt) throw new Error('Cold configuration inspection requires completed file restoration by the current owner.');
        const configuration = await inspectWindowsColdConfiguration({
          project, backup, runtimeBundle: receipt.record.runtimeBundle, snapshot: originalSnapshot,
          providers: admitted.providers, profile: admitted.configurationProfile, pwsh, signal: checkSignal,
          recheck: () => check({ signal: checkSignal }),
        });
        configurations.add(configuration);
        return configuration;
      },
      async retireRuntime({ signal: checkSignal = signal } = {}) {
        checkSignal?.throwIfAborted();
        await checkUnused({ signal: checkSignal });
        if (!receipt) throw new Error('Cold runtime retirement requires completed file restoration by the current owner.');
        publishing = true;
        try {
          await proof.close();
          proof = null;
          await retireWindowsColdRestoreOwner({
            control, pwsh, admission, ownerSha256: digest(bytes), receiptSha256: digest(receipt.bytes), signal: checkSignal,
          });
          await open(checkSignal);
          if (!same(admitted.snapshot, originalSnapshot)) throw new Error('Cold runtime retirement backup changed.');
          publishing = false;
          await check({ signal: checkSignal });
          retired = true;
          return Object.freeze({ retired: true, inhibited: true, operationId: owner.operationId });
        } catch (error) {
          poisoned = true;
          throw error;
        } finally { publishing = false; }
      },
      async markFilesRestored({ runtimeBundle, signal: checkSignal = signal }) {
        await checkUnused({ signal: checkSignal });
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
      async prepareActivation({ configuration, signal: checkSignal = signal } = {}) {
        await checkUnused({ signal: checkSignal });
        if (!receipt || !retired) {
          throw new Error('Cold activation requires completed file restoration and original runtime retirement.');
        }
        if (!configurations.has(configuration)) throw new Error('Cold activation requires its original retained configuration.');
        await configuration.checkFiles({ signal: checkSignal });
        const intent = createWindowsColdActivationIntent(record, bytes, receipt, targetCommit);
        publishing = true;
        try {
          await proof.close();
          proof = null;
          activationIntent = await publishWindowsColdActivationIntent({
            control, pwsh, admission, signal: checkSignal,
            async makeRecord() {
              if (!same(await directoryIdentity(guard), record.guardIdentity)
                || !(await readWorkerFile(path.join(guard, 'owner.json'), 65536, { privateMode: true })).equals(bytes)
                || !(await readWorkerFile(path.join(guard, 'files-restored.json'), 65536, { privateMode: true })).equals(receipt.bytes)) {
                throw new Error('Cold activation owner or completion receipt changed before intent publication.');
              }
              await configuration.checkFiles({ signal: checkSignal });
              return intent;
            },
          });
          await open(checkSignal);
          if (!same(admitted.snapshot, originalSnapshot)) throw new Error('Cold activation backup changed during intent publication.');
          publishing = false;
          let startAttempted = false;
          const checkIntent = async ({ signal: intentSignal = signal } = {}) => {
            intentSignal?.throwIfAborted();
            if (closed) throw new Error('Cold restore lease is closed.');
            if (publishing || poisoned) throw new Error('Cold activation is unavailable or uncertain.');
            if (active) await active.check({ signal: intentSignal });
            else await check({ signal: intentSignal });
            await configuration.checkFiles({ signal: intentSignal });
            return structuredClone(intent.state);
          };
          await checkIntent({ signal: checkSignal });
          return Object.freeze({
            state: Object.freeze(structuredClone(intent.state)), check: checkIntent,
            async waitReady({ port, waitSeconds = 120, signal: readySignal = signal } = {}) {
              readySignal?.throwIfAborted();
              if (!active || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
                throw new Error('Cold readiness requires a started runtime and valid port.');
              }
              await checkIntent({ signal: readySignal });
              return waitWindowsReadiness({
                context: {
                  listener: async options => {
                    await checkIntent({ signal: options.signal });
                    return active.listener(options);
                  },
                  check: checkIntent,
                },
                port, providers: configuration.providers, waitSeconds, signal: readySignal,
              });
            },
            async start({ signal: startSignal = signal } = {}) {
              startSignal?.throwIfAborted();
              if (startAttempted) throw new Error('Cold guarded runtime is already started or startup was attempted.');
              await checkIntent({ signal: startSignal });
              startAttempted = true;
              publishing = true;
              try {
                const taskName = proof.observation.taskName;
                await proof.close();
                proof = null;
                active = await openWindowsColdActivation({
                  control, pwsh, admission, ownerSha256: digest(bytes), receiptSha256: digest(receipt.bytes),
                  intentSha256: digest(activationIntent.bytes), taskName, runtimeBundle: receipt.record.runtimeBundle,
                  originalGeneration: state.runtimeIdentity, signal: startSignal,
                });
                await configuration.checkFiles({ signal: startSignal });
                const running = await active.start({ signal: startSignal });
                publishing = false;
                await checkIntent({ signal: startSignal });
                return running;
              } catch (error) {
                poisoned = true;
                throw error;
              } finally { publishing = false; }
            },
            async completeRuntime({ port, waitSeconds = 120, onProgress, signal: completionSignal = signal } = {}) {
              completionSignal?.throwIfAborted();
              if (onProgress !== undefined && typeof onProgress !== 'function') {
                throw new TypeError('Cold completion progress callback must be a function.');
              }
              if (!active) throw new Error('Cold completion requires its original started runtime.');
              await checkIntent({ signal: completionSignal });
              await waitWindowsReadiness({
                context: { listener: options => active.listener(options), check: checkIntent },
                port, providers: configuration.providers, waitSeconds, signal: completionSignal,
              });
              publishing = true;
              try {
                const result = await active.completeRuntime({
                  port, providers: configuration.providers, signal: completionSignal, onProgress,
                });
                publishing = false;
                await checkIntent({ signal: completionSignal });
                return result;
              } catch (error) {
                poisoned = true;
                throw error;
              } finally { publishing = false; }
            },
          });
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
