import { createWorkerJournal } from '../scripts/deployment/worker-journal.mjs';

const [root, encodedOwner] = process.argv.slice(2);
const owner = JSON.parse(encodedOwner);
try {
  const journal = await createWorkerJournal(root, owner);
  await journal.record({ version: 1, owner, phase: 'intent', domain: null });
  process.on('message', async message => {
    if (message !== 'close') return;
    await journal.close();
    process.disconnect();
  });
  process.send({ status: 'recorded' });
} catch (error) {
  process.send({ status: 'failed', code: error.code }, () => {
    process.exitCode = 1;
    process.disconnect();
  });
}
