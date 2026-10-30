import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const handoffNames = names => names.filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort();
const archiveNames = names => names.filter(name => /^retired-.+-inactive-rollback-history-(intent|complete)\.json$/i.test(name)).sort();

// The owner actor names the archived fixture; a distinct actor without Windows admission drives the public entry.
function firstHandoffRepeatContext(control) {
  // Actors use the control as TEMP; keep test artifacts beside it so the public update sees only control evidence.
  return path.join(path.dirname(control), `agents-chat-first-repeat-${digest(control).slice(0, 16)}.json`);
}

export async function writeFirstHandoffRepeatContext(control, { project, taskName }) {
  await writeFile(firstHandoffRepeatContext(control), JSON.stringify({ project, taskName }), { flag: 'wx' });
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
  ].join('; ')], { timeout: 45000, maxBuffer: 1048576, windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(result.stderr, '');
  return result.stdout;
}

// Public update of archived stopped history, then a public rollback and a repeat update of the now running task,
// each through the supervised public entry with its own finalization, receipt and retained archive.
export async function assertPublicHandoffRepeatUpdate({ source, control, pwsh }) {
  const contextFile = firstHandoffRepeatContext(control);
  const { project, taskName } = JSON.parse(await readFile(contextFile, 'utf8'));
  const stateFile = path.join(control, 'state.json');
  const receiptFile = path.join(control, 'deployment.json');
  const originalState = await readFile(stateFile);
  const archived = JSON.parse(originalState);
  assert.equal(archived.priorRuntime, 'stopped');
  const before = (await readdir(control)).sort();
  assert.deepEqual(handoffNames(before), []);
  const archive = archiveNames(before);
  assert.equal(archive.length, 2);
  const archiveBytes = await Promise.all(archive.map(name => readFile(path.join(control, name))));
  const where = await promisify(execFile)('where.exe', ['git.exe'], { timeout: 30000 });
  const git = await realpath(where.stdout.split(/\r?\n/)[0].trim());
  const revParse = async revision => (await promisify(execFile)(git, ['-C', project, 'rev-parse', revision],
    { timeout: 30000 })).stdout.trim();
  const originalHead = await revParse('HEAD');
  const main = await revParse('main');
  const parent = await revParse('main~1');
  const forward = originalHead === main ? parent : main;
  const rollback = forward === main ? parent : main;
  assert.notEqual(forward, originalHead);
  const definition = (await runPwsh(pwsh, ['$service.GetFolder("\\").GetTask($env:AGENTS_CHAT_TASK_NAME).Xml'],
    { AGENTS_CHAT_TASK_NAME: taskName })).trim();
  const healthFile = path.join(project, 'health-mode');
  const healthBytes = await readFile(healthFile).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const publicEntry = path.join(source, '..', 'update.ps1');
  const directory = await mkdtemp(path.join(path.dirname(control), 'agents-chat-first-repeat-'));
  const controllerParent = path.join(path.dirname(project), `.${path.basename(project)}.deployment-controllers`);
  assert.equal(control, path.join(path.dirname(project), `.${path.basename(project)}.deployment`));
  const update = async revision => {
    let output;
    try {
      const pending = promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-File', publicEntry,
        '-ProjectDir', project, '-TaskName', taskName, '-Revision', revision,
        '-WaitSeconds', '120', '-TimeoutSeconds', '900', '-Json'], {
        cwd: directory, timeout: 1200000, maxBuffer: 65536, windowsHide: true, env: {
          ...process.env, PATH: [path.dirname(process.execPath), path.dirname(git), path.dirname(pwsh),
            process.env.PATH].join(path.delimiter),
        },
      });
      pending.child.stderr.on('data', chunk => process.stderr.write(chunk));
      output = await pending;
    } catch (error) {
      console.error('Public update failed:', error.stdout, JSON.stringify({
        code: error.code, signal: error.signal, controlEntries: await readdir(control).catch(() => null),
      }));
      throw error;
    }
    const result = JSON.parse(output.stdout);
    assert.equal(result.status, 'accepted', output.stdout);
    assert.equal(result.closeoutRequired, false);
    assert.equal(result.closeoutStatus, 'completed');
    assert.deepEqual(await readdir(controllerParent).catch(() => []), []);
    const names = (await readdir(control)).sort();
    assert.equal(names.includes('lock'), false);
    assert.deepEqual(handoffNames(names), []);
    for (const name of ['task-maintenance', 'worker-engine', 'worker-operation.ndjson', 'task-retirement.json',
      'task-retirement-checkpoint.json', 'worker-retirement.json']) {
      assert.equal(names.includes(name), false, name);
    }
    assert.deepEqual(archiveNames(names), archive);
    for (const [index, name] of archive.entries()) {
      assert.deepEqual(await readFile(path.join(control, name)), archiveBytes[index]);
    }
    const state = JSON.parse(await readFile(stateFile));
    assert.equal(state.operationId, result.operationId);
    assert.equal(state.operation, 'update');
    assert.equal(state.phase, 'accepted');
    assert.equal(state.targetCommit, revision);
    const receipt = JSON.parse(await readFile(receiptFile));
    assert.equal(receipt.operationId, result.operationId);
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.identity.source, revision);
    assert.equal(await revParse('HEAD'), revision);
    return { result, state };
  };
  try {
    await writeFile(healthFile, 'ready');
    const first = await update(forward);
    assert.equal(first.state.priorRuntime, 'stopped');
    const second = await update(rollback);
    assert.equal(second.state.priorRuntime, 'running');
    assert.equal(second.state.sourceCommit, forward);
    assert.equal(second.state.backupId, second.result.operationId);
    const third = await update(forward);
    assert.equal(third.state.priorRuntime, 'running');
    assert.equal(third.state.sourceCommit, rollback);
    assert.notEqual(third.result.operationId, first.result.operationId);
  } finally {
    // Restore the archived fixture: stop the accepted runtime and re-register the inhibited original definition.
    await runPwsh(pwsh, [
      '$task = $service.GetFolder("\\").GetTask($env:AGENTS_CHAT_TASK_NAME); $task.Enabled = $false; $task.Stop(0)',
      '$folder = $service.GetFolder("\\"); $task = $folder.GetTask($env:AGENTS_CHAT_TASK_NAME)',
      '$principal = $task.Definition.Principal',
      '$null = $folder.RegisterTask($env:AGENTS_CHAT_TASK_NAME, $env:AGENTS_CHAT_TASK_XML, (4 -bor 16 -bor 32), [string]$principal.UserId, $null, [int]$principal.LogonType, $null)',
      '$restored = $folder.GetTask($env:AGENTS_CHAT_TASK_NAME); $restored.Enabled = $false',
      'if ($folder.GetTask($env:AGENTS_CHAT_TASK_NAME).Enabled) { throw "Restored task is enabled." }',
    ], { AGENTS_CHAT_TASK_NAME: taskName, AGENTS_CHAT_TASK_XML: definition });
    await promisify(execFile)(git, ['-C', project, 'switch', '--detach', originalHead], { timeout: 30000 });
    if (healthBytes !== null) await writeFile(healthFile, healthBytes);
    else await unlinkIfPresent(healthFile);
    for (const name of await readdir(control)) {
      if (!before.includes(name)) await rm(path.join(control, name), { recursive: true, force: true });
    }
    await rm(controllerParent, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
    await writeFile(stateFile, originalState);
    await unlink(contextFile);
  }
  console.log('PASS: public update of archived stopped history accepts, publishes its receipt and finalizes, then public rollback and repeat updates of the running task accept with fresh receipts while the history archive stays exact');
}
