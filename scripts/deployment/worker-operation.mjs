import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createEvidenceJournal, readEvidenceJournal, journalUncertain } from './evidence-journal.mjs';
import { captureOwner, captureWorkerFields } from './worker-identity.mjs';
import { captureLockOwner, assertLockOwner, loadState } from './state.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { verifyWorkerEngine } from './saved-worker-engine.mjs';
import { createWorkerJournal, readWorkerJournal } from './worker-journal.mjs';
import { runOwnedWorker } from './owned-worker.mjs';
import { captureWorkerCommand } from './worker-wire.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { prepareLinuxWorker } from './linux-worker.mjs';
import { prepareWindowsWorker } from './windows-worker.mjs';

const name = 'worker-operation.ndjson';
const maximumWorkers = 32;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const workerOwner = (lock, workerId) => captureOwner({
  project: lock.project, operationId: lock.operationId, workerId,
  controllerIdentity: lock.processIdentity,
});

function options(root, project) {
  return {
    root, project, name, maximumBytes: 512 * 1024, maximumRecords: maximumWorkers + 2,
    validate(value, records) {
      const record = captureWorkerFields(value,
        ['version', 'phase', 'lock', 'manifestSha256', 'workerId'], 'operation receipt');
      const lock = captureLockOwner(record.lock);
      if (record.version !== 1 || lock.project !== project
        || typeof record.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.manifestSha256)
        || (records.length === 0
          ? record.phase !== 'opened' || record.workerId !== null
          : !same(lock, records[0].lock) || record.manifestSha256 !== records[0].manifestSha256
            || records.at(-1).phase === 'sealed' || !['enrolled', 'sealed'].includes(record.phase))) {
        throw new Error('Invalid worker operation identity or transition.');
      }
      if (record.phase === 'enrolled') {
        workerOwner(lock, record.workerId);
        if (records.length > maximumWorkers || records.some(previous => previous.workerId === record.workerId)) {
          throw new Error('Duplicate or excessive worker enrollment.');
        }
      } else if (record.workerId !== null) throw new Error('Unexpected operation worker identity.');
      return Object.freeze({ ...record, lock });
    },
  };
}

export async function readWorkerOperation(control) {
  try {
    const bytes = await readWorkerFile(path.join(control, name), 512 * 1024, { privateMode: true });
    const first = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(bytes).split('\n', 1)[0]);
    const lock = captureLockOwner(first.lock);
    const records = await readEvidenceJournal(options(control, lock.project));
    if (!same(records[0], options(control, lock.project).validate(first, []))) {
      throw new Error('Operation evidence changed during inspection.');
    }
    return records;
  } catch (error) { throw journalUncertain(error); }
}

