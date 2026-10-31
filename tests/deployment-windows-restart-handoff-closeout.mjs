import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// The completed handoff owner exits before closeout; its context lives outside the control directory.
export function restartHandoffCloseoutContext(control) {
  return path.join(os.tmpdir(), `agents-chat-handoff-closeout-${createHash('sha256').update(control).digest('hex').slice(0, 16)}.json`);
}

export async function publishRestartHandoffCloseout(control, context) {
  await writeFile(restartHandoffCloseoutContext(control), JSON.stringify(context), { flag: 'wx' });
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

export async function assertRestartHandoffCloseout({ source, control, pwsh, admission, stage }) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const contextFile = restartHandoffCloseoutContext(control);
  const context = JSON.parse(await readFile(contextFile, 'utf8'));
  const stateFile = path.join(control, 'state.json');
  const maintenance = path.join(control, 'task-maintenance');
  const handoffEvidence = async () => (await readdir(control))
    .filter(name => /^(inactive-handoff-|retired-)/i.test(name)).sort();
  const {
    openWindowsInactiveTaskCompletionProof, openWindowsTaskCompletionProof,
    prepareWindowsInactiveTaskRetirement, prepareWindowsInactiveTaskRetirementCheckpoint,
    openWindowsInactiveTaskRetirement, openWindowsTaskRetirement, retireNextWindowsTaskFile,
    beginWindowsDeploymentRetirement,
  } = await load('windows-task-completion-proof.mjs');
  assert.notEqual(await processIdentity(context.owner.pid), context.owner.processIdentity);
  assert.equal(await processIdentity(context.runtime.pid), context.runtime.identity);
  assert.equal(createHash('sha256').update(await readFile(stateFile)).digest('hex'), context.stateSha256);
  const evidence = await handoffEvidence();
  if (stage === 'proof') {
    // After its owner exits, the completed handoff operation is observable through the inactive completion proof.
    await assert.rejects(openWindowsTaskCompletionProof({ control, pwsh, admission }), /Completed-task proof unavailable/);
    const proof = await openWindowsInactiveTaskCompletionProof({ control, pwsh, admission });
    try {
      assert.equal(proof.observation.status, 'observed');
      assert.equal(proof.observation.mutationAuthority, false);
      assert.equal(proof.observation.lease, 'released');
      assert.equal(proof.observation.operationId, context.owner.operationId);
      assert.equal(proof.observation.taskName, context.taskName);
      assert.equal(proof.observation.stateSha256, context.stateSha256);
      assert.equal(proof.observation.runtime.identity, context.runtime.identity);
      assert.deepEqual(await proof.check(), proof.observation);
      // The completed handoff operation prepares its exact inactive retirement intent and checkpoint.
      await assert.rejects(prepareWindowsInactiveTaskRetirement(control, { ...proof }, admission));
      const retirement = await prepareWindowsInactiveTaskRetirement(control, proof, admission);
      assert.equal(retirement.intent.version, 2);
      assert.deepEqual(retirement.intent.completion, proof.observation);
      assert.deepEqual(retirement.intent.files.map(file => file.path).sort(),
        (await readdir(maintenance)).map(name => `task-maintenance\\${name}`).sort());
      assert.equal(retirement.intent.files[0].path, 'task-maintenance\\admission.json');
      assert.equal(retirement.intent.files.at(-1).path, 'task-maintenance\\inactive-complete-complete.json');
      assert.deepEqual(await prepareWindowsInactiveTaskRetirement(control, proof, admission), retirement);
      const checkpoint = await prepareWindowsInactiveTaskRetirementCheckpoint(control, proof, admission);
      assert.equal(checkpoint.checkpoint.version, 2);
      assert.deepEqual(checkpoint.intent, retirement);
      assert.equal(checkpoint.checkpoint.priorRuntime.runtime.identity, context.retiredRuntime.identity);
      assert.notEqual(checkpoint.checkpoint.priorRuntime.runtime.generation, context.runtime.generation);
      assert.deepEqual(await prepareWindowsInactiveTaskRetirementCheckpoint(control, proof, admission), checkpoint);
      assert.deepEqual(await proof.check(), proof.observation);
    } finally { await proof.close(); }
    await assert.rejects(proof.check(), /Completed-task proof unavailable/);
    assert.deepEqual(await handoffEvidence(), evidence);
    // The checkpoint preparer exits; a further distinct actor retires the receipts.
    await writeFile(contextFile, JSON.stringify({ ...context, evidence }));
    console.log('PASS: handoff-aware completed operation is observable through the read-only inactive completion proof after its owner exits while the active proof remains refused');
    console.log('PASS: handoff-aware completed operation prepares its exact inactive retirement intent and checkpoint with the archived retired runtime while copied proofs remain refused');
    return;
  }
  assert.equal(stage, 'retire');
  assert.deepEqual(evidence, context.evidence);
  try {
    // A distinct inactive retirement authority retires each exact task receipt while the handoff evidence stays.
    await assert.rejects(openWindowsTaskRetirement({ control, pwsh, admission }), /Completed-task proof unavailable/);
    const task = await openWindowsInactiveTaskRetirement({ control, pwsh, admission });
    try {
      assert.equal(task.observation.retiredFiles, 0);
      const total = task.observation.checkpoint.intent.intent.files.length;
      assert.equal(total, (await readdir(maintenance)).length);
      await assert.rejects(beginWindowsDeploymentRetirement(control, task, admission), /Inactive deployment retirement is not available/);
      await assert.rejects(retireNextWindowsTaskFile(control, { ...task }, admission));
      for (let index = 0; index < total; index++) {
        const next = await retireNextWindowsTaskFile(control, task, admission);
        assert.equal(next.retiredFiles, index + 1);
        assert.deepEqual(await task.check(), next);
        assert.equal((await readdir(maintenance)).length, total - index - 1);
      }
      await assert.rejects(retireNextWindowsTaskFile(control, task, admission));
    } finally { await task.close(); }
    assert.deepEqual(await handoffEvidence(), evidence);
    assert.equal(createHash('sha256').update(await readFile(stateFile)).digest('hex'), context.stateSha256);
  } finally {
    // Restore the archived fixture: stop the completed runtime and re-register the inhibited original definition.
    await runPwsh(pwsh, [
      '$task = $service.GetFolder("\\").GetTask($env:AGENTS_CHAT_TASK_NAME); $task.Enabled = $false; $task.Stop(0)',
    ], { AGENTS_CHAT_TASK_NAME: context.taskName });
    const deadline = Date.now() + 30000;
    while (await processIdentity(context.runtime.pid) === context.runtime.identity && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.notEqual(await processIdentity(context.runtime.pid), context.runtime.identity);
    for (const name of ['task-retirement-checkpoint.json', 'task-retirement.json']) {
      await unlinkIfPresent(path.join(control, name));
    }
    for (const name of await readdir(maintenance)) {
      assert.match(name, /^(admission|inactive-(activation|replacement|start|complete)-[a-z-]+)\.json$/);
      await unlink(path.join(maintenance, name));
    }
    await rmdir(maintenance);
    await runPwsh(pwsh, [
      '$folder = $service.GetFolder("\\"); $task = $folder.GetTask($env:AGENTS_CHAT_TASK_NAME)',
      '$principal = $task.Definition.Principal',
      '$null = $folder.RegisterTask($env:AGENTS_CHAT_TASK_NAME, $env:AGENTS_CHAT_TASK_XML, (4 -bor 16 -bor 32), [string]$principal.UserId, $null, [int]$principal.LogonType, $null)',
      '$restored = $folder.GetTask($env:AGENTS_CHAT_TASK_NAME); $restored.Enabled = $false',
      'if ($folder.GetTask($env:AGENTS_CHAT_TASK_NAME).Enabled) { throw "Restored task is enabled." }',
    ], { AGENTS_CHAT_TASK_NAME: context.taskName, AGENTS_CHAT_TASK_XML: context.definition });
    if (context.healthMode) {
      if (context.healthMode.bytes !== null) await writeFile(context.healthMode.file, Buffer.from(context.healthMode.bytes, 'base64'));
      else await unlinkIfPresent(context.healthMode.file);
    }
    for (const file of context.handoffRecords) await unlink(file);
    await unlink(context.ownerFile);
    await rmdir(context.lockDirectory);
    await writeFile(stateFile, Buffer.from(context.originalState, 'base64'));
    await unlink(contextFile);
  }
  console.log('PASS: handoff-aware completed operation retires each exact task receipt through its distinct inactive retirement authority while handoff evidence and accepted state remain exact');
}
