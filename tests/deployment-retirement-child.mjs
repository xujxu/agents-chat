import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { acceptOperation, recoverPriorRuntime, acquireLock } from './deployment-fixture.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

const [control, project, source, runtimeJson, outcome] = process.argv.slice(2);
try {
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
  const runtime = runtimeJson ? JSON.parse(runtimeJson) : null;
  const operation = await createWorkerOperation({ control, lock, saved });
  if (runtime) {
    await operation.run({
      workerId: randomUUID(), runtime,
      command: { file: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync("native-completed","yes")'],
        cwd: project, env: Object.fromEntries(Object.entries(process.env)
          .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) },
    });
  }
  await operation.seal();
  if (outcome === 'prior-runtime-restored') await recoverPriorRuntime(control, lock);
  else await acceptOperation(control, lock);
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
  process.stderr.write(`Retirement fixture failure: ${JSON.stringify({
    code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? null,
  })}\n`);
  process.exit(1);
}
