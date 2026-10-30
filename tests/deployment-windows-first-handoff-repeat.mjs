import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const handoffNames = names => names.filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort();
const archiveNames = names => names.filter(name => /^retired-.+-inactive-rollback-history-(intent|complete)\.json$/i.test(name)).sort();

// After the accepted first-attempt update was closed out, its retained stopped-history archive is superseded:
// ordinary admission is no longer blocked, a public update takes the running-task path instead of the
// stopped-history handoff, and its refusal before downtime keeps the archive exact.
export async function assertSupersededStoppedHistoryUpdate({ source, control, pwsh, project, taskName }) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { reconcileInterruptedOperation, requireNoServiceMaintenance } = await load('state.mjs');
  const { runWindowsDeploymentCommand } = await load('windows-deployment-command.mjs');
  const stateFile = path.join(control, 'state.json');
  const acceptedBytes = await readFile(stateFile);
  const accepted = JSON.parse(acceptedBytes);
  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.priorRuntime, 'stopped');
  const before = (await readdir(control)).sort();
  const archive = archiveNames(before);
  assert.equal(archive.length, 2);
  assert.ok(archive.every(name => !name.toLowerCase().includes(accepted.operationId.toLowerCase())));
  const archiveBytes = await Promise.all(archive.map(name => readFile(path.join(control, name))));
  const reconciled = await reconcileInterruptedOperation(control);
  assert.equal(reconciled.status, 'idle', JSON.stringify(reconciled));
  assert.equal(reconciled.operationId, accepted.operationId);
  await requireNoServiceMaintenance(control);
  const where = await promisify(execFile)('where.exe', ['git.exe'], { timeout: 30000 });
  const command = {
    project, control, taskName, pwsh, node: process.execPath,
    git: await realpath(where.stdout.split(/\r?\n/)[0].trim()),
    npmCli: await realpath(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  };
  try {
    const refused = await runWindowsDeploymentCommand({ ...command, operation: 'update', args: ['--revision', 'f'.repeat(40)] })
      .then(() => assert.fail('An unresolvable update of the running task must refuse before downtime.'), error => error);
    const names = (await readdir(control)).sort();
    const written = JSON.parse(await readFile(stateFile));
    if (['DEPLOYMENT_RECOVERY_REQUIRED', 'DEPLOYMENT_WINDOWS_HANDOFF_ADMISSION_REFUSED',
      'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED'].includes(refused.code) || refused.handoffRetained
      || written.phase !== 'preflight-refused') {
      console.error(refused, JSON.stringify({ names, written }));
    }
    assert.notEqual(refused.code, 'DEPLOYMENT_RECOVERY_REQUIRED');
    assert.notEqual(refused.code, 'DEPLOYMENT_WINDOWS_HANDOFF_ADMISSION_REFUSED');
    assert.notEqual(refused.code, 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED');
    assert.notEqual(refused.handoffRetained, true);
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
    assert.notEqual(written.operationId, accepted.operationId);
    assert.equal(written.operation, 'update');
    assert.equal(written.phase, 'preflight-refused');
    assert.equal(written.priorRuntime, 'running');
    const refusedStatus = await reconcileInterruptedOperation(control);
    assert.equal(refusedStatus.status, 'preflight-refused', JSON.stringify(refusedStatus));
    await requireNoServiceMaintenance(control);
  } finally {
    for (const name of await readdir(control)) {
      if (!before.includes(name)) await rm(path.join(control, name), { recursive: true, force: true });
    }
    await writeFile(stateFile, acceptedBytes);
  }
  console.log('PASS: closed-out accepted update of archived stopped history supersedes the retained archive so a later public update takes the running-task path and refuses an unresolved target before downtime while the archive stays exact');
}
