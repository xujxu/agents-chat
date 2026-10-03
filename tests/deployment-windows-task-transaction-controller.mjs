import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireLock, writeState, releaseLock, reconcileInterruptedOperation } from '../scripts/deployment/state.mjs';
import { stopWindowsTaskTransaction } from '../scripts/deployment/windows-task-transaction.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

const [pwsh, control, project, operation] = process.argv.slice(2);
assert.ok(['update', 'restore'].includes(operation));
const lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async () => {
  const result = await lines.next();
  assert.equal(result.done, false);
  return JSON.parse(result.value);
};
console.log(JSON.stringify({ pid: process.pid, identity: lock.processIdentity, operationId: lock.operationId }));
let admission = await receive();
const makeState = generation => ({
  version: 1, operationId: lock.operationId, project, operation,
  phase: operation === 'restore' ? 'restore-preflight' : 'preflight',
  previousPhase: null, sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
  backupId: null, priorRuntime: 'running', runtimeIdentity: generation,
  startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: null,
});
let state;
if (admission.discoverTask) {
  const { captureManagedAdmission } = await import('./deployment-windows-managed-admission.mjs');
  const captured = await captureManagedAdmission({
    taskName: admission.discoverTask, project, pwsh, control, lock, makeState,
  });
  state = captured.state;
  console.log(JSON.stringify({ phase: 'admitted', ...captured.admission }));
  admission = await receive();
  assert.deepEqual(admission, captured.admission);
} else {
  const record = JSON.parse(await readFile(admission.admission, 'utf8'));
  state = makeState(record.generation);
  await writeState(control, state);
}
const options = { ...admission, pwsh, control, lock };
await assert.rejects(stopWindowsTaskTransaction(options));
state = { ...state, phase: operation === 'restore' ? 'restoring' : 'stopped', previousPhase: state.phase };
await writeState(control, state);
// Preserve the original Node-created file and ACL; expose only a temporary replacement.
const stateFile = path.join(control, 'state.json');
const originalFile = path.join(control, 'state-acl-original.json');
const originalIdentity = await stat(stateFile, { bigint: true });
await rename(stateFile, originalFile);
let replacement = false;
try {
  await writeFile(stateFile, await readFile(originalFile), { flag: 'wx' });
  replacement = true;
  await promisify(execFile)(pwsh, [
    '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./deployment-windows-private-control.ps1', import.meta.url)),
    '-Control', control,
  ], { timeout: 30000, maxBuffer: 4096 });
  await assert.rejects(stopWindowsTaskTransaction(options));
  assert.deepEqual(await readdir(path.dirname(admission.admission)), ['admission.json']);
} finally {
  if (replacement) await unlink(stateFile);
  await rename(originalFile, stateFile);
}
const restoredIdentity = await stat(stateFile, { bigint: true });
assert.equal(restoredIdentity.dev, originalIdentity.dev);
assert.equal(restoredIdentity.ino, originalIdentity.ino);
await assert.rejects(stopWindowsTaskTransaction({ ...options, lock: { ...lock, token: randomUUID() } }));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stateDigest = hash(await readFile(path.join(control, 'state.json')));
const context = await stopWindowsTaskTransaction(options);
const evidenceBytes = await readFile(path.join(path.dirname(admission.admission), 'transaction.json'));
const evidence = JSON.parse(evidenceBytes);
assert.equal(evidence.lockSha256, hash(await readFile(path.join(control, 'lock', 'owner.json'))));
assert.equal(evidence.initialStateSha256, stateDigest);
assert.equal(hash(Buffer.from(evidence.initialState)), stateDigest);
assert.equal(evidence.admissionSha256, admission.sha256);
assert.equal(evidence.operationId, lock.operationId);
for (const phase of ['intent', 'inhibited', 'stop-requested', 'stopped']) {
  const receipt = JSON.parse(await readFile(path.join(path.dirname(admission.admission), `task-stop-${phase}.json`)));
  assert.equal(receipt.version, 2);
  assert.equal(receipt.transactionSha256, hash(evidenceBytes));
}
await context.check();
await assert.rejects(writeFile(path.join(control, 'lock', 'owner.json'), 'changed'));
await context.check();
state = { ...state, phase: operation === 'restore' ? 'restore-activating' : 'copying', previousPhase: state.phase };
await writeState(control, state);
await context.check();
await assert.rejects(releaseLock(control, lock, { pwsh }), /maintenance/i);
assert.equal((await reconcileInterruptedOperation(control)).status, 'blocked');
console.log(JSON.stringify({ phase: 'stopped', bridge: context.identity }));
const { action, configuration, sha256, crashStep } = await receive();
let workerOperation;
if (['activate-complete-retirement', 'activate-complete-recovery'].includes(action)) {
  const source = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
  const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
  await saveRecoveryEngine({ source, control });
  const script = `
    $ErrorActionPreference='Stop'
    @{accountSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Compress
  `;
  const { stdout } = await promisify(execFile)(pwsh,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 30000, maxBuffer: 4096 });
  workerOperation = await createWorkerOperation({ control, lock, saved });
  const result = await workerOperation.run({
    workerId: randomUUID(), runtime: { pwsh, ...JSON.parse(stdout) },
    command: { file: process.execPath, args: ['-e', 'process.stdout.write("worker-settled")'], cwd: project,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) },
  });
  assert.equal(result.stdout, 'worker-settled');
  await workerOperation.seal();
}
if (action === 'exit') process.exit(0);
if (action === 'activate-early') {
  await assert.rejects(context.activate(), { code: 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED' });
} else if (action === 'replace-early') {
  await assert.rejects(context.replace({ configuration, sha256 }), { code: 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED' });
} else if (action === 'retire-refused') {
  await assert.rejects(context.retire(), { code: 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED' });
} else if (['retire', 'replace', 'replace-refused', 'replace-variable', 'replace-argument',
  'activate', 'activate-exit', 'activate-state-change', 'activate-readiness', 'activate-complete', 'activate-complete-changed-state',
  'activate-complete-proof', 'activate-complete-retirement', 'activate-complete-recovery'].includes(action)) {
  if (operation !== 'restore') {
    for (const phase of ['rotating', 'backup-ready', 'source-selected', 'dependencies', 'building', 'configuring', 'activating']) {
      state = { ...state, previousPhase: state.phase, phase };
      await writeState(control, state);
      await context.check();
    }
  }
  await context.retire();
  await context.retire();
  if (['replace-refused', 'replace-variable', 'replace-argument'].includes(action)) {
    await assert.rejects(context.replace({ configuration, sha256: action === 'replace-refused' ? '0'.repeat(64) : sha256 }),
      { code: 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED' });
  } else {
    if (['replace', 'activate', 'activate-exit', 'activate-state-change', 'activate-readiness',
      'activate-complete', 'activate-complete-changed-state', 'activate-complete-proof', 'activate-complete-retirement',
      'activate-complete-recovery'].includes(action)) {
      await context.replace({ configuration, sha256 });
      await context.replace({ configuration, sha256 });
    }
    if (action.startsWith('activate')) {
      const runtime = await context.activate();
      assert.deepEqual(await context.activate(), runtime);
      await context.check();
      console.log(JSON.stringify({ phase: 'activated', runtime }));
      let next = await receive();
      if (action.startsWith('activate-complete')) {
        assert.equal(next.action, 'complete');
        const { completeWindowsTaskActivation } = await import('../scripts/deployment/windows-task-completion.mjs');
        const { readWindowsReadinessEndpoint } = await import('./deployment-windows-readiness-cases.mjs');
        const endpoint = await readWindowsReadinessEndpoint(project);
        await writeFile(path.join(project, 'health-mode'), 'ready');
        const recordAcceptance = async () => {
          state = { ...state, previousPhase: state.phase,
            phase: operation === 'restore' ? 'restored' : 'accepted', updatedAt: new Date().toISOString() };
          if (action.endsWith('changed-state')) state.targetCommit = 'c'.repeat(40);
          await writeState(control, state);
          return hash(await readFile(stateFile));
        };
        const completion = async () => {
          const complete = ['activate-complete-retirement', 'activate-complete-recovery'].includes(action)
            ? (await import('./deployment-windows-task-completion-steps.mjs')).runWindowsTaskCompletionSteps
            : completeWindowsTaskActivation;
          return complete({ context, control, port: endpoint.port, providers: ['admin-login'], recordAcceptance,
            stopAfter: action === 'activate-complete-recovery' ? crashStep : undefined });
        };
        if (action.endsWith('changed-state')) {
          await assert.rejects(completion(), error => error.code === 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED'
            && /completion-state/.test(error.diagnostic));
          console.log(JSON.stringify({ phase: 'closed' }));
          process.exit(0);
        }
        const result = await completion();
        if (action === 'activate-complete-recovery') {
          assert.equal(result.status, 'interrupted');
          console.log(JSON.stringify({ ...result, phase: 'interrupted' }));
          await receive();
          throw new Error('Parent must kill the original actor at the acknowledged completion boundary.');
        }
        await context.check();
        await context.complete({ stateSha256: hash(await readFile(stateFile)) });
        console.log(JSON.stringify({ phase: 'completed' }));
        next = await receive();
      }
      if (action === 'activate-readiness') {
        assert.equal(next.action, 'readiness');
        const { runWindowsReadinessCases } = await import('./deployment-windows-readiness-cases.mjs');
        await runWindowsReadinessCases({ context, runtime, project });
        console.log(JSON.stringify({ phase: 'readiness' }));
        next = await receive();
      }
      if (action === 'activate-exit') {
        assert.equal(next.action, 'exit');
        process.exit(0);
      }
      if (action === 'activate-state-change') {
        assert.equal(next.action, 'changed-state');
        await writeFile(stateFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
        await assert.rejects(context.check(), error => error.code === 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED'
          && /check\/retirement-phase/.test(error.diagnostic));
        console.log(JSON.stringify({ phase: 'closed' }));
        process.exit(0);
      }
      assert.equal(next.action, 'close');
    }
    await context.check();
    await context.close();
  }
} else if (action === 'changed-state') {
  await writeFile(path.join(control, 'state.json'), JSON.stringify({ ...state, operationId: randomUUID() }));
  await assert.rejects(context.check(), { code: 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED' });
} else {
  assert.equal(action, 'close');
  await context.close();
}
await workerOperation?.close();
console.log(JSON.stringify({ phase: 'closed' }));
process.exit(0);