export async function createWorkerOperation({ control, lock: suppliedLock, saved: suppliedSaved }) {
  let journal;
  let lockHandle;
  try {
    const lock = captureLockOwner(suppliedLock);
    const supplied = captureWorkerFields(suppliedSaved,
      ['directory', 'entrypoint', 'manifestSha256'], 'saved engine');
    const workers = [];
    const checkInventory = async () => {
      const actual = (await readdir(control))
        .filter(file => file.startsWith('worker-') && file.endsWith('.ndjson') && file !== name).sort();
      const expected = workers.map(owner => `worker-${owner.workerId}.ndjson`).sort();
      if (!same(actual, expected)) throw new Error('Worker evidence inventory is incomplete or foreign.');
    };
    const lockFiles = [path.join(control, 'lock'), path.join(control, 'lock', 'owner.json')];
    const lockIdentity = async () => Promise.all(lockFiles.map(async file => {
      const info = await lstat(file);
      return { dev: info.dev, ino: info.ino };
    }));
    let originalLock;
    const verify = async () => {
      try {
        const before = await lockIdentity();
        await assertLockOwner(control, lock);
        lockHandle ??= await open(lockFiles[1], constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const retained = await lockHandle.stat();
        const after = await lockIdentity();
        if (!same(before, after) || originalLock && !same(originalLock, after)
          || retained.dev !== after[1].dev || retained.ino !== after[1].ino || retained.nlink !== 1) {
          throw new Error('Original deployment lock evidence was replaced.');
        }
        originalLock ??= after;
        const state = await loadState(control);
        if (state && (state.operationId !== lock.operationId || state.project !== lock.project
          || ['blocked', 'accepted', 'restored', 'recovery-required'].includes(state.phase))) {
          throw new Error('Deployment state does not admit workers for this operation.');
        }
        const saved = await verifyWorkerEngine({
          control, project: lock.project, operationId: lock.operationId,
          manifestSha256: supplied.manifestSha256,
        });
        if (!same(saved, supplied)) throw new Error('Saved engine descriptor changed.');
        if (journal) await journal.check();
        await checkInventory();
        return saved;
      } catch (error) { throw journalUncertain(error); }
    };
    const saved = await verify();
    journal = await createEvidenceJournal(options(control, lock.project));
    const receipt = (phase, workerId = null) => Object.freeze({
      version: 1, phase, lock, manifestSha256: saved.manifestSha256, workerId,
    });
    await journal.record(receipt('opened'));
    let busy = false;
    let sealed = false;
    let poisoned = false;
    let closing;
    const begin = () => {
      if (busy || sealed || poisoned || closing) throw journalUncertain(new Error('Operation admission is closed or busy.'));
      busy = true;
    };
    return Object.freeze({
      async run({ workerId, command: inputCommand, runtime: inputRuntime, signal }) {
        begin();
        let workerJournal;
        let enrolledOwner;
        let result;
        const errors = [];
        try {
          const owner = workerOwner(lock, workerId);
          const command = captureWorkerCommand(inputCommand);
          const runtime = captureWorkerFields(inputRuntime,
            process.platform === 'linux' ? ['uid', 'gid'] : ['pwsh', 'accountSid', 'sessionId'], 'runtime');
          signal?.throwIfAborted();
          await verify();
          await journal.record(receipt('enrolled', workerId));
          workers.push(owner);
          enrolledOwner = owner;
          workerJournal = await createWorkerJournal(control, owner);
          result = await runOwnedWorker({ owner, signal }, {
            record: workerJournal.record,
            async prepare(context) {
              await verify();
              const prepare = process.platform === 'linux' ? prepareLinuxWorker : prepareWindowsWorker;
              const handle = await prepare({ ...context, saved, command, ...runtime });
              return {
                ...handle,
                async run(runContext) {
                  await verify();
                  return handle.run(runContext);
                },
              };
            },
          });
        } catch (error) { errors.push(error); }
        if (workerJournal) {
          try { await workerJournal.close(); }
          catch (error) { errors.push(error); }
        }
        if (enrolledOwner) {
          try {
            if ((await readWorkerJournal(control, enrolledOwner)).at(-1).phase !== 'settled') {
              throw journalUncertain(new Error('Enrolled worker did not settle.'));
            }
          } catch (error) { errors.push(error); }
        }
        poisoned ||= errors.some(hasUnsettledWorker);
        busy = false;
        if (errors.length) throw errors.length === 1 ? errors[0] : journalUncertain(new AggregateError(errors));
        return result;
      },
      async seal() {
        begin();
        try {
          await verify();
          for (const owner of workers) {
            if ((await readWorkerJournal(control, owner)).at(-1).phase !== 'settled') {
              throw new Error('Enrolled worker has no verified settlement.');
            }
          }
          await journal.record(receipt('sealed'));
          sealed = true;
        } catch (error) {
          poisoned = true;
          throw journalUncertain(error);
        } finally { busy = false; }
      },
      async close() {
        if (busy) throw journalUncertain(new Error('Cannot close an active worker operation.'));
        closing ??= (async () => {
          const errors = [];
          try { await journal.close(); }
          catch (error) { errors.push(error); }
          try { await lockHandle.close(); }
          catch (error) { errors.push(error); }
          if (errors.length) throw journalUncertain(errors.length === 1 ? errors[0] : new AggregateError(errors));
        })();
        await closing;
      },
    });
  } catch (error) {
    const errors = [error];
    if (journal) {
      try { await journal.close(); }
      catch (cleanup) { errors.push(cleanup); }
    }
    if (lockHandle) {
      try { await lockHandle.close(); }
      catch (cleanup) { errors.push(cleanup); }
    }
    throw journalUncertain(errors.length === 1 ? error : new AggregateError(errors));
  }
}
