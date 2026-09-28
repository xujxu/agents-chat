import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { activateLinuxService } from './linux-service-activation.mjs';
import { linuxNative } from './linux-systemd.mjs';
import { assertLockOwner, captureLockOwner, loadState, requireNoServiceMaintenance } from './state.mjs';
import { createEvidenceJournal, journalUncertain } from './evidence-journal.mjs';
import { canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = info => ({ dev: info.dev, ino: info.ino });
const phases = ['intent', 'inhibited', 'stop-requested', 'stopped'];

export async function stopLinuxService({ control, lock: suppliedLock, unit, project, npm, node }) {
  let service;
  let journal;
  let inhibitHandle;
  let lockHandle;
  let closed = false;
  let poisoned = false;
  let busy = false;
  let activationAttempted = false;
  let activated;
  let retirementAttempted = false;
  const closeHandles = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      service?.close(), journal?.close(), inhibitHandle?.close(), lockHandle?.close(), activated?.close(),
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw journalUncertain(new AggregateError(errors, 'Service stop handle cleanup failed.'));
  };
  const close = async () => {
    if (busy) throw journalUncertain(new Error('Cannot close service stop authority while checking it.'));
    await closeHandles();
  };
  try {
    const lock = captureLockOwner(suppliedLock);
    const { root, info } = await externalWorkerDirectory(control, project);
    if (lock.project !== project) throw new Error('Service stop project does not match the lock.');
    await requireNoServiceMaintenance(root);
    await assertLockOwner(root, lock);
    const lockDirectory = path.join(root, 'lock');
    const lockPath = path.join(lockDirectory, 'owner.json');
    const lockInfo = identity((await canonicalWorkerDirectory(lockDirectory, { privateMode: true })).info);
    lockHandle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const lockFile = identity(await lockHandle.stat());
    const initial = await loadState(root);
    const restoring = initial?.operation === 'restore';
    if (!initial || initial.phase !== (restoring ? 'restoring' : 'stopped') || initial.project !== project
      || initial.operationId !== lock.operationId || initial.priorRuntime !== 'running') {
      throw new Error('Service stop requires matching stopped-phase transaction admission.');
    }
    const checkAuthority = async ({ retiring = false } = {}) => {
      if (closed || poisoned) throw new Error('Service stop authority is closed or poisoned.');
      await assertLockOwner(root, lock);
      const current = await canonicalWorkerDirectory(root, { privateMode: true });
      const currentLock = await canonicalWorkerDirectory(lockDirectory, { privateMode: true });
      const retained = await lockHandle.stat();
      if (!same(identity(current.info), identity(info)) || !same(identity(currentLock.info), lockInfo)
        || !same(identity(await lstat(lockPath)), lockFile) || !same(identity(retained), lockFile)
        || retained.nlink !== 1) throw new Error('Original service transaction lock was replaced.');
      const state = await loadState(root);
      const phases = restoring
        ? ['restoring', 'restore-activating', ...(retiring ? ['restored'] : [])]
        : ['stopped', 'copying', 'rotating', 'backup-ready', 'source-selected',
          'dependencies', 'building', 'configuring', 'activating',
          ...(retiring ? ['accepted', 'prior-runtime-restored'] : [])];
      if (!state || state.project !== project || state.operationId !== lock.operationId
        || state.operation !== initial.operation || !phases.includes(state.phase)) {
        throw new Error('Service maintenance transaction state no longer authorizes stopped work.');
      }
      if (journal && !retiring) await journal.check();
      return state;
    };
    await checkAuthority();
    service = await inspectLinuxService({ unit, project, npm, node });
    const inhibition = `/etc/systemd/system/${unit}.d/90-agents-chat-deployment.conf`;
    const parent = path.dirname(inhibition);
    const bytes = Buffer.from(`[Unit]\nRefuseManualStart=yes\nConditionPathExists=!${inhibition}\n[Service]\nRestart=no\n`);
    const base = Object.freeze({ version: 1, lock, service: service.identity, inhibition });
    journal = await createEvidenceJournal({
      root, project, name: 'service-stop.ndjson', maximumBytes: 256 * 1024, maximumRecords: 4,
      validate(value, records) {
        const { phase, ...rest } = value;
        if (!same(rest, base) || phase !== phases[records.length]) throw new Error('Invalid service stop receipt.');
        return Object.freeze({ ...base, phase });
      },
    });
    const record = async phase => {
      await checkAuthority();
      await journal.record({ ...base, phase });
    };
    await service.check();
    await record('intent');
    try { await mkdir(parent, { mode: 0o755 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== 0 || parentInfo.mode & 0o022) {
      throw new Error('Service inhibition directory has unsafe ownership or permissions.');
    }
    await syncWorkerDirectory(path.dirname(parent));
    await checkAuthority();
    await service.check();
    inhibitHandle = await open(inhibition, 'wx+', 0o600);
    await inhibitHandle.writeFile(bytes);
    await inhibitHandle.sync();
    await syncWorkerDirectory(parent);
    const original = identity(await inhibitHandle.stat());
    const checkInhibition = async () => {
      await checkAuthority();
      const directory = await lstat(parent);
      const retained = await inhibitHandle.stat();
      const named = await lstat(inhibition);
      if (!same(identity(directory), identity(parentInfo)) || directory.isSymbolicLink()
        || directory.uid !== 0 || directory.mode & 0o022
        || !same(identity(retained), original) || !same(identity(named), original)
        || retained.nlink !== 1 || !bytes.equals(await readWorkerFile(inhibition, 8192, { privateMode: true }))) {
        throw new Error('Original service inhibition evidence was changed or replaced.');
      }
    };
    await checkInhibition();
    await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
    await checkInhibition();
    await service.checkInhibited();
    await record('inhibited');
    await record('stop-requested');
    await checkInhibition();
    await service.checkInhibited();
    await linuxNative('/usr/bin/systemctl', ['--system', 'stop', '--no-block', unit]);
    let stopped = false;
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      await checkInhibition();
      if ((await service.checkInhibited({ stopped: true })).stopped) { stopped = true; break; }
      await delay(50);
    }
    if (!stopped) throw new Error('Original service domain did not stop within its observation budget.');
    await record('stopped');
    return Object.freeze({
      async checkStopped() {
        if (busy || activationAttempted) throw journalUncertain(new Error('Service stop authority is busy or activation was attempted.'));
        busy = true;
        try {
          await checkInhibition();
          if (!(await service.checkInhibited({ stopped: true })).stopped) throw new Error('Service is no longer stopped.');
          await checkInhibition();
          return Object.freeze({ stopped: true, inhibited: true });
        } catch (error) {
          poisoned = true;
          throw journalUncertain(error);
        } finally { busy = false; }
      },
      async activate({ purpose }) {
        if (busy || activationAttempted || closed || poisoned) {
          throw journalUncertain(new Error('Service activation authority is unavailable or already used.'));
        }
        busy = true;
        activationAttempted = true;
        try {
          activated = await activateLinuxService({
            control: root, lock, unit, project, npm, node, service, inhibition, checkAuthority, checkInhibition,
            checkStopJournal: () => journal.check(),
            closeForRetirement: closeHandles,
          }, purpose);
          return Object.freeze({ status: activated.status, identity: activated.identity });
        } catch (error) {
          poisoned = true;
          throw error;
        } finally { busy = false; }
      },
      async retire() {
        if (busy || retirementAttempted || closed || poisoned || !activated) {
          throw journalUncertain(new Error('Service retirement requires the original live activated authority.'));
        }
        busy = true;
        retirementAttempted = true;
        try {
          await activated.retire();
        } catch (error) {
          poisoned = true;
          throw error;
        } finally { busy = false; }
        await close();
      },
      close,
    });
  } catch (error) {
    poisoned = true;
    try { await close(); }
    catch (cleanup) { throw journalUncertain(new AggregateError([error, cleanup])); }
    throw journalUncertain(error);
  }
}
