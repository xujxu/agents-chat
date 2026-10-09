import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [mode, directory, project, control, taskName, pwsh, git, npmCli] = process.argv.slice(2);
const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)).href);
const { loadState, acquireLock } = await captured('state.mjs');
assert.ok(['update', 'finalize', 'current'].includes(mode));
if (mode === 'finalize') {
  const { verifyRecoveryEngine, retirementRecoveryInvocation } = await captured('saved-recovery-engine.mjs');
  const state = await loadState(control);
  assert.equal(state.phase, 'accepted');
  const manifest = await readFile(path.join(control, 'recovery-engine', 'manifest.json'));
  const engine = await verifyRecoveryEngine({
    control, manifestSha256: createHash('sha256').update(manifest).digest('hex'),
  });
  const command = retirementRecoveryInvocation(engine, { control, project, operationId: state.operationId, pwsh, kind: 'task' });
  const result = await promisify(execFile)(command.file, command.args, {
    cwd: directory, env: command.env, timeout: 180000, maxBuffer: 16384,
  });
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { status: 'completed', operationId: state.operationId, phase: 'accepted' });
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  console.log(result.stdout.trim());
} else {
  const modulePath = path.join(directory, 'scripts/deployment/windows-deployment.mjs');
  assert.ok(await lstat(modulePath).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), 'Missing captured Windows live deployment controller');
  const { runWindowsLiveDeployment } = await captured('windows-deployment.mjs');
  const { inspectWindowsManagedTask } = await captured('windows-managed-task.mjs');
  const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
  let failure;
  try {
    const configuration = JSON.parse(await readFile(scope.observation.configuration, 'utf8'));
    const prior = mode === 'current' ? {
      receipt: await readFile(path.join(control, 'deployment.json')),
      snapshot: await lstat(path.join(control, 'latest'), { bigint: true }),
      inventory: (await readdir(control)).filter(name => name.startsWith('runtime-')).sort(),
    } : null;
    const lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    const result = await runWindowsLiveDeployment({
      scope, control, lock, node: process.execPath, pwsh, git, npmCli,
      environment: configuration.command.environment, port: 3010, deploymentBytes: 2 * 1024 ** 3,
      operation: 'update', noPull: true, waitSeconds: 120, timeoutSeconds: 900,
      onProgress: ({ phase }) => console.error(`Windows live controller: ${phase}`),
    });
    assert.equal(result.status, mode === 'current' ? 'already-current' : 'accepted');
    const state = await loadState(control);
    assert.equal(state.phase, result.status);
    if (prior) {
      await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
      assert.deepEqual(await readFile(path.join(control, 'deployment.json')), prior.receipt);
      const snapshot = await lstat(path.join(control, 'latest'), { bigint: true });
      assert.equal(snapshot.dev, prior.snapshot.dev);
      assert.equal(snapshot.ino, prior.snapshot.ino);
      assert.deepEqual((await readdir(control)).filter(name => name.startsWith('runtime-')).sort(), prior.inventory);
      assert.equal(result.backupCreated, false);
    } else {
      assert.equal(state.backupId, lock.operationId);
      assert.equal(result.backupCreated, true);
      assert.equal(result.closeoutRequired, true);
      assert.equal(JSON.parse(await readFile(path.join(control, 'deployment.json'))).operationId, lock.operationId);
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await scope.close(); }
    catch (error) { throw new AggregateError(failure ? [failure, error] : [error], 'Live fixture observation did not close.'); }
  }
}
