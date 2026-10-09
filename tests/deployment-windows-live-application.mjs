import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [mode, directory, project, control, taskName, pwsh, git, npmCli, targetCommit] = process.argv.slice(2);
const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)).href);
const { loadState, acquireLock, releaseLock } = await captured('state.mjs');
assert.ok(['update', 'finalize', 'current'].includes(mode));
assert.match(targetCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
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
  const modulePath = path.join(directory, 'scripts/deployment/windows-deployment-command.mjs');
  assert.ok(await lstat(modulePath).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), 'Missing captured Windows deployment command admission');
  const { runWindowsDeploymentCommand } = await captured('windows-deployment-command.mjs');
  const context = { operation: 'update', project, control, taskName, node: process.execPath, pwsh, git, npmCli };
  const beforeRefusal = (await readdir(control)).sort();
  for (const args of [['--wait', '0'], ['--verify'], ['--dry-run']]) {
    await assert.rejects(runWindowsDeploymentCommand({ ...context, args }),
      { code: 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED' });
  }
  assert.deepEqual((await readdir(control)).sort(), beforeRefusal);
  const beforeStatus = await loadState(control);
  const status = await runWindowsDeploymentCommand({ ...context, args: ['--status'] });
  assert.equal(status.status, 'idle');
  assert.equal(status.phase, beforeStatus?.phase ?? null);
  assert.deepEqual(await loadState(control), beforeStatus);
  assert.deepEqual((await readdir(control)).sort(), beforeRefusal);
  if (mode === 'current') {
    const busy = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    try {
      const owner = await readFile(path.join(control, 'lock', 'owner.json'));
      await assert.rejects(runWindowsDeploymentCommand({ ...context, args: ['--revision', targetCommit] }),
        { code: 'DEPLOYMENT_RECOVERY_REQUIRED' });
      assert.deepEqual(await readFile(path.join(control, 'lock', 'owner.json')), owner);
      assert.deepEqual(await loadState(control), beforeStatus);
    } finally {
      await releaseLock(control, busy, { pwsh });
    }
  }
  const prior = mode === 'current' ? {
    receipt: await readFile(path.join(control, 'deployment.json')),
    snapshot: await lstat(path.join(control, 'backup'), { bigint: true }),
    inventory: (await readdir(control)).filter(name => name.startsWith('runtime-')).sort(),
  } : null;
  const result = await runWindowsDeploymentCommand({
    ...context, args: ['--revision', targetCommit, '--wait', '120', '--timeout', '900'],
    onProgress: ({ phase }) => console.error(`${new Date().toISOString()} Windows live controller: ${phase}`),
  });
  assert.equal(result.status, mode === 'current' ? 'already-current' : 'accepted');
  const state = await loadState(control);
  assert.equal(state.operationId, result.operationId);
  assert.equal(state.phase, result.status);
  assert.equal(state.targetCommit, targetCommit);
  assert.equal((await readFile(path.join(project, 'deployment-live-target.txt'), 'utf8')).trim(), 'Actual Windows live target');
  if (prior) {
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), prior.receipt);
    const snapshot = await lstat(path.join(control, 'backup'), { bigint: true });
    assert.equal(snapshot.dev, prior.snapshot.dev);
    assert.equal(snapshot.ino, prior.snapshot.ino);
    assert.deepEqual((await readdir(control)).filter(name => name.startsWith('runtime-')).sort(), prior.inventory);
    assert.equal(result.backupCreated, false);
  } else {
    assert.equal(state.backupId, result.operationId);
    assert.equal(result.backupCreated, true);
    assert.equal(result.closeoutRequired, true);
    assert.notEqual(state.sourceCommit, targetCommit);
    const snapshot = JSON.parse(await readFile(path.join(control, 'backup', 'manifest.json')));
    assert.equal(snapshot.source.commit, state.sourceCommit);
    assert.equal(JSON.parse(await readFile(path.join(control, 'deployment.json'))).operationId, result.operationId);
  }
  console.log(JSON.stringify(result));
}
