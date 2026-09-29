import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectLinuxColdActivation } from './linux-cold-activation-recovery.mjs';
import { inspectColdRestoreLease, coldRestoreSnapshotDigest } from './linux-cold-restore-lease.mjs';
import { acquireRecoveryAdmission } from './linux-recovery-admission.mjs';
import { retainActivationWorkers } from './service-activation-workers.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { inspectLinuxConfiguration, inspectLinuxRestoredConfiguration } from './linux-configuration.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureLockOwner, loadState } from './state.mjs';
import { canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { waitLinuxReadiness } from './linux-readiness.mjs';
import { runStage } from './stage-runner.mjs';
import { assertColdRestoreNative } from './linux-restore-compatibility.mjs';
import {
  captureColdRetirementEntries, coldCompletionMarker, coldDigest, coldFileDescriptor,
  coldIdentity, coldParse, coldRetirementMarker, coldSerialize, coldStateStage, parseColdRetirement,
} from './linux-cold-retirement-proof.mjs';

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function captureProof({ control, project, backup, restored, active, waitSeconds, timeoutSeconds, signal, expectedNative }) {
  let admitted;
  let workers;
  const errors = [];
  try {
    if (active || restored) {
      if (!active || !restored || active.status !== 'ready-to-commit' || restored.status !== 'files-restored') {
        throw new Error('Cold completion requires both retained restoration and activation authorities.');
      }
      admitted = active;
    } else {
      admitted = await inspectLinuxColdActivation({ control, project, backup, waitSeconds, timeoutSeconds, signal });
    }
    await admitted.check({ signal });
    assertColdRestoreNative(admitted.identity, expectedNative);
    const lock = captureLockOwner(coldParse(await readWorkerFile(path.join(control, 'lock/owner.json'), 65536, { privateMode: true })));
    const oldState = await loadState(control);
    const lease = await inspectColdRestoreLease({ control, project, backup, lock, state: oldState, activation: true });
    if (lease.staging || !lease.guard?.intent || !lease.guard.ready || !same(lease.guard.ready.runtime, admitted.identity)) {
      throw new Error('Cold terminal admission does not match readiness evidence.');
    }
    if (restored && (!same(restored.owner, lease.guard.record.owner) || !same(restored.lock, lock)
      || lease.guard.record.owner.pid !== process.pid
      || await processIdentity(process.pid) !== lease.guard.record.owner.processIdentity)) {
      throw new Error('Cold completion requires the retained recovery owner.');
    }
    const { runtime } = admitted.identity;
    const held = `/etc/systemd/system/${runtime.unit}.d/90-agents-chat-deployment.conf.${lock.token}.held`;
    workers = await retainActivationWorkers(control, lock);
    const inventory = await workers.retirementInventory();
    const names = (await readdir(control)).sort();
    if (names.some(name => [coldRetirementMarker, coldCompletionMarker, coldStateStage].includes(name))) {
      throw new Error('Existing cold completion proof requires explicit completion reentry.');
    }
    const proof = {
      version: 1, project, backup: path.resolve(backup),
      root: coldIdentity((await canonicalWorkerDirectory(control, { privateMode: true })).info),
      names, lock, lease: lease.guard.record, intent: lease.guard.intent, ready: lease.guard.ready,
      oldState, oldStateFile: await coldFileDescriptor(path.join(control, 'state.json')),
      state: { ...lease.guard.intent.state, phase: 'restored', previousPhase: 'restore-activating', updatedAt: new Date().toISOString() },
      workers: inventory, entries: await captureColdRetirementEntries(control, held, inventory),
    };
    const bytes = coldSerialize(proof);
    parseColdRetirement(bytes, control, project, backup);
    await admitted.check({ signal });
    await workers.check();
    await writeWorkerFile(path.join(control, coldRetirementMarker), bytes);
    await syncWorkerDirectory(control);
  } catch (error) { errors.push(error); }
  finally {
    const results = await Promise.allSettled([workers?.close(), admitted?.close(), restored?.close()]);
    errors.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Cold terminal authority handoff and cleanup failed.');
}

export async function completeLinuxColdRestore(options) {
  const { control, project, backup, active, restored, waitSeconds = 120, timeoutSeconds = 1800, signal, expectedNative } = options;
  if (process.platform !== 'linux' || process.getuid() !== 0
    || ![waitSeconds, timeoutSeconds].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Cold completion requires Linux root and positive deadlines.');
  }
  await externalWorkerDirectory(control, project);
  return runStage('cold-restore-completion', async stageSignal => {
    const marker = path.join(control, coldRetirementMarker);
    const completed = path.join(control, coldCompletionMarker);
    if (!await exists(marker) && !await exists(completed)) {
      await captureProof({ control, project, backup, active, restored, waitSeconds, timeoutSeconds, signal: stageSignal, expectedNative });
    } else if (active || restored) {
      throw new Error('Existing cold terminal evidence requires fresh recovery without live handles.');
    }
    const admission = await acquireRecoveryAdmission(control);
    try {
      return await finish({ control, project, backup, waitSeconds, signal: stageSignal, admission, expectedNative });
    } finally { await admission.close(); }
  }, { timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER), signal });
}

async function finish({ control, project, backup, waitSeconds, signal, admission, expectedNative }) {
  let service;
  try {
    const marker = path.join(control, coldRetirementMarker);
    const completed = path.join(control, coldCompletionMarker);
    let receipt = await exists(completed);
    if (receipt && await exists(marker)) throw new Error('Competing cold completion proofs.');
    let proofPath = receipt ? completed : marker;
    const proofBytes = await readWorkerFile(proofPath, 4 * 1024 * 1024, { privateMode: true });
    const proofIdentity = coldIdentity(await lstat(proofPath));
    const proof = parseColdRetirement(proofBytes, control, project, backup);
    assertColdRestoreNative(proof.ready.runtime, expectedNative);
    const statePath = path.join(control, 'state.json');
    const stagedPath = path.join(control, coldStateStage);
    const stateBytes = coldSerialize(proof.state);
    const checkFile = async entry => {
      const info = await lstat(entry.file);
      const bytes = await readWorkerFile(entry.file, 4 * 1024 * 1024, { privateMode: true });
      if (!same(coldIdentity(info), { dev: entry.dev, ino: entry.ino })
        || bytes.length !== entry.bytes || coldDigest(bytes) !== entry.sha256) {
        throw new Error('Cold retirement file identity or content changed.');
      }
    };
    const checkOwners = async () => {
      if (await processIdentity(proof.lock.pid) === proof.lock.processIdentity) {
        throw new Error('Original deployment controller is still alive.');
      }
      const owner = proof.lease.owner;
      if (await processIdentity(owner.pid) === owner.processIdentity && owner.pid !== process.pid) {
        throw new Error('Cold restore controller is still alive.');
      }
    };
    await checkOwners();
    const { runtime, executables } = proof.ready.runtime;
    service = await inspectLinuxService({ unit: runtime.unit, project, npm: executables[0].file, node: executables[1].file });
    if (!same(service.identity, proof.ready.runtime)) throw new Error('Cold restored runtime generation changed.');
    const snapshot = await verifySnapshot(backup, { signal });
    if (coldRestoreSnapshotDigest(snapshot) !== proof.ready.snapshotSha256 || snapshot.id !== proof.ready.backupId
      || snapshot.source.commit !== proof.state.targetCommit) throw new Error('Cold completion backup changed.');
    const profile = 'agents-chat-auth-638c553';
    const restored = await inspectLinuxRestoredConfiguration({ service, snapshot, profile, signal });
    const current = await inspectLinuxConfiguration({ service, profile, signal });
    if (!same([...current.providers].sort(), [...proof.ready.providers].sort())) throw new Error('Cold completion providers changed.');
    const remaining = new Set();
    let committed = false;
    const check = async () => {
      signal.throwIfAborted();
      await admission.check();
      await checkOwners();
      if (!same(coldIdentity((await canonicalWorkerDirectory(control, { privateMode: true })).info), proof.root)
        || !same(coldIdentity(await lstat(proofPath)), proofIdentity)
        || !(await readWorkerFile(proofPath, 4 * 1024 * 1024, { privateMode: true })).equals(proofBytes)) {
        throw new Error('Cold retirement proof authority changed.');
      }
      const observedState = await readWorkerFile(statePath, 65536, { privateMode: true });
      committed = observedState.equals(stateBytes);
      if (!committed) {
        await checkFile(proof.oldStateFile);
        if (!same(await loadState(control), proof.oldState)) throw new Error('Cold retirement original state changed.');
      } else if (!same(await loadState(control), proof.state)) throw new Error('Cold restored state changed.');
      const staged = await exists(stagedPath);
      if (staged && (committed || !(await readWorkerFile(stagedPath, 65536, { privateMode: true })).equals(stateBytes))) {
        throw new Error('Cold staged state is incomplete or foreign.');
      }
      remaining.clear();
      let found = false;
      for (const entry of proof.entries) {
        if (!await exists(entry.file)) {
          if (found || !committed) throw new Error('Gap or premature deletion in cold retirement sequence.');
          continue;
        }
        if (receipt) throw new Error('Cold completion evidence reappeared.');
        found = true;
        remaining.add(entry.file);
        if (entry.kind === 'file') await checkFile(entry);
        else {
          const { info } = await canonicalWorkerDirectory(entry.file, { privateMode: true });
          if (!same(coldIdentity(info), { dev: entry.dev, ino: entry.ino })) throw new Error('Cold retirement directory replaced.');
          const expected = [];
          for (const name of entry.names) if (await exists(path.join(entry.file, name))) expected.push(name);
          if (!same((await readdir(entry.file)).sort(), expected)) throw new Error('Cold retirement directory inventory changed.');
        }
      }
      const removed = proof.entries.filter(entry => !remaining.has(entry.file) && path.dirname(entry.file) === control)
        .map(entry => path.basename(entry.file));
      const expected = [...proof.names.filter(name => !removed.includes(name)), path.basename(proofPath),
        ...(staged ? [coldStateStage] : [])].sort();
      if (!same((await readdir(control)).sort(), expected)) throw new Error('Cold retirement root inventory changed.');
      await restored.check({ signal });
      await current.check({ signal });
      await service.check();
    };
    await check();
    await waitLinuxReadiness({ service, port: proof.ready.port, providers: current.providers, waitSeconds, signal });
    await check();
    if (!committed) {
      if (!await exists(stagedPath)) {
        await writeWorkerFile(stagedPath, stateBytes);
        await syncWorkerDirectory(control);
      }
      await check();
      await rename(stagedPath, statePath);
      await syncWorkerDirectory(control);
    }
    await check();
    for (const entry of proof.entries) {
      if (!remaining.has(entry.file)) continue;
      await check();
      if (entry.kind === 'directory') await rmdir(entry.file);
      else await unlink(entry.file);
      await syncWorkerDirectory(path.dirname(entry.file));
    }
    await check();
    if (!receipt) {
      await rename(marker, completed);
      await syncWorkerDirectory(control);
      proofPath = completed;
      receipt = true;
      await check();
    }
    return { status: 'restored', backupId: proof.ready.backupId, operationId: proof.lock.operationId };
  } finally { await service?.close(); }
}
