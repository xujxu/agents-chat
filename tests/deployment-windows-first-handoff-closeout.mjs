import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// The accepted first-attempt owner exits before closeout; its context lives outside the control directory.
function firstHandoffCloseoutContext(control) {
  return path.join(os.tmpdir(), `agents-chat-first-closeout-${digest(control).slice(0, 16)}.json`);
}

async function unlinkIfPresent(file) {
  try { await unlink(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function runPwsh(pwsh, commands, env) {
  const result = await promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-Command', [
    '$ErrorActionPreference = "Stop"',
    '$service = New-Object -ComObject Schedule.Service; $service.Connect()',
    ...commands,
  ].join('; ')], { timeout: 45000, maxBuffer: 131072, windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(result.stderr, '');
}

const handoffNames = names => names.filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort();

// A fresh public-shaped update of archived stopped history is admitted through the first-attempt handoff and
// driven through the existing inactive transaction to its accepted state with sealed worker evidence; the owner
// then exits, leaving its handoff, lock, task receipts and workers for a distinct closeout actor.
export async function acceptFirstHandoffUpdate({ source, control, pwsh, admission, prepared, state }) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { admitWindowsStoppedHistoryUpdate } = await load('windows-stopped-history-update-admission.mjs');
  const { writeState } = await load('state.mjs');
  const { saveWorkerEngine } = await load('saved-worker-engine.mjs');
  const { createWorkerOperation } = await load('worker-operation.mjs');
  const { saveRecoveryEngine } = await load('saved-recovery-engine.mjs');
  const { prepareWindowsInactiveRuntimeBundle } = await load('windows-runtime-publication.mjs');
  const { inspectWindowsInactiveConfiguration } = await load('windows-configuration.mjs');
  const { createWindowsInactiveTaskSnapshot } = await load('windows-task-snapshot.mjs');
  const {
    beginWindowsInactiveTaskTransaction, rotateWindowsInactiveTaskSnapshot, prepareWindowsInactiveTaskActivation,
    replaceWindowsInactiveTask, startWindowsInactiveTask,
  } = await load('windows-inactive-task-transaction.mjs');
  const { waitWindowsReadiness } = await load('windows-readiness.mjs');
  const { completeWindowsTaskActivation } = await load('windows-task-completion.mjs');
  const stateFile = path.join(control, 'state.json');
  const routed = await admitWindowsStoppedHistoryUpdate({
    project: prepared.project, control, taskName: prepared.observation.taskName, pwsh, admission,
  });
  const owner = routed.lock;
  let workers;
  let transaction;
  let configuration;
  let runtime;
  let healthMode;
  let stateSha256;
  try {
    workers = await createWorkerOperation({
      control, lock: owner,
      saved: await saveWorkerEngine({ control, project: owner.project, operationId: owner.operationId, source }),
    });
    const bundle = await prepareWindowsInactiveRuntimeBundle({
      scope: routed.scope, control, lock: owner, node: process.execPath, pwsh,
      admission: routed.admission, sha256: routed.sha256,
    });
    const written = JSON.parse(await readFile(stateFile));
    assert.equal(written.operation, 'update');
    assert.equal(written.phase, 'preflight');
    const head = await promisify(execFile)('git', ['-C', owner.project, 'rev-parse', 'HEAD'], { timeout: 30000 });
    const sourceCommit = written.sourceCommit ?? head.stdout.trim();
    const stopped = {
      ...written, phase: 'stopped', previousPhase: 'preflight', sourceCommit,
      targetCommit: written.targetCommit ?? 'b'.repeat(40),
    };
    await writeState(control, stopped);
    transaction = await beginWindowsInactiveTaskTransaction({
      scope: routed.scope, control, lock: owner, admission: routed.admission, sha256: routed.sha256,
    });
    await writeState(control, { ...stopped, phase: 'copying', previousPhase: 'stopped' });
    const recovery = await saveRecoveryEngine({ source, control, allowVersionChange: true });
    configuration = await inspectWindowsInactiveConfiguration({
      scope: routed.scope, pwsh, profile: 'agents-chat-auth-638c553',
    });
    const manifest = await createWindowsInactiveTaskSnapshot({
      context: transaction, control, lock: owner, pwsh, destination: path.join(control, 'staging'),
      id: owner.operationId, source: { commit: sourceCommit, provenance: 'observed' },
      recoveryEngine: recovery.manifestSha256, configuration,
    });
    const rotating = { ...stopped, phase: 'rotating', previousPhase: 'copying', backupId: manifest.id };
    await writeState(control, rotating);
    await transaction.check();
    await rotateWindowsInactiveTaskSnapshot({ context: transaction, control, lock: owner });
    let previousPhase = 'rotating';
    for (const phase of ['backup-ready', 'source-selected', 'dependencies', 'building', 'configuring', 'activating']) {
      await writeState(control, { ...rotating, phase, previousPhase });
      await transaction.check();
      previousPhase = phase;
    }
    await configuration.checkFiles();
    await workers.seal();
    await prepareWindowsInactiveTaskActivation({ context: transaction, control, lock: owner, bundle });
    await replaceWindowsInactiveTask({ context: transaction, control, lock: owner });
    const listenerFile = path.join(owner.project, 'listener.json');
    const previousListener = JSON.parse(await readFile(listenerFile, 'utf8'));
    runtime = (await startWindowsInactiveTask({ context: transaction, control, lock: owner })).runtime;
    let listener;
    const deadline = Date.now() + 30000;
    do {
      listener = JSON.parse(await readFile(listenerFile, 'utf8'));
      if (listener.pid !== previousListener.pid) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.notEqual(listener.pid, previousListener.pid);
    const healthFile = path.join(owner.project, 'health-mode');
    healthMode = { file: healthFile, bytes: await readFile(healthFile).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }) };
    await writeFile(healthFile, 'ready');
    assert.equal((await waitWindowsReadiness({
      context: transaction, port: listener.port, providers: configuration.providers, waitSeconds: 30,
    })).status, 'ready');
    const completion = await completeWindowsTaskActivation({
      context: transaction, port: listener.port, providers: configuration.providers, waitSeconds: 30,
      async recordAcceptance() {
        await writeState(control, {
          ...rotating, phase: 'accepted', previousPhase: 'activating', updatedAt: new Date().toISOString(),
        });
        return digest(await readFile(stateFile));
      },
    });
    assert.equal(completion.status, 'completed');
    stateSha256 = completion.stateSha256;
  } finally {
    const closed = await Promise.allSettled([
      configuration?.close(), transaction ? transaction.close() : routed.scope.close(), workers?.close(),
    ]);
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
  const names = await readdir(control);
  assert.equal(handoffNames(names).length, 3);
  assert.ok(names.includes('lock') && names.includes('task-maintenance') && names.includes('worker-operation.ndjson'));
  await writeFile(firstHandoffCloseoutContext(control), JSON.stringify({
    owner, taskName: prepared.observation.taskName, definition: prepared.observation.definition,
    stateSha256, runtime, handoff: handoffNames(names),
    healthMode: { file: healthMode.file, bytes: healthMode.bytes ? healthMode.bytes.toString('base64') : null },
    originalState: Buffer.from(state).toString('base64'),
  }), { flag: 'wx' });
  console.log('PASS: first-attempt routed update of archived stopped history reaches its accepted inactive transaction with sealed worker evidence and retained handoff for a distinct closeout');
}

// A distinct actor closes the accepted first-attempt operation out through the public closeout, which retires its
// task receipts, workers, handoff records and lock, then restores the archived fixture.
export async function assertFirstHandoffCloseout({ source, control, pwsh, admission }) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { closeCompletedWindowsDeployment } = await load('windows-completed-closeout.mjs');
  const contextFile = firstHandoffCloseoutContext(control);
  const context = JSON.parse(await readFile(contextFile, 'utf8'));
  const stateFile = path.join(control, 'state.json');
  const maintenance = path.join(control, 'task-maintenance');
  try {
    assert.notEqual(await processIdentity(context.owner.pid), context.owner.processIdentity);
    assert.equal(await processIdentity(context.runtime.pid), context.runtime.identity);
    const acceptedBytes = await readFile(stateFile);
    assert.equal(digest(acceptedBytes), context.stateSha256);
    assert.deepEqual(handoffNames(await readdir(control)), context.handoff);
    const closed = await closeCompletedWindowsDeployment({
      control, project: context.owner.project, operationId: context.owner.operationId, pwsh, admission,
    });
    assert.equal(closed.status, 'completed');
    assert.equal(closed.operationId, context.owner.operationId);
    const names = await readdir(control);
    assert.deepEqual(handoffNames(names), []);
    for (const name of ['lock', 'task-maintenance', 'worker-engine', 'worker-operation.ndjson',
      'task-retirement.json', 'task-retirement-checkpoint.json', 'worker-retirement.json']) {
      assert.equal(names.includes(name), false, name);
    }
    assert.deepEqual(await readFile(stateFile), acceptedBytes);
    assert.equal(await processIdentity(context.runtime.pid), context.runtime.identity);
  } finally {
    // Restore the archived fixture: stop the accepted runtime and re-register the inhibited original definition.
    await runPwsh(pwsh, [
      '$task = $service.GetFolder("\\").GetTask($env:AGENTS_CHAT_TASK_NAME); $task.Enabled = $false; $task.Stop(0)',
    ], { AGENTS_CHAT_TASK_NAME: context.taskName });
    const deadline = Date.now() + 30000;
    while (await processIdentity(context.runtime.pid) === context.runtime.identity && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.notEqual(await processIdentity(context.runtime.pid), context.runtime.identity);
    await runPwsh(pwsh, [
      '$folder = $service.GetFolder("\\"); $task = $folder.GetTask($env:AGENTS_CHAT_TASK_NAME)',
      '$principal = $task.Definition.Principal',
      '$null = $folder.RegisterTask($env:AGENTS_CHAT_TASK_NAME, $env:AGENTS_CHAT_TASK_XML, (4 -bor 16 -bor 32), [string]$principal.UserId, $null, [int]$principal.LogonType, $null)',
      '$restored = $folder.GetTask($env:AGENTS_CHAT_TASK_NAME); $restored.Enabled = $false',
      'if ($folder.GetTask($env:AGENTS_CHAT_TASK_NAME).Enabled) { throw "Restored task is enabled." }',
    ], { AGENTS_CHAT_TASK_NAME: context.taskName, AGENTS_CHAT_TASK_XML: context.definition });
    if (context.healthMode.bytes !== null) await writeFile(context.healthMode.file, Buffer.from(context.healthMode.bytes, 'base64'));
    else await unlinkIfPresent(context.healthMode.file);
    // An unfinished closeout leaves its evidence; remove it so the archive assertions observe the original fixture.
    for (const name of [...context.handoff, 'task-retirement.json', 'task-retirement-checkpoint.json',
      'worker-retirement.json', 'worker-operation.ndjson']) {
      await unlinkIfPresent(path.join(control, name));
    }
    for (const name of [maintenance, path.join(control, 'lock'), path.join(control, 'worker-engine'),
      path.join(control, `runtime-${context.owner.operationId}`)]) {
      await rm(name, { recursive: true, force: true });
    }
    await writeFile(stateFile, Buffer.from(context.originalState, 'base64'));
    await unlink(contextFile);
  }
  console.log('PASS: public closeout of an accepted first-attempt stopped-history update retires its task receipts workers handoff records and lock through the inactive authority while accepted state and runtime remain exact');
}
