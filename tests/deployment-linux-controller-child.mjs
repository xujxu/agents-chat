import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { createWorkerJournal } from '../scripts/deployment/worker-journal.mjs';
import { runOwnedWorker } from '../scripts/deployment/owned-worker.mjs';
import { prepareLinuxWorker } from '../scripts/deployment/linux-worker.mjs';

process.once('message', async ({ owner: suppliedOwner, saved, command, control }) => {
  const owner = { ...suppliedOwner, controllerIdentity: await processIdentity(process.pid) };
  let journal;
  const errors = [];
  try {
    journal = await createWorkerJournal(control, owner);
    process.send({ owner });
    await runOwnedWorker({ owner }, {
      record: journal.record,
      prepare: context => prepareLinuxWorker({ ...context, saved, command, uid: 0, gid: 0 }),
    });
  } catch (error) { errors.push(error); }
  if (journal) {
    try { await journal.close(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) {
    process.stderr.write(`${errors.map(error => error.message).join('; ')}\n`);
    process.exitCode = 1;
  }
  process.disconnect();
});
