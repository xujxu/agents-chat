import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readWorkerOperation } from './worker-operation.mjs';
import { readWorkerJournal } from './worker-journal.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { verifyWorkerEngine } from './saved-worker-engine.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inventory = async root => (await readdir(root)).filter(name => name.startsWith('worker-')).sort();

export async function retainActivationWorkers(control, lock) {
  const retained = [];
  const close = async () => {
    const results = await Promise.allSettled(retained.map(entry => entry.handle.close()));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Could not close activation worker evidence.');
  };
  try {
    const files = await inventory(control);
    if (files.length) {
      const records = await readWorkerOperation(control);
      const first = records[0];
      if (!same(first.lock, lock) || records.at(-1).phase !== 'sealed') {
        throw new Error('Service activation requires a matching sealed worker operation.');
      }
      const owners = records.filter(record => record.phase === 'enrolled').map(record => ({
        project: lock.project, operationId: lock.operationId, workerId: record.workerId,
        controllerIdentity: lock.processIdentity,
      }));
      const expected = ['worker-engine', 'worker-operation.ndjson', ...owners.map(owner => `worker-${owner.workerId}.ndjson`)].sort();
      if (!same(files, expected)) throw new Error('Activation worker inventory is incomplete or foreign.');
      await verifyWorkerEngine({ control, project: lock.project, operationId: lock.operationId,
        manifestSha256: first.manifestSha256 });
      for (const name of files.filter(name => name !== 'worker-engine')) {
        const file = path.join(control, name);
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const entry = { file, handle, info: await handle.stat() };
        retained.push(entry);
        entry.bytes = await readWorkerFile(file, 512 * 1024, { privateMode: true });
        const named = await lstat(file);
        if (named.dev !== entry.info.dev || named.ino !== entry.info.ino) {
          throw new Error('Worker evidence was replaced during activation admission.');
        }
      }
      if (!same(await readWorkerOperation(control), records)) throw new Error('Worker operation changed during activation admission.');
      for (const owner of owners) {
        if ((await readWorkerJournal(control, owner)).at(-1).phase !== 'settled') {
          throw new Error('Service activation refuses unsettled workers.');
        }
      }
    }
    const check = async () => {
      if (!same(await inventory(control), files)) throw new Error('Worker inventory changed during service activation.');
      for (const entry of retained) {
        const named = await lstat(entry.file);
        const opened = await entry.handle.stat();
        if (named.dev !== entry.info.dev || named.ino !== entry.info.ino || opened.nlink !== 1
          || !entry.bytes.equals(await readWorkerFile(entry.file, 512 * 1024, { privateMode: true }))) {
          throw new Error('Retained worker evidence changed during service activation.');
        }
      }
    };
    await check();
    return { check, close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup]); }
    throw error;
  }
}
