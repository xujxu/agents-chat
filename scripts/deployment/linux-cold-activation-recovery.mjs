import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { acquireRecoveryAdmission } from './linux-recovery-admission.mjs';
import { inspectColdRestoreLease, coldRestoreSnapshotDigest } from './linux-cold-restore-lease.mjs';
import { captureLockOwner, completedDeploymentPhase, loadState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { readEvidenceJournal } from './evidence-journal.mjs';
import { readLinuxServiceStopEvidence } from './linux-service-stop-evidence.mjs';
import { linuxInactiveObservationId } from './linux-inactive-service.mjs';
import { retainActivationWorkers } from './service-activation-workers.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { inspectLinuxConfiguration, inspectLinuxRestoredConfiguration, inspectLinuxRestoreConfiguration } from './linux-configuration.mjs';
import { validateLinuxRestoreSnapshot } from './linux-restore-compatibility.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { waitLinuxReadiness } from './linux-readiness.mjs';
import { runStage } from './stage-runner.mjs';

const identity = info => ({ dev: info.dev, ino: info.ino });
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);
const activationPhases = ['intent', 'staged', 'uninhibited', 'start-requested', 'started'];

export async function inspectLinuxColdActivation({ control, project, backup, waitSeconds = 120, timeoutSeconds = 1800, signal }) {
  if (process.platform !== 'linux' || process.getuid() !== 0
    || ![waitSeconds, timeoutSeconds].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Cold activation recovery requires Linux root and positive deadlines.');
  }
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
    if (errors.length) throw new AggregateError(errors, 'Cold activation recovery handle cleanup failed.');
  };
  try {
    return await runStage('cold-activation-recovery', async stageSignal => {
      const { root } = await externalWorkerDirectory(control, project);
      const retain = async (file, maximum = 1024 * 1024) => {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const entry = { file, handle, maximum, info: identity(await handle.stat()) };
        retained.push(entry);
        entry.bytes = await readWorkerFile(file, maximum, { privateMode: true });
        if (!same(identity(await lstat(file)), entry.info)) throw new Error('Cold activation evidence replaced during capture.');
        return entry.bytes;
      };
      const directories = await Promise.all([root, path.join(root, 'lock'), path.join(root, 'recovery-lock')]
        .map(async file => ({ file, info: identity((await canonicalWorkerDirectory(file, { privateMode: true })).info) })));
      const names = (await readdir(root)).sort();
      if (names.includes('cold-restore-staging') || names.includes('live-retirement.json')
        || !same(names.filter(name => name.startsWith('service-')), ['service-activation.ndjson', 'service-stop.ndjson'])) {
        throw new Error('Cold activation recovery requires unretired original service evidence.');
      }
      const lock = captureLockOwner(parse(await retain(path.join(root, 'lock/owner.json'))));
      await retain(path.join(root, 'state.json'));
      const state = await loadState(root);
      if (lock.project !== project || state?.project !== project || state?.operationId !== lock.operationId
        || !['running', 'stopped'].includes(state.priorRuntime) || completedDeploymentPhase(state.phase)
        || ['preflight', 'restore-preflight'].includes(state.phase)) {
        throw new Error('Cold activation recovery state does not bind the original incomplete operation.');
      }
      const lease = await inspectColdRestoreLease({ control: root, project, backup, lock, state, retain, activation: true });
      const { record, intent, ready } = lease.guard ?? {};
      if (lease.staging || !intent || !ready) throw new Error('Cold activation recovery requires complete readiness evidence.');
      const deadOwners = async () => {
        for (const owner of [lock, record.owner]) {
          if (await processIdentity(owner.pid) === owner.processIdentity) throw new Error('Cold activation controller is still alive.');
        }
      };
      await deadOwners();
      await retain(path.join(root, 'service-stop.ndjson'));
      const stops = await readLinuxServiceStopEvidence({ root, project, lock, state });
      const prior = stops[0].service;
      const inhibition = stops[0].inhibition;
      const held = `${inhibition}.${lock.token}.held`;
      await retain(path.join(root, 'service-activation.ndjson'));
      const started = await readEvidenceJournal({
        root, project, name: 'service-activation.ndjson', maximumBytes: 1024 * 1024, maximumRecords: 5,
        validate(value, records) {
          const fields = captureWorkerFields(value,
            ['version', 'lock', 'prior', 'purpose', 'state', 'inhibition', 'held', 'phase', 'started'], 'cold started receipt');
          const { phase, started, ...base } = fields;
          if (!same(base, { version: 1, lock, prior, purpose: 'restore', state: intent.state, inhibition, held })
            || phase !== activationPhases[records.length]
            || !same(started, phase === 'started' ? ready.runtime : null)) {
            throw new Error('Cold activation journal does not match readiness evidence.');
          }
          return fields;
        },
      });
      const originalIdentity = state.priorRuntime === 'stopped' ? linuxInactiveObservationId(prior) : prior.runtime.invocationId;
      if (started.length !== activationPhases.length || intent.state.runtimeIdentity !== originalIdentity) {
        throw new Error('Cold activation journal is incomplete or binds another generation.');
      }
      const inhibitor = Buffer.from(`[Unit]\nRefuseManualStart=yes\nConditionPathExists=!${inhibition}\n[Service]\nRestart=no\n`);
      if (!(await retain(held, 8192)).equals(inhibitor)) throw new Error('Held cold activation inhibitor changed.');
      const parent = await canonicalWorkerDirectory(path.dirname(held));
      const checkInhibitor = async () => {
        const current = await canonicalWorkerDirectory(parent.root);
        if (!same(identity(current.info), identity(parent.info)) || current.info.uid !== 0 || current.info.mode & 0o022) {
          throw new Error('Cold activation inhibitor parent changed.');
        }
        try { await lstat(inhibition); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        throw new Error('Cold activation was inhibited after readiness.');
      };
      workers = await retainActivationWorkers(root, lock);
      service = await inspectLinuxService({ unit: prior.runtime.unit, project,
        npm: prior.executables[0].file, node: prior.executables[1].file });
      if (!same(service.identity, ready.runtime) || ready.runtime.runtime.invocationId === prior.runtime.invocationId) {
        throw new Error('Cold activated runtime generation changed.');
      }
      const policy = value => Object.fromEntries(Object.entries(value.configuration.state)
        .filter(([key]) => !['MainPID', 'ActiveState', 'SubState', 'ControlGroup', 'InvocationID'].includes(key)));
      if (!same(policy(prior), policy(ready.runtime))
        || !['bootId', 'controlGroup', 'sources', 'executables'].every(key => same(prior[key], ready.runtime[key]))
        || !['unit', 'project', 'user', 'uid', 'gid', 'home'].every(key => same(prior.runtime[key], ready.runtime.runtime[key]))
        || !['drops', 'command', 'conditions'].every(key => same(prior.configuration[key], ready.runtime.configuration[key]))) {
        throw new Error('Cold activated service policy changed.');
      }
      const saved = (await canonicalWorkerDirectory(backup, { privateMode: true })).root;
      if (inside(project, saved) || inside(saved, project)) throw new Error('Cold activation backup must be external.');
      const snapshot = await verifySnapshot(saved, { signal: stageSignal });
      if (snapshot.id !== record.backupId || coldRestoreSnapshotDigest(snapshot) !== record.snapshotSha256
        || snapshot.source.commit !== intent.state.targetCommit) throw new Error('Cold activation backup changed.');
      const profile = 'agents-chat-auth-638c553';
      const config = await inspectLinuxRestoreConfiguration({ service, backup: saved, snapshot, profile, signal: stageSignal });
      const authorizedPaths = [...new Set([...service.identity.sources.map(source => source.path),
        ...config.sourcePaths.filter(file => !inside(project, file))])].sort();
      validateLinuxRestoreSnapshot({ identity: service.identity, manifest: snapshot, authorizedPaths });
      const restored = await inspectLinuxRestoredConfiguration({ service, snapshot, profile, signal: stageSignal });
      const current = await inspectLinuxConfiguration({ service, profile, signal: stageSignal });
      if (!same([...current.providers].sort(), [...ready.providers].sort())
        || !same([...config.providers].sort(), [...ready.providers].sort())) {
        throw new Error('Cold activation providers changed.');
      }
      const check = async ({ signal: checkSignal = new AbortController().signal } = {}) => {
        if (closed) throw new Error('Cold activation recovery authority is closed.');
        checkSignal.throwIfAborted();
        await admission.check();
        await deadOwners();
        for (const entry of directories) {
          if (!same(identity((await canonicalWorkerDirectory(entry.file, { privateMode: true })).info), entry.info)) {
            throw new Error('Cold activation recovery authority directory changed.');
          }
        }
        if (!same((await readdir(root)).sort(), names)
          || !same((await readdir(path.join(root, 'recovery-lock'))).sort(),
            ['activation-intent.json', 'activation-ready.json', 'files-restored.json', 'owner.json'])) {
          throw new Error('Cold activation recovery evidence inventory changed.');
        }
        for (const entry of retained) {
          const info = await entry.handle.stat();
          if (info.nlink !== 1 || !same(identity(info), entry.info) || !same(identity(await lstat(entry.file)), entry.info)
            || !(await readWorkerFile(entry.file, entry.maximum, { privateMode: true })).equals(entry.bytes)) {
            throw new Error('Retained cold activation evidence changed.');
          }
        }
        await checkInhibitor();
        await workers.check();
        await restored.check({ signal: checkSignal });
        await current.check({ signal: checkSignal });
        await service.check();
      };
      await check({ signal: stageSignal });
      await waitLinuxReadiness({ service, port: ready.port, providers: current.providers, waitSeconds, signal: stageSignal });
      await check({ signal: stageSignal });
      return Object.freeze({ status: 'ready-to-commit', identity: service.identity, check, close });
    }, { timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER), signal });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold activation recovery and cleanup failed.'); }
    throw error;
  }
}
