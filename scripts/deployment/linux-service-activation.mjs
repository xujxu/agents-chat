import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createEvidenceJournal, journalUncertain } from './evidence-journal.mjs';
import { linuxNative, linuxSystemdProperties } from './linux-systemd.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { retainActivationWorkers } from './service-activation-workers.mjs';
import { readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';
import { retireLinuxService } from './linux-service-retirement.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allowed = {
  deployment: ['activating'],
  'prior-runtime': ['stopped', 'copying', 'rotating', 'backup-ready'],
};
const phases = ['intent', 'staged', 'uninhibited', 'start-requested', 'started'];

// Only the original live stop handle supplies this internal authority.
export async function activateLinuxService(context, purpose) {
  const { control, lock, unit, project, npm, node, service, inhibition, checkAuthority, checkInhibition } = context;
  let workers;
  let journal;
  let active;
  let originalHandle;
  let heldCreated = false;
  let inhibitorRemoved = false;
  let closed = false;
  const held = `${inhibition}.${lock.token}.held`;
  const parent = path.dirname(inhibition);
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([workers?.close(), journal?.close(), active?.close(), originalHandle?.close()]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Activation handle cleanup failed.');
  };
  let checkHeld;
  try {
    if (!Object.hasOwn(allowed, purpose)) throw new Error('Unsupported service activation purpose.');
    const state = await checkAuthority();
    if (!allowed[purpose].includes(state.phase)) throw new Error('Transaction phase does not authorize this activation purpose.');
    await checkInhibition();
    if (!(await service.checkInhibited({ stopped: true })).stopped) throw new Error('Original service is not stopped.');
    workers = await retainActivationWorkers(control, lock);
    const initial = await lstat(inhibition);
    originalHandle = await open(inhibition, constants.O_RDONLY | constants.O_NOFOLLOW);
    const original = await originalHandle.stat();
    if (initial.dev !== original.dev || initial.ino !== original.ino) throw new Error('Original inhibitor was replaced before activation.');
    const bytes = await readWorkerFile(inhibition, 8192, { privateMode: true });
    const base = { version: 1, lock, prior: service.identity, purpose, state, inhibition, held };
    journal = await createEvidenceJournal({
      root: control, project, name: 'service-activation.ndjson', maximumBytes: 512 * 1024, maximumRecords: 6,
      validate(value, records) {
        const { phase, started, ...rest } = value;
        if (!same(rest, base) || (phase === 'reinhibited'
          ? !records.length || ['started', 'reinhibited'].includes(records.at(-1).phase)
          : phase !== phases[records.length])
          || (phase === 'started' ? !started || started.runtime?.unit !== unit
            || started.runtime?.project !== project : started !== null)) {
          throw new Error('Invalid activation receipt.');
        }
        return Object.freeze(value);
      },
    });
    const check = async () => {
      if (!same(await checkAuthority(), state)) throw new Error('Activation transaction state changed.');
      await workers.check();
      await journal.check();
    };
    const record = async (phase, started = null) => {
      await check();
      await journal.record({ ...base, phase, started });
    };
    checkHeld = async (both = false) => {
      await check();
      const info = await lstat(held);
      const content = Buffer.alloc(bytes.length);
      const { bytesRead } = await originalHandle.read(content, 0, content.length, 0);
      if (!info.isFile() || info.isSymbolicLink() || info.dev !== initial.dev || info.ino !== initial.ino
        || info.uid !== 0 || info.mode & 0o077 || info.nlink !== (both ? 2 : 1)
        || info.size !== bytes.length || bytesRead !== bytes.length || !content.equals(bytes)) {
        throw new Error('Held original service inhibitor was replaced.');
      }
      if (both) {
        const named = await lstat(inhibition);
        if (named.dev !== initial.dev || named.ino !== initial.ino) throw new Error('Service inhibitor name was replaced.');
      } else if (!bytes.equals(await readWorkerFile(held, 8192, { privateMode: true }))) {
        throw new Error('Held original service inhibitor changed.');
      }
    };
    await record('intent');
    await checkInhibition();
    await service.checkInhibited({ stopped: true });
    await link(inhibition, held);
    heldCreated = true;
    await syncWorkerDirectory(parent);
    await checkHeld(true);
    await record('staged');
    await checkHeld(true);
    await unlink(inhibition);
    inhibitorRemoved = true;
    await syncWorkerDirectory(parent);
    await checkHeld();
    await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
    await service.checkPolicy({ stopped: true });
    await record('uninhibited');
    await record('start-requested');
    await checkHeld();
    await service.checkPolicy({ stopped: true });
    await linuxNative('/usr/bin/systemctl', ['--system', 'start', '--no-block', unit]);
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      await checkHeld();
      const observed = await linuxSystemdProperties(unit, ['ActiveState', 'SubState', 'MainPID']);
      if (observed.ActiveState === 'active' && observed.SubState === 'running' && observed.MainPID !== '0') {
        active = await inspectLinuxService({ unit, project, npm, node });
        if (active.identity.runtime.invocationId === service.identity.runtime.invocationId) {
          throw new Error('Activation did not create a new service generation.');
        }
        await service.checkPolicy();
        await active.check();
        await record('started', active.identity);
        return Object.freeze({
          status: 'active-unverified', identity: active.identity, close,
          async retire() {
            if (closed || purpose !== 'deployment') {
              throw journalUncertain(new Error('Service retirement requires an accepted deployment activation, not prior-runtime restart.'));
            }
            const verify = async () => {
              const accepted = await checkAuthority({ retiring: true });
              if (accepted.phase !== 'accepted' || !['activating', 'activation-unverified'].includes(accepted.previousPhase)
                || Object.keys(state).filter(key => !['phase', 'previousPhase', 'updatedAt'].includes(key))
                  .some(key => accepted[key] !== state[key])) {
                throw new Error('Matching application acceptance is required for service retirement.');
              }
              await workers.check();
              await service.checkPolicy();
              await active.check();
              return accepted;
            };
            const verifyEvidence = async () => {
              await context.checkStopJournal();
              await journal.check();
              const current = await lstat(held);
              if (current.dev !== initial.dev || current.ino !== initial.ino || current.nlink !== 1
                || !bytes.equals(await readWorkerFile(held, 8192, { privateMode: true }))) {
                throw new Error('Original held service inhibitor changed before retirement.');
              }
            };
            try {
              await verify();
              await verifyEvidence();
              await retireLinuxService({ control, lock, held, runtime: active.identity, verify, verifyEvidence });
            } catch (error) { throw journalUncertain(error); }
          },
        });
      }
      if (observed.ActiveState === 'failed' || observed.SubState === 'auto-restart') {
        throw new Error('Service activation failed.');
      }
      await delay(50);
    }
    throw new Error('Service activation did not reach a verifiable running state.');
  } catch (error) {
    const errors = [error];
    if (heldCreated) {
      try {
        await checkHeld(!inhibitorRemoved);
        if (inhibitorRemoved) await link(held, inhibition);
        await unlink(held);
        heldCreated = false;
        await syncWorkerDirectory(parent);
        await checkInhibition();
        await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
        await service.checkPolicy({ inhibited: true });
        // A failed/poisoned journal still blocks recovery even if inhibition was restored.
        await journal.record({ version: 1, lock, prior: service.identity, purpose,
          state: await checkAuthority(), inhibition, held, phase: 'reinhibited', started: null });
      } catch (cleanup) { errors.push(cleanup); }
    }
    try { await close(); }
    catch (cleanup) { errors.push(cleanup); }
    throw journalUncertain(errors.length === 1 ? error : new AggregateError(errors));
  }
}
