import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { acquireLock, writeState } from '../scripts/deployment/state.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';

const [control, project, unit, npm, node, phase] = process.argv.slice(2);
const lock = await acquireLock(control, { project, operationId: randomUUID() });
const state = {
  version: 1, operationId: lock.operationId, project, operation: 'update',
  phase: 'preflight', previousPhase: null, sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
  backupId: null, priorRuntime: 'running', runtimeIdentity: unit,
  startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
};
await writeState(control, state);
await writeState(control, { ...state, phase: 'stopped', previousPhase: 'preflight' });
const nativeOpen = fs.open;
fs.open = async function (file, ...args) {
  const handle = await nativeOpen(file, ...args);
  if (file === path.join(control, 'service-stop.ndjson')) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      const text = await fs.readFile(file, 'utf8');
      if (text.trim() && JSON.parse(text.trim().split('\n').at(-1)).phase === phase) {
        process.send({ phase, lock });
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    };
  }
  return handle;
};
syncBuiltinESMExports();
await stopLinuxService({ control, lock, unit, project, npm, node });
throw new Error('Fixture did not pause at the requested durable stop receipt.');
