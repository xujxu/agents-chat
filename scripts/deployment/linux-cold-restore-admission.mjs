import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { acquireRecoveryAdmission } from './linux-recovery-admission.mjs';
import { inspectLinuxColdService } from './linux-cold-service.mjs';
import { inspectLinuxRestoreConfiguration } from './linux-configuration.mjs';
import { validateLinuxRestoreSnapshot } from './linux-restore-compatibility.mjs';
import { captureLockOwner, completedDeploymentPhase, loadState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { readEvidenceJournal } from './evidence-journal.mjs';
import { retainActivationWorkers } from './service-activation-workers.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { coldRestoreLeaseNames, coldRestoreSnapshotDigest, inspectColdRestoreLease } from './linux-cold-restore-lease.mjs';

const identity = info => ({ dev: info.dev, ino: info.ino });
const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const stopPhases = ['intent', 'inhibited', 'stop-requested', 'stopped'];
const activationPhases = ['intent', 'staged', 'uninhibited', 'start-requested', 'started',
  'activation-stop-intent', 'activation-stop-inhibited', 'activation-stop-requested', 'activation-stopped'];

export async function admitLinuxColdRestore({ control, project, backup, acceptDataLoss, signal }) {
  if (acceptDataLoss !== true) throw new Error('Cold restore requires explicit data-loss acknowledgement.');
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Cold restore admission requires Linux root.');
  signal?.throwIfAborted();
  const admission = await acquireRecoveryAdmission(control);
  const retained = [];
  let service;
  let workers;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([service?.close(), workers?.close(), ...retained.map(entry => entry.handle.close())]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    try { await admission.close(); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Cold restore admission cleanup failed.');
  };
  try {
    const { root } = await externalWorkerDirectory(control, project);
    const lockDirectory = path.join(root, 'lock');
    const directory = await canonicalWorkerDirectory(lockDirectory, { privateMode: true });
    const retain = async (file, maximum = 1024 * 1024) => {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const entry = { file, handle, maximum, info: identity(await handle.stat()) };
      retained.push(entry);
      entry.bytes = await readWorkerFile(file, maximum, { privateMode: true });
      if (!same(identity(await lstat(file)), entry.info)) throw new Error('Cold restore evidence was replaced during admission.');
      return entry.bytes;
    };
    const lock = captureLockOwner(parse(await retain(path.join(lockDirectory, 'owner.json'), 65536)));
    if (lock.project !== project) throw new Error('Cold restore lock belongs to another project.');
    const deadOwner = async () => {
      if (await processIdentity(lock.pid) === lock.processIdentity) throw new Error('Original cold restore owner is still alive.');
    };
    await deadOwner();
    await retain(path.join(root, 'state.json'), 65536);
    const state = await loadState(root);
    if (!state || state.project !== project || state.operationId !== lock.operationId || state.priorRuntime !== 'running'
      || completedDeploymentPhase(state.phase) || ['preflight', 'restore-preflight'].includes(state.phase)) {
      throw new Error('Cold restore requires matching incomplete stopped-operation state.');
    }
    const names = await readdir(root);
    if (names.some(name => ['live-retirement.json', 'service-retirement.json', 'worker-retirement.json'].includes(name))) {
      throw new Error('Existing recovery or retirement authority requires its own recovery path.');
    }
    const lease = await inspectColdRestoreLease({ control: root, project, backup, lock, state, retain });
    for (const slot of [lease.guard, lease.staging]) {
      if (slot?.record && await processIdentity(slot.record.owner.pid) === slot.record.owner.processIdentity) {
        throw new Error('The previous cold restore lease owner is still alive.');
      }
    }
    const serviceFiles = names.filter(name => name.startsWith('service-')).sort();
    const activated = serviceFiles.includes('service-activation.ndjson');
    if (!same(serviceFiles, [...(activated ? ['service-activation.ndjson'] : []), 'service-stop.ndjson'])) {
      throw new Error('Cold restore service evidence inventory is incomplete or foreign.');
    }
    await retain(path.join(root, 'service-stop.ndjson'), 256 * 1024);
    const stops = await readEvidenceJournal({
      root, project, name: 'service-stop.ndjson', maximumBytes: 256 * 1024, maximumRecords: 4,
      validate(value, records) {
        const { phase, ...base } = captureWorkerFields(value, ['version', 'lock', 'service', 'inhibition', 'phase'], 'cold stop receipt');
        if (base.version !== 1 || !same(base.lock, lock) || phase !== stopPhases[records.length]
          || base.service?.runtime?.project !== project
          || base.inhibition !== `/etc/systemd/system/${base.service?.runtime?.unit}.d/90-agents-chat-deployment.conf`
          || records.length && !same(base, {
            version: records[0].version, lock, service: records[0].service, inhibition: records[0].inhibition,
          })) throw new Error('Cold restore stop evidence does not bind the original lock and service.');
        return value;
      },
    });
    if (stops.length !== stopPhases.length) throw new Error('Cold restore requires a complete original stop receipt.');
    let original = stops[0].service;
    let held = null;
    if (activated) {
      await retain(path.join(root, 'service-activation.ndjson'));
      const records = await readEvidenceJournal({
        root, project, name: 'service-activation.ndjson', maximumBytes: 1024 * 1024, maximumRecords: 9,
        validate(value, records) {
          const fields = captureWorkerFields(value,
            ['version', 'lock', 'prior', 'purpose', 'state', 'inhibition', 'held', 'phase', 'started'], 'cold activation receipt');
          const { phase, started, ...base } = fields;
          const prior = records[0];
          if (base.version !== 1 || !same(base.lock, lock) || !same(base.prior, stops[0].service)
            || base.inhibition !== stops[0].inhibition || base.held !== `${base.inhibition}.${lock.token}.held`
            || !['deployment', 'prior-runtime', 'restore'].includes(base.purpose)
            || base.state?.operationId !== lock.operationId || base.state?.project !== project
            || Object.keys(state).filter(key => !['phase', 'previousPhase', 'updatedAt', 'errorCode'].includes(key))
              .some(key => !same(state[key], base.state[key]))
            || phase !== activationPhases[records.length]
            || (records.length < 4 ? started !== null : !started)
            || records.length > 4 && !same(started, records[4].started)
            || prior && !same(base, Object.fromEntries(Object.entries(prior).filter(([key]) => !['phase', 'started'].includes(key))))) {
            throw new Error('Cold restore activation evidence is incomplete or changed.');
          }
          return fields;
        },
      });
      if (records.length !== activationPhases.length) throw new Error('Interrupted activation stop must settle before cold restoration.');
      original = records.at(-1).started;
      held = records.at(-1).held;
    }
    workers = await retainActivationWorkers(root, lock);
    service = await inspectLinuxColdService({ original, held });
    const saved = (await canonicalWorkerDirectory(backup, { privateMode: true })).root;
    if (inside(project, saved) || inside(saved, project)) throw new Error('Cold restore backup must be outside the installed project.');
    const snapshot = await verifySnapshot(saved, { signal });
    for (const slot of [lease.guard, lease.staging]) {
      if (slot?.record && (slot.record.backupId !== snapshot.id
        || slot.record.snapshotSha256 !== coldRestoreSnapshotDigest(snapshot))) {
        throw new Error('Cold restore lease backup changed.');
      }
    }
    const config = await inspectLinuxRestoreConfiguration({
      service, backup: saved, snapshot, profile: 'agents-chat-auth-638c553', signal,
    });
    const authorizedPaths = [...new Set([...service.identity.sources.map(source => source.path),
      ...config.sourcePaths.filter(file => !inside(project, file))])].sort();
    validateLinuxRestoreSnapshot({ identity: service.identity, manifest: snapshot, authorizedPaths });
    let activationArmed = false;
    const checkEvidence = async ({ signal: checkSignal = signal } = {}, recoverySources = false, verifyBackup = true, activating = false) => {
      if (closed) throw new Error('Cold restore admission is closed.');
      checkSignal?.throwIfAborted();
      await admission.check();
      await deadOwner();
      if (activating && !activationArmed) throw new Error('Cold activation authority is not armed.');
      const inventory = entries => entries.filter(name => (!recoverySources || !coldRestoreLeaseNames.includes(name))
        && (!activating || name !== 'service-activation.ndjson')).sort();
      if (!same(identity((await canonicalWorkerDirectory(lockDirectory, { privateMode: true })).info), identity(directory.info))
        || !same(inventory(await readdir(root)), inventory([...names]))) throw new Error('Cold restore authority inventory changed.');
      for (const entry of retained) {
        if (recoverySources && (path.dirname(entry.file) === path.join(root, 'cold-restore-staging')
          || entry.file === path.join(root, 'recovery-lock', 'owner.json'))) continue;
        const info = await entry.handle.stat();
        if (info.nlink !== 1 || !same(identity(info), entry.info) || !same(identity(await lstat(entry.file)), entry.info)
          || !(await readWorkerFile(entry.file, entry.maximum, { privateMode: true })).equals(entry.bytes)) {
          throw new Error('Retained cold restore evidence changed.');
        }
      }
      if (!recoverySources) await inspectColdRestoreLease({ control: root, project, backup, lock, state });
      await workers.check();
      if (!activating) await service.check();
      if (verifyBackup) {
        await config.check({ signal: checkSignal });
        if (!same(await verifySnapshot(saved, { signal: checkSignal }), snapshot)) throw new Error('Admitted cold restore backup changed.');
      }
      checkSignal?.throwIfAborted();
    };
    const check = options => checkEvidence(options);
    await check();
    return Object.freeze({
      lock: structuredClone(lock), state: structuredClone(state), snapshot: structuredClone(snapshot),
      service, providers: config.providers, authorizedPaths: Object.freeze(authorizedPaths), lease, check, close,
      checkRecoverySources: options => checkEvidence(options, true),
      checkRecoveryStopped: options => checkEvidence(options, true, false),
      async armActivation(options) {
        if (activationArmed || activated) throw new Error('Existing activation requires explicit recovery before another activation.');
        await checkEvidence(options, true);
        activationArmed = true;
      },
      checkActivationEvidence: options => checkEvidence(options, true, false, true),
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold restore admission and cleanup failed.'); }
    throw error;
  }
}
