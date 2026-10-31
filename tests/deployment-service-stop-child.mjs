import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, loadState, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { inspectLinuxInactiveService } from '../scripts/deployment/linux-inactive-service.mjs';

const [control, project, unit, npm, node, phase, outcome = 'accepted', workerMode = 'none', priorRuntime = 'running'] = process.argv.slice(2);
if (!['running', 'stopped'].includes(priorRuntime) || priorRuntime === 'stopped' && phase !== 'stopped') {
  throw new Error('Unsupported interrupted fixture runtime or phase.');
}
let runtimeIdentity = unit;
if (priorRuntime === 'stopped') {
  const observed = await inspectLinuxInactiveService({ unit, project, npm, node });
  try { runtimeIdentity = observed.runtimeIdentity; }
  finally { await observed.close(); }
}
const activation = phase.startsWith('activation-');
const activationStopping = phase.startsWith('activation-stop:');
const receiptPhase = activationStopping ? phase.slice('activation-stop:'.length)
  : activation ? phase.slice('activation-'.length) : phase;
const restoring = outcome === 'restored';
const lock = await acquireLock(control, { project, operationId: randomUUID() });
const state = {
  version: 1, operationId: lock.operationId, project, operation: restoring ? 'restore' : 'update',
  phase: restoring ? 'restore-preflight' : 'preflight', previousPhase: null,
  sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
  backupId: null, priorRuntime, runtimeIdentity,
  startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
};
await writeState(control, state);
await writeState(control, { ...state, phase: restoring ? 'restoring' : 'stopped', previousPhase: state.phase });
const nativeOpen = fs.open;
fs.open = async function (file, ...args) {
  const handle = await nativeOpen(file, ...args);
  if (phase === 'retirement-intent' && file === path.join(control, 'service-retirement.json')
    || phase === 'retirement-live-worker-intent' && file === path.join(control, 'worker-retirement.json')) {
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
let workers;
if (workerMode !== 'none') {
  const saved = await saveWorkerEngine({ control, project, operationId: lock.operationId,
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)) });
  workers = await createWorkerOperation({ control, lock, saved });
  if (workerMode === 'settled') {
    await workers.run({ workerId: randomUUID(), command: {
      file: node, args: ['-e', 'require("node:fs").writeFileSync("worker-finished","yes")'],
      cwd: project, env: { PATH: '/usr/bin:/bin', HOME: '/root' },
    }, runtime: { uid: 0, gid: 0 } });
  }
  await workers.seal();
}
if (activation) await stopped.activate({ purpose: 'prior-runtime' });
if (activationStopping) await stopped.stopActivated();
if (phase.startsWith('retirement-')) {
  const prior = outcome === 'prior-runtime-restored';
  for (const next of restoring ? ['restore-activating'] : prior ? ['copying'] : ['copying', 'rotating', 'backup-ready', 'source-selected',
    'dependencies', 'building', 'configuring', 'activating']) {
    const current = await loadState(control);
    await writeState(control, { ...current, phase: next, previousPhase: current.phase });
  }
  await stopped.activate({ purpose: restoring ? 'restore' : prior ? 'prior-runtime' : 'deployment' });
  const current = await loadState(control);
  await writeState(control, { ...current, phase: outcome, previousPhase: current.phase,
    errorCode: prior ? 'BACKUP_FAILED' : null });
  const nativeUnlink = fs.unlink;
  const pause = async () => {
    process.send({ phase, lock });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
  const nativeRename = fs.rename;
  fs.rename = async (from, to) => {
    await nativeRename(from, to);
    if (phase === 'retirement-live-published' && to === path.join(control, 'live-retirement.json')) await pause();
  };
  const nativeRmdir = fs.rmdir;
  fs.rmdir = async file => {
    await nativeRmdir(file);
    if (phase === 'retirement-live-lock-directory' && file === path.join(control, 'lock')) await pause();
    if (phase === 'retirement-live-worker-directory' && file === path.join(control, 'worker-engine')) await pause();
  };
  let deleted = 0;
  const pauseAfter = phase === 'retirement-unlink' ? 0 : Number(phase.slice('retirement-unlink-'.length));
  fs.unlink = async function (file) {
    await nativeUnlink(file);
    if (phase === 'retirement-live-lock-owner' && file === path.join(control, 'lock', 'owner.json')) await pause();
    if (phase === 'retirement-live-worker-journal' && /^worker-[a-f0-9-]{36}\.ndjson$/.test(path.basename(file))
      || phase === 'retirement-live-worker-operation' && file === path.join(control, 'worker-operation.ndjson')
      || phase === 'retirement-live-worker-marker' && file === path.join(control, 'worker-retirement.json')) await pause();
    if (path.dirname(file) === path.join(control, 'worker-engine')) {
      if (phase === 'retirement-live-worker-helper'
        || phase === 'retirement-live-worker-last-helper' && (await fs.readdir(path.dirname(file))).length === 0) await pause();
    }
    if ((String(file).endsWith('.held') || ['service-activation.ndjson', 'service-stop.ndjson'].includes(path.basename(file)))
      && deleted++ === pauseAfter) {
      process.send({ phase, lock });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
  };
  syncBuiltinESMExports();
  await stopped.retire();
  if (phase.startsWith('retirement-live-')) {
    await workers?.retire();
    if (phase === 'retirement-live-workers-done') await pause();
    await releaseLock(control, lock);
  }
}
throw new Error('Fixture did not pause at the requested durable stop receipt.');
