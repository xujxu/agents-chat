import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { verifyRecoveryEngine } from './saved-recovery-engine.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { deploymentDiagnostics } from './deployment-diagnostics.mjs';
import { canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';

const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const within = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
let stage = 'arguments';
let scope;
let lock;
let originalState;
let operations;
let input;
let control;
let result;
const errors = [];
try {
  const [directory, manifestSha256, acknowledgement, ...extra] = process.argv.slice(2);
  if (acknowledgement !== '--accept-data-loss' || extra.length) {
    throw Object.assign(new Error('Explicit data-loss acknowledgement is required.'), {
      code: 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED',
    });
  }
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Saved Windows restore requires native Windows and Node.js 24 or newer.');
  }
  control = directory;
  stage = 'engine-verification';
  const saved = await verifyRecoveryEngine({ control, manifestSha256 });
  if (fileURLToPath(import.meta.url) !== path.join(saved.directory, 'windows-restore-entry.mjs')) {
    throw new Error('Restore must execute from its verified saved engine.');
  }
  stage = 'input';
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32768) throw new Error('Restore input exceeds its bound.');
    chunks.push(chunk);
  }
  input = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
    ['project', 'taskName', 'pwsh', 'backup', 'port', 'waitSeconds', 'timeoutSeconds'], 'saved Windows restore input');
  if (![control, input.project, input.pwsh, input.backup, process.execPath].every(canonical)
    || path.dirname(input.project) === input.project
    || control !== path.join(path.dirname(input.project), `.${path.basename(input.project)}.deployment`)
    || input.backup !== path.join(control, 'backup')
    || within(input.project, input.pwsh) || within(input.project, process.execPath)
    || typeof input.taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(input.taskName)
    || input.port !== 3010
    || ![input.waitSeconds, input.timeoutSeconds].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Saved restore requires matching canonical paths, task identity and positive deadlines.');
  }
  await canonicalWorkerDirectory(input.project);
  await externalWorkerDirectory(control, input.project);
  stage = 'backup-engine-binding';
  try { await lstat(input.backup); }
  catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
    throw Object.assign(new Error('No retained backup is available.', { cause }), { code: 'DEPLOYMENT_BACKUP_MISSING' });
  }
  const { verifySnapshot } = await import('./snapshot.mjs');
  const { runStage } = await import('./stage-runner.mjs');
  const snapshot = await runStage(stage, signal => verifySnapshot(input.backup, { signal }),
    { timeoutMs: Math.min(input.timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER) });
  if (snapshot.version !== 3 || snapshot.scope !== 'project' || snapshot.project !== input.project
    || snapshot.runtime?.platform !== 'win32' || snapshot.runtime.task?.name !== input.taskName
    || snapshot.recoveryEngine !== manifestSha256) {
    throw new Error('Saved backup does not bind this project, task and recovery engine.');
  }
  stage = 'state-admission';
  operations = await import('./state.mjs');
  originalState = await operations.loadState(control);
  if (!originalState || originalState.project !== input.project) throw new Error('Restore control state is unbound.');
  let retirement;
  try {
    retirement = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await readWorkerFile(path.join(control, 'worker-retirement.json'), 1048576, { privateMode: true })));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let coldTerminal = false;
  let coldCompletion = false;
  if (!retirement && originalState.operation === 'restore'
    && ['restoring', 'recovery-required', 'restored'].includes(originalState.phase)) {
    try {
      await lstat(path.join(control, 'cold-restore-terminal.json'));
      coldTerminal = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!coldTerminal && originalState.phase !== 'restored') {
      try {
        await lstat(path.join(control, 'recovery-lock/completion-release-requested.json'));
        coldCompletion = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (retirement?.version === 5 || coldTerminal || coldCompletion) {
    stage = coldCompletion ? 'cold-completion-closeout'
      : coldTerminal ? 'cold-terminal-closeout' : 'cold-retirement-admission';
    const { prepareWindowsColdRetirementCloseout, prepareWindowsColdTerminalCloseout,
      prepareWindowsColdReceiptCloseout, prepareWindowsColdStateCloseout, prepareWindowsColdCompletionCloseout } =
      await import('./windows-cold-retirement-closeout.mjs');
    let prepare = coldCompletion ? prepareWindowsColdCompletionCloseout
      : coldTerminal ? prepareWindowsColdTerminalCloseout : prepareWindowsColdRetirementCloseout;
    if (coldTerminal && originalState.phase !== 'restored') {
      stage = 'cold-state-closeout';
      prepare = prepareWindowsColdStateCloseout;
    } else if (coldTerminal) {
      const { readDeploymentReceipt } = await import('./deployment-receipt.mjs');
      const receipt = await readDeploymentReceipt(control, input.project);
      if (!receipt || receipt.operationId !== originalState.operationId) {
        stage = 'cold-receipt-closeout';
        prepare = prepareWindowsColdReceiptCloseout;
      }
    }
    result = await runStage(stage, signal => prepare({
      control, project: input.project, taskName: input.taskName, snapshot, pwsh: input.pwsh,
      acceptDataLoss: true, signal,
    }), { timeoutMs: Math.min(input.timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER) });
  } else {
    const status = await operations.reconcileInterruptedOperation(control);
    if (!['idle', 'already-current', 'preflight-refused', 'prior-runtime-restored'].includes(status.status)) {
      throw Object.assign(new Error('Interrupted operation requires recovery before live restoration.'), {
        code: 'DEPLOYMENT_RECOVERY_REQUIRED',
      });
    }
    stage = 'runtime-admission';
    const { inspectWindowsManagedTask } = await import('./windows-managed-task.mjs');
    scope = await inspectWindowsManagedTask({ project: input.project, taskName: input.taskName, pwsh: input.pwsh });
    stage = 'lock-admission';
    lock = await operations.acquireLock(control, { project: input.project, operationId: randomUUID(), pwsh: input.pwsh });
    if (!same(await operations.loadState(control), originalState)) throw new Error('Restore state changed during admission.');
    stage = 'restore';
    const { runWindowsLiveRestore } = await import('./windows-restore.mjs');
    result = await runWindowsLiveRestore({
      scope, control, lock, backup: input.backup, node: process.execPath, pwsh: input.pwsh,
      profile: 'agents-chat-auth-638c553', port: input.port, waitSeconds: input.waitSeconds,
      timeoutSeconds: input.timeoutSeconds, acceptDataLoss: true,
      onProgress: ({ phase, stage: restoreStage }) => process.stderr.write(
        `${new Date().toISOString()} Windows restore phase: ${phase}${restoreStage ? ` / ${restoreStage}` : ''}\n`),
    });
    lock = undefined;
  }
} catch (error) {
  errors.push(error);
  if (lock && !hasUnsettledWorker(error)) {
    try {
      if (same(await operations.loadState(control), originalState)) {
        await scope.check({ signal: null });
        await operations.releaseLock(control, lock, { pwsh: input.pwsh });
      }
    } catch (cleanup) { errors.push(journalUncertain(cleanup)); }
  }
}
try { await scope?.close(); }
catch (error) { errors.push(journalUncertain(error)); }
if (errors.length) {
  let failure = errors.length === 1 ? errors[0] : journalUncertain(new AggregateError(errors));
  const candidate = result?.closeoutRequired ? result : errors[0];
  const closeout = candidate.closeoutRequired === true && !hasUnsettledWorker(failure)
    && typeof candidate.operationId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(candidate.operationId)
    && typeof candidate.recoveryEngine === 'string' && /^[a-f0-9]{64}$/.test(candidate.recoveryEngine);
  if (candidate.closeoutRequired === true && !closeout) {
    failure = journalUncertain(new Error('Restore closeout binding is invalid.', { cause: failure }));
  }
  const code = typeof failure.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(failure.code)
    ? failure.code : 'DEPLOYMENT_WINDOWS_RESTORE_FAILED';
  const message = 'Saved Windows restore failed; retain backup, lock and recovery evidence.';
  const diagnostics = deploymentDiagnostics(failure, [new URL('./', import.meta.url).href]);
  process.stdout.write(`${JSON.stringify({
    status: 'failed', code, message, stage, closeoutRequired: closeout,
    operationId: closeout ? candidate.operationId : null,
    recoveryEngine: closeout ? candidate.recoveryEngine : null,
    diagnostics,
  })}\n`);
  process.stderr.write(`${message} (${code}); stage=${stage}\n`);
  process.stderr.write(`Saved restore diagnostics: ${JSON.stringify(diagnostics)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
