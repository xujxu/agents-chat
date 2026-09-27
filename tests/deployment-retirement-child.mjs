import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { acceptOperation } from './deployment-fixture.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

const [control, project, source] = process.argv.slice(2);
try {
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
  const operation = await createWorkerOperation({ control, lock, saved });
  await operation.seal();
  await acceptOperation(control, lock);
  const unlink = fs.unlink;
  fs.unlink = async file => {
    await unlink(file);
    if (path.dirname(file) === saved.directory) {
      process.send({ lock, saved });
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  };
  syncBuiltinESMExports();
  await operation.retire();
  throw new Error('Retirement crash fixture unexpectedly completed.');
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
}
