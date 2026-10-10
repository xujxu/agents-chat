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
import { crashWindowsFirstApplication } from './deployment-windows-first-application-crash.mjs';

const execute = promisify(execFile);
const implementation = new URL('../scripts/deployment/windows-first-deployment.mjs', import.meta.url);
const repository = fileURLToPath(new URL('../', import.meta.url));
const observer = fileURLToPath(new URL('./deployment-windows-first-completion-observer.ps1', import.meta.url));
const readOptional = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

const receiptLoss = process.env.DEPLOYMENT_TEST_WINDOWS_FIRST_RECEIPT_LOSS === '1';
const publicFirst = process.env.DEPLOYMENT_TEST_WINDOWS_FIRST_PUBLIC === '1';
const defaultPolicy = publicFirst || process.env.DEPLOYMENT_TEST_WINDOWS_FIRST_DEFAULT_POLICY === '1';
test(publicFirst
  ? 'actual public Windows first NoTunnel deployment completes default-policy startup, closeout and public update no-op'
  : receiptLoss
  ? 'actual Windows first deployment recovers missing receipt after actor loss, saved closeout and public update no-op'
  : defaultPolicy
  ? 'actual Windows first deployment preserves default Interactive/AtLogOn policy through saved closeout and public update no-op'
  : 'actual Windows first deployment composes owned build, saved closeout and public update no-op', {
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
  await writeFile(path.join(project, '.env.local'), 'NEXTAUTH_SECRET=first-application-fixture-secret\n'
    + 'NEXTAUTH_URL=http://localhost:3010\nADMIN_USERNAME=fixture\nADMIN_PASSWORD=private-fixture-password\n');
  assert.equal((await execute(git, ['-C', project, 'status', '--porcelain=v1', '--untracked-files=normal'])).stdout, '',
    'Fresh application fixture must remain a clean checkout after local configuration.');
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
    const actorOperationId = randomUUID();
    const args = [actor, project, control, taskName, pwsh, git, npmCli, revision, chatId, actorOperationId];
    let result;
    if (publicFirst) {
      const publicDeploy = fileURLToPath(new URL('../scripts/deploy.ps1', import.meta.url));
      const output = await execute(pwsh, [
        '-NoProfile', '-NonInteractive', '-File', publicDeploy,
        '-ProjectDir', project, '-TaskName', taskName, '-Revision', revision,
        '-NoTunnel', '-WaitSeconds', '120', '-TimeoutSeconds', '900', '-Json',
      ], {
        cwd: root, env: {
          ...process.env, PATH: [path.dirname(process.execPath), path.dirname(git), path.dirname(pwsh)].join(path.delimiter),
        }, timeout: 1800000, maxBuffer: 65536,
      });
      result = JSON.parse(output.stdout);
      assert.equal(result.status, 'accepted');
      assert.equal(result.backupCreated, false);
      assert.equal(result.closeoutRequired, false);
      assert.equal(result.closeoutStatus, 'completed');
    } else if (receiptLoss) {
      result = await crashWindowsFirstApplication({ args, control, taskName, pwsh, operationId: actorOperationId });
      assert.equal(result.status, 'actor-terminated-before-receipt');
    } else {
      const output = await execute(process.execPath, args, { timeout: 1800000, maxBuffer: 65536 });
      assert.equal(output.stderr, '');
      result = JSON.parse(output.stdout);
      assert.equal(result.status, 'accepted');
      assert.equal(result.backupCreated, false);
      assert.equal(result.closeoutRequired, true);
    }
    if (!publicFirst) assert.equal(result.operationId, actorOperationId);
    operationId = result.operationId;
    const state = await readFile(path.join(control, 'state.json'));
    const accepted = JSON.parse(state);
    assert.equal(accepted.phase, 'accepted');
    assert.equal(accepted.operationId, operationId);
    assert.equal(accepted.targetCommit, revision);
    assert.equal(accepted.priorRuntime, 'absent');
    assert.equal(accepted.backupId, null);
    let receipt;
    let originalIdentity;
    if (receiptLoss) {
      await assert.rejects(readFile(path.join(control, 'deployment.json')), { code: 'ENOENT' });
      originalIdentity = JSON.parse(await readFile(path.join(control,
        `first-task-${operationId}`, 'completion-prepared.json'))).deploymentIdentity;
      assert.ok(originalIdentity);
      assert.equal(originalIdentity.source, revision);
    } else {
      receipt = await readFile(path.join(control, 'deployment.json'));
      assert.equal(JSON.parse(receipt).identity.source, revision);
    }
    scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
    runtime = scope.observation.runtime;
    const before = await observe('Inspect');
    assert.deepEqual(before.triggers, [{ type: defaultPolicy ? 9 : 8, enabled: true }]);
    assert.match(before.definition, defaultPolicy ? /<LogonType>InteractiveToken<\/LogonType>/
      : /<LogonType>S4U<\/LogonType>/);
    const api = await loginDeploymentFixture();
    if (receiptLoss || publicFirst) {
      assert.equal((await api('/api/chats', { chat: {
        id: chatId, name: 'Surviving first Windows deployment', ts: Date.now(), agentSessions: {},
        messages: [{ id: 'first', type: 'user', content: 'First deployment data survives closeout', ts: Date.now() }],
      } })).ok, true);
    }
    const chat = (await api(`/api/chats?id=${chatId}`)).chat;
    assert.equal(chat.messages[0].content, 'First deployment data survives closeout');
    const engine = await verifyRecoveryEngine({ control, manifestSha256: result.recoveryEngine });
    if (!publicFirst) {
      const command = retirementRecoveryInvocation(engine, { control, project, operationId, pwsh, kind: 'task' });
      const final = await execute(command.file, command.args, {
        cwd: root, env: command.env, timeout: 300000, maxBuffer: 32768,
      });
      assert.equal(final.stderr, '');
      assert.deepEqual(JSON.parse(final.stdout), { status: 'completed', operationId, phase: 'accepted' });
    }
    if (receiptLoss) {
      receipt = await readFile(path.join(control, 'deployment.json'));
      const recovered = JSON.parse(receipt);
      assert.deepEqual(recovered, {
        version: 1, project, operationId, status: 'accepted', acceptedAt: accepted.updatedAt,
        identity: { ...originalIdentity, service: recovered.identity.service },
      });
      assert.match(recovered.identity.service, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual((await scope.check()).runtime, runtime);
    assert.deepEqual((await api(`/api/chats?id=${chatId}`)).chat, chat);
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
    const after = await observe('Inspect');
    assert.equal(after.binding.instanceGuid, before.binding.instanceGuid);
    assert.equal(after.binding.enabled, true);
    assert.equal(after.lease, 'released');
    assert.deepEqual(after.triggers, before.triggers);
    assert.equal(after.definition, before.definition);
    assert.equal(after.binding.principalSid, before.binding.principalSid);
    const names = await readdir(control);
    assert.equal(names.some(name => /^(worker-|first-task-)/.test(name) || ['backup', 'lock'].includes(name)), false);
    assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: result.recoveryEngine }), engine);
    const next = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    await releaseLock(control, next, { pwsh });
    const publicEntry = fileURLToPath(new URL('../scripts/update.ps1', import.meta.url));
    const current = await execute(pwsh, [
      '-NoProfile', '-NonInteractive', '-File', publicEntry,
      '-ProjectDir', project, '-TaskName', taskName, '-Revision', revision,
      '-WaitSeconds', '120', '-TimeoutSeconds', '900', '-Json',
    ], {
      cwd: root, env: {
        ...process.env, PATH: [path.dirname(process.execPath), path.dirname(git), path.dirname(pwsh)].join(path.delimiter),
      }, timeout: 900000, maxBuffer: 32768,
    });
    const currentResult = JSON.parse(current.stdout);
    assert.equal(currentResult.status, 'already-current');
    assert.equal(currentResult.backupCreated, false);
    const currentState = await loadState(control);
    assert.equal(currentState.operationId, currentResult.operationId);
    assert.notEqual(currentState.operationId, operationId);
    assert.equal(currentState.phase, 'already-current');
    assert.equal(currentState.targetCommit, revision);
    assert.deepEqual((await scope.check()).runtime, runtime);
    assert.deepEqual((await api(`/api/chats?id=${chatId}`)).chat, chat);
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
    const afterCurrent = await observe('Inspect');
    assert.equal(afterCurrent.binding.instanceGuid, before.binding.instanceGuid);
    assert.deepEqual(afterCurrent.triggers, before.triggers);
    assert.equal((await readdir(control)).some(name => /^(worker-|first-task-)/.test(name)
      || ['backup', 'lock'].includes(name)), false);
    assert.deepEqual(await readdir(path.join(root, '.fresh application.deployment-controllers')), []);
  } finally {
    await scope?.close();
    try { operationId ??= (await loadState(control))?.operationId; }
    catch (error) {
      if (error.code !== 'ENOENT' || error.path !== control) throw error;
    }
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
