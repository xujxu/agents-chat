import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectLinuxFirstInstall } from '../scripts/deployment/linux-first-install.mjs';
import { createLinuxFirstUnit } from '../scripts/deployment/linux-first-unit.mjs';
import { enableLinuxFirstUnit } from '../scripts/deployment/linux-first-enablement.mjs';
import { activateLinuxFirstUnit } from '../scripts/deployment/linux-first-activation.mjs';
import { acquireLock, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { publishDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';
import { waitLinuxReadiness } from '../scripts/deployment/linux-readiness.mjs';

const [project, control, unit, source, phase] = process.argv.slice(2);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const installation = await inspectLinuxFirstInstall({ project, unit });
  await fs.mkdir(control, { mode: 0o700 });
  const saved = await saveRecoveryEngine({ control, source });
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  let state = {
    version: 1, operationId: lock.operationId, project, operation: 'deploy', phase: 'preflight',
    previousPhase: null, sourceCommit: 'a'.repeat(40), targetCommit: 'a'.repeat(40), backupId: null,
    priorRuntime: 'absent', runtimeIdentity: 'first-retirement-fixture',
    startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
  };
  await writeState(control, state);
  const workerEngine = await saveWorkerEngine({ control, project, source, operationId: lock.operationId });
  const operation = await createWorkerOperation({ control, lock, saved: workerEngine });
  await operation.seal();
  const record = async next => {
    state = { ...state, previousPhase: state.phase, phase: next };
    await writeState(control, state);
  };
  for (const next of ['source-selected', 'dependencies', 'building', 'configuring']) await record(next);
  const context = { installation, control, lock };
  const publication = await createLinuxFirstUnit(context);
  const enabled = await enableLinuxFirstUnit({ ...context, publication });
  await record('activating');
  const active = await activateLinuxFirstUnit({ ...context, publication, enabled });
  const service = await inspectLinuxService({
    unit, project, npm: installation.identity.executables[0].file, node: installation.identity.executables[1].file,
  });
  let port;
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    try {
      port = Number(await fs.readFile(path.join(project, 'fixture-port'), 'utf8'));
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Fixture listener did not publish its port.');
  const files = { build: 'server.mjs', dependencies: 'package.json', config: '.env.local' };
  const identity = { source: state.targetCommit, service: digest(JSON.stringify(active.identity)) };
  for (const [key, file] of Object.entries(files)) identity[key] = digest(await fs.readFile(path.join(project, file)));
  const acceptance = {
    identity,
    async checkAccepted() {
      await service.check();
      await installation.configuration.check();
      for (const [key, file] of Object.entries(files)) {
        if (digest(await fs.readFile(path.join(project, file))) !== identity[key]) throw new Error('Fixture source changed.');
      }
      await waitLinuxReadiness({ service, port, providers: installation.configuration.providers });
      return identity;
    },
  };
  await acceptance.checkAccepted();
  await record('accepted');
  await publishDeploymentReceipt({ control, lock, ...acceptance });
  const pause = async () => {
    process.send({ lock, saved, port });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
  const open = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    const target = phase === 'service-intent' ? 'service-retirement.json'
      : phase === 'worker-intent' ? 'worker-retirement.json' : null;
    if (target && file === path.join(control, target) && args[0] === 'wx') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); await pause(); };
    }
    return handle;
  };
  const unlink = fs.unlink;
  let deleted = 0;
  fs.unlink = async file => {
    await unlink(file);
    if (phase === 'live-lock-owner' && file === path.join(control, 'lock', 'owner.json')) await pause();
    if (phase === 'service-unlink-1' && (file.endsWith('.held')
      || ['service-activation.ndjson', 'service-install.ndjson', 'service-enablement.ndjson'].includes(path.basename(file)))
      && deleted++ === 1) await pause();
  };
  syncBuiltinESMExports();
  await active.retire({ acceptance });
  await operation.retire();
  await releaseLock(control, lock);
  throw new Error('First retirement fixture completed without its requested interruption.');
} catch (error) {
  process.stderr.write(`${error.stack}\n${error.cause?.stack ?? ''}\n${error.cause?.cause?.stack ?? ''}\n`);
  process.exitCode = 1;
}
