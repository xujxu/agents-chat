import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { acquireLock, loadState, writeState } from '../scripts/deployment/state.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';

const [control, project, unit, npm, node, phase] = process.argv.slice(2);
const activation = phase.startsWith('activation-');
const receiptPhase = activation ? phase.slice('activation-'.length) : phase;
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
  if (file === path.join(control, activation ? 'service-activation.ndjson' : 'service-stop.ndjson')) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      const text = await fs.readFile(file, 'utf8');
      if (text.trim() && JSON.parse(text.trim().split('\n').at(-1)).phase === receiptPhase) {
        process.send({ phase, lock });
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    };
  }
  return handle;
};
syncBuiltinESMExports();
const stopped = await stopLinuxService({ control, lock, unit, project, npm, node });
if (activation) await stopped.activate({ purpose: 'prior-runtime' });
if (phase === 'retirement-unlink') {
  for (const next of ['copying', 'rotating', 'backup-ready', 'source-selected',
    'dependencies', 'building', 'configuring', 'activating']) {
    const current = await loadState(control);
    await writeState(control, { ...current, phase: next, previousPhase: current.phase });
  }
  await stopped.activate({ purpose: 'deployment' });
  const current = await loadState(control);
  await writeState(control, { ...current, phase: 'accepted', previousPhase: 'activating' });
  const nativeUnlink = fs.unlink;
  fs.unlink = async function (file) {
    await nativeUnlink(file);
    if (String(file).endsWith('.held')) {
      process.send({ phase, lock });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
  };
  syncBuiltinESMExports();
  await stopped.retire();
}
throw new Error('Fixture did not pause at the requested durable stop receipt.');
