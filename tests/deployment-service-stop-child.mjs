import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { acquireLock, loadState, writeState } from '../scripts/deployment/state.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';

const [control, project, unit, npm, node, phase, outcome = 'accepted'] = process.argv.slice(2);
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
  if (phase === 'retirement-intent' && file === path.join(control, 'service-retirement.json')) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      process.send({ phase, lock });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    };
  }
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
if (phase.startsWith('retirement-')) {
  const prior = outcome === 'prior-runtime-restored';
  for (const next of prior ? ['copying'] : ['copying', 'rotating', 'backup-ready', 'source-selected',
    'dependencies', 'building', 'configuring', 'activating']) {
    const current = await loadState(control);
    await writeState(control, { ...current, phase: next, previousPhase: current.phase });
  }
  await stopped.activate({ purpose: prior ? 'prior-runtime' : 'deployment' });
  const current = await loadState(control);
  await writeState(control, { ...current, phase: outcome, previousPhase: current.phase,
    errorCode: prior ? 'BACKUP_FAILED' : null });
  const nativeUnlink = fs.unlink;
  let deleted = 0;
  const pauseAfter = phase === 'retirement-unlink' ? 0 : Number(phase.slice('retirement-unlink-'.length));
  fs.unlink = async function (file) {
    await nativeUnlink(file);
    if ((String(file).endsWith('.held') || ['service-activation.ndjson', 'service-stop.ndjson'].includes(path.basename(file)))
      && deleted++ === pauseAfter) {
      process.send({ phase, lock });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
  };
  syncBuiltinESMExports();
  await stopped.retire();
}
throw new Error('Fixture did not pause at the requested durable stop receipt.');
