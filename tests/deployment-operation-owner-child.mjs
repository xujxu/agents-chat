import { randomUUID } from 'node:crypto';
import { acquireLock } from './deployment-fixture.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

const [control, project, source] = process.argv.slice(2);
try {
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
  await createWorkerOperation({ control, lock, saved });
  process.send({ lock, saved });
  setInterval(() => {}, 1000);
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
}
