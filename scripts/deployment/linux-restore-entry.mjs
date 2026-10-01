import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { verifyRecoveryEngine } from './saved-recovery-engine.mjs';
import { captureWorkerFields } from './worker-identity.mjs';

let service;
let lock;
let originalState;
let operations;
let control;
let result;
let stage = 'arguments';
const errors = [];
try {
  const [directory, manifestSha256, acknowledgement, ...extra] = process.argv.slice(2);
  if (acknowledgement !== '--accept-data-loss' || extra.length) {
    throw Object.assign(new Error('Explicit --accept-data-loss acknowledgement is required.'), {
      code: 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED',
    });
  }
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Saved Linux restore requires root.');
  control = directory;
  stage = 'engine-verification';
  const saved = await verifyRecoveryEngine({ control, manifestSha256 });
  if (fileURLToPath(import.meta.url) !== path.join(saved.directory, 'linux-restore-entry.mjs')) {
    throw new Error('Restore must run from the verified saved engine.');
  }
  stage = 'input';
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32768) throw new Error('Restore input exceeds its limit.');
    chunks.push(chunk);
  }
  const input = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
    ['project', 'unit', 'npm', 'node', 'backup', 'port', 'waitSeconds', 'timeoutSeconds'], 'saved restore input');
  if (![input.waitSeconds, input.timeoutSeconds].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('Saved restore requires positive deadlines and an explicit valid port.');
  }
  stage = 'backup-engine-binding';
  const { verifySnapshot } = await import('./snapshot.mjs');
  const { runStage } = await import('./stage-runner.mjs');
  const snapshot = await runStage(stage, signal => verifySnapshot(input.backup, { signal }),
    { timeoutMs: Math.min(input.timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER) });
  if (snapshot.version === 2 && snapshot.recoveryEngine !== manifestSha256) {
    throw new Error('Saved backup requires a different recovery engine digest.');
  }
  operations = await import('./state.mjs');
  const names = await readdir(control);
  const cold = names.includes('lock') || names.includes('recovery-lock')
    || names.includes('service-cold-retirement.json') || names.includes('cold-restore-complete.json');
  if (cold) {
    stage = 'cold-restore';
    const { runLinuxColdRestore } = await import('./linux-cold-restore.mjs');
    result = await runLinuxColdRestore({ ...input, control, acceptDataLoss: true });
  } else {
    const { inspectInstalledLinuxService } = await import('./linux-service-inspection.mjs');
    const { assertColdRestoreNative } = await import('./linux-restore-compatibility.mjs');
    const { inspectLinuxConfiguration } = await import('./linux-configuration.mjs');
    const { runLinuxLiveRestore } = await import('./linux-restore.mjs');
    stage = 'service-inspection';
    service = await inspectInstalledLinuxService(input);
    assertColdRestoreNative(service.identity, input);
    const configuration = await inspectLinuxConfiguration({ service, profile: 'agents-chat-auth-638c553' });
    stage = 'lock-admission';
    lock = await operations.acquireLock(control, { project: input.project, operationId: randomUUID() });
    originalState = await operations.loadState(control);
    stage = 'restore';
    result = await runLinuxLiveRestore({
      ...input, control, lock, service, configuration, acceptDataLoss: true,
    });
    lock = undefined;
  }
} catch (error) {
  errors.push(error);
  if (lock && originalState !== undefined) {
    try {
      const { hasUnsettledWorker } = await import('./worker-errors.mjs');
      if (!hasUnsettledWorker(error) && same(await operations.loadState(control), originalState)) {
        await service.check();
        await operations.releaseLock(control, lock);
        lock = undefined;
      }
    } catch (cleanup) { errors.push(cleanup); }
  }
}
try { await service?.close(); }
catch (error) { errors.push(error); }
if (errors.length) {
  process.stderr.write('Saved Linux restore failed. Retain the backup and any lock/evidence; inspect state.json before retrying.\n');
  if (errors.some(error => error?.code === 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED')) {
    process.stderr.write('Export post-backup data before providing explicit --accept-data-loss acknowledgement.\n');
  }
  process.stderr.write(`Restore diagnostic: stage=${stage}\n`);
  const pending = [...errors];
  for (let count = 0; pending.length && count < 8; count++) {
    const failure = pending.shift();
    const code = typeof failure?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(failure.code) ? failure.code : 'UNKNOWN';
    process.stderr.write(`Restore diagnostic: code=${code}\n`);
    if (failure?.cause) pending.push(failure.cause);
    if (failure instanceof AggregateError) pending.push(...failure.errors.slice(0, 8));
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
