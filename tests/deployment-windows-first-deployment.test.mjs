import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { loginDeploymentFixture } from './deployment-http-fixture.mjs';
import { acquireLock, releaseLock, loadState } from '../scripts/deployment/state.mjs';
import { inspectWindowsManagedTask } from '../scripts/deployment/windows-managed-task.mjs';
import { verifyRecoveryEngine, retirementRecoveryInvocation } from '../scripts/deployment/saved-recovery-engine.mjs';

const execute = promisify(execFile);
const implementation = new URL('../scripts/deployment/windows-first-deployment.mjs', import.meta.url);
const repository = fileURLToPath(new URL('../', import.meta.url));
const observer = fileURLToPath(new URL('./deployment-windows-first-completion-observer.ps1', import.meta.url));
const readOptional = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

test('actual Windows first deployment composes owned build, authenticated data and saved closeout', {
  skip: process.platform !== 'win32' || process.env.DEPLOYMENT_TEST_WINDOWS_FIRST_APPLICATION !== '1',
}, async t => {
  assert.ok(existsSync(implementation), 'Missing first Windows deployment orchestrator');
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'fresh application');
  const control = path.join(root, '.fresh application.deployment');
  const taskName = `Agents-First-Application-${randomUUID()}`;
  const chatId = `first-${randomUUID()}`;
  const pwsh = process.env.DEPLOYMENT_TEST_PWSH;
  const git = process.env.DEPLOYMENT_TEST_GIT;
  const npmCli = process.env.DEPLOYMENT_TEST_NPM_CLI;
  assert.ok(pwsh && git && npmCli, 'Actions must provide the explicit external toolchain.');
  await execute(git, ['-c', `safe.directory=${repository}`, 'clone', '--no-hardlinks', repository, project],
    { timeout: 120000, maxBuffer: 16384 });
  const revision = (await execute(git, ['-C', project, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(path.join(project, '.env'), 'NEXTAUTH_SECRET=first-application-fixture-secret\n'
    + 'NEXTAUTH_URL=http://localhost:3010\nADMIN_USERNAME=fixture\nADMIN_PASSWORD=private-fixture-password\n');
  let scope;
  let runtime;
  let operationId;
  const observe = async mode => JSON.parse((await execute(pwsh, [
    '-NoProfile', '-NonInteractive', '-File', observer, '-TaskName', taskName,
    '-OwnerPid', String(runtime.pid), '-OwnerIdentity', runtime.identity,
    '-Generation', runtime.generation, '-Mode', mode,
  ], { timeout: 90000, maxBuffer: 65536 })).stdout);
  try {
    const actor = fileURLToPath(new URL('./deployment-windows-first-deployment-actor.mjs', import.meta.url));
    const output = await execute(process.execPath, [
      actor, project, control, taskName, pwsh, git, npmCli, revision, chatId,
    ], { timeout: 1800000, maxBuffer: 65536 });
    assert.equal(output.stderr, '');
    const result = JSON.parse(output.stdout);
    assert.equal(result.status, 'accepted');
    assert.equal(result.backupCreated, false);
    assert.equal(result.closeoutRequired, true);
    operationId = result.operationId;
    const state = await readFile(path.join(control, 'state.json'));
    const accepted = JSON.parse(state);
    assert.equal(accepted.phase, 'accepted');
    assert.equal(accepted.operationId, operationId);
    assert.equal(accepted.targetCommit, revision);
    assert.equal(accepted.priorRuntime, 'absent');
    assert.equal(accepted.backupId, null);
    const receipt = await readFile(path.join(control, 'deployment.json'));
    assert.equal(JSON.parse(receipt).identity.source, revision);
    scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
    runtime = scope.observation.runtime;
    const before = await observe('Inspect');
    const api = await loginDeploymentFixture();
    const chat = (await api(`/api/chats?id=${chatId}`)).chat;
    assert.equal(chat.messages[0].content, 'First deployment data survives closeout');
    const engine = await verifyRecoveryEngine({ control, manifestSha256: result.recoveryEngine });
    const command = retirementRecoveryInvocation(engine, { control, project, operationId, pwsh, kind: 'task' });
    const final = await execute(command.file, command.args, {
      cwd: root, env: command.env, timeout: 300000, maxBuffer: 32768,
    });
    assert.equal(final.stderr, '');
    assert.deepEqual(JSON.parse(final.stdout), { status: 'completed', operationId, phase: 'accepted' });
    assert.deepEqual((await scope.check()).runtime, runtime);
    assert.deepEqual((await api(`/api/chats?id=${chatId}`)).chat, chat);
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
    const after = await observe('Inspect');
    assert.equal(after.binding.instanceGuid, before.binding.instanceGuid);
    assert.equal(after.binding.enabled, true);
    assert.equal(after.lease, 'released');
    assert.deepEqual(after.triggers, [{ type: 8, enabled: true }]);
    const names = await readdir(control);
    assert.equal(names.some(name => /^(worker-|first-task-)/.test(name) || ['backup', 'lock'].includes(name)), false);
    assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: result.recoveryEngine }), engine);
    const next = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    await releaseLock(control, next, { pwsh });
  } finally {
    await scope?.close();
    operationId ??= (await loadState(control))?.operationId;
    const directory = operationId && path.join(control, `first-task-${operationId}`);
    const registered = directory && await readOptional(path.join(directory, 'registered.json'));
    runtime ??= directory && (await readOptional(path.join(directory, 'activation-running.json')))?.runtime;
    if (runtime) await observe('Stop');
    if (runtime || registered) {
      await execute(path.join(process.env.SystemRoot, 'System32', 'schtasks.exe'),
        ['/Delete', '/TN', taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
    }
  }
});
