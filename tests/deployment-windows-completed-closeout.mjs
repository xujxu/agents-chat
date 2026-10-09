import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [control, pwsh, mode] = process.argv.slice(2);
const saved = name => import(pathToFileURL(path.join(control, 'recovery-engine', name)).href);
const { closeCompletedWindowsDeployment } = await saved('windows-completed-closeout.mjs');
const { acquireLock, releaseLock, reconcileInterruptedOperation } = await saved('state.mjs');
const { verifyRecoveryEngine, retirementRecoveryInvocation } = await saved('saved-recovery-engine.mjs');
const bytes = await readFile(path.join(control, 'state.json'));
const state = JSON.parse(bytes);
const options = { control, pwsh, project: state.project, operationId: state.operationId };
const inventory = async () => new Map(await Promise.all((await readdir(control)).map(async name => {
  const info = await lstat(path.join(control, name), { bigint: true });
  return [name, { dev: info.dev, ino: info.ino }];
})));
const initial = await inventory();
if (mode === 'checkpoint') {
  const { withWindowsAdmission } = await saved('windows-admission.mjs');
  const api = await saved('windows-task-completion-proof.mjs');
  await withWindowsAdmission(control, { pwsh }, async admission => {
    let scope = await api.openWindowsTaskCompletionProof({ control, pwsh, admission });
    try {
      scope = await api.beginWindowsTaskRetirement(control, scope, admission);
      for (let count = 1; count <= 3; count++) {
        const observed = await api.retireNextWindowsTaskFile(control, scope, admission);
        assert.equal(observed.retiredFiles, count);
      }
    } finally { await scope.close(); }
  });
  console.log(JSON.stringify({ retiredFiles: 3 }));
} else if (mode === 'live') {
  await assert.rejects(closeCompletedWindowsDeployment(options), { recoveryAllowed: false });
  assert.deepEqual(await inventory(), initial);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), bytes);
  console.log('PASS: completed closeout refuses the live original controller without changing evidence');
} else {
  const canceled = new AbortController();
  canceled.abort(new Error('Closeout fixture cancellation'));
  for (const change of [{ operationId: randomUUID() }, { project: `${state.project}-foreign` }, { signal: canceled.signal }]) {
    await assert.rejects(closeCompletedWindowsDeployment({ ...options, ...change }), { recoveryAllowed: false });
    assert.deepEqual(await inventory(), initial);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), bytes);
  }
  for (const changed of [
    { phase: 'activation-unverified' },
    { updatedAt: new Date(Date.parse(state.updatedAt) + 1000).toISOString() },
  ]) {
    try {
      await writeFile(path.join(control, 'state.json'), JSON.stringify({ ...state, ...changed }));
      await assert.rejects(closeCompletedWindowsDeployment(options), { recoveryAllowed: false });
      assert.deepEqual(await inventory(), initial);
    } finally { await writeFile(path.join(control, 'state.json'), bytes); }
  }
  if (state.operation === 'restore') {
    const checkpoint = await promisify(execFile)(process.execPath, [
      fileURLToPath(import.meta.url), control, pwsh, 'checkpoint',
    ], {
      cwd: path.dirname(control), timeout: 120000, maxBuffer: 8192,
    });
    assert.equal(checkpoint.stderr, '');
    assert.deepEqual(JSON.parse(checkpoint.stdout), { retiredFiles: 3 });
  }
  const manifest = await readFile(path.join(control, 'recovery-engine', 'manifest.json'));
  const engine = await verifyRecoveryEngine({
    control, manifestSha256: createHash('sha256').update(manifest).digest('hex'),
  });
  const command = retirementRecoveryInvocation(engine, { ...options, kind: 'task' });
  const result = await promisify(execFile)(command.file, command.args, {
    env: command.env, cwd: path.dirname(control), timeout: 120000, maxBuffer: 8192,
  });
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'completed', operationId: state.operationId, phase: state.phase,
  });
  const remaining = await inventory();
  for (const [name, identity] of initial) {
    if (name === 'lock' || name === 'task-maintenance' || name.startsWith('worker-')
      || name.startsWith('task-retirement')) {
      assert.equal(remaining.has(name), false, `Retained completed operation evidence: ${name}`);
    } else {
      assert.deepEqual(remaining.get(name), identity, `Changed unrelated entry: ${name}`);
    }
  }
  assert.deepEqual(await readFile(path.join(control, 'state.json')), bytes);
  assert.equal((await reconcileInterruptedOperation(control)).status, 'idle');
  const lock = await acquireLock(control, { project: state.project, operationId: randomUUID(), pwsh });
  await releaseLock(control, lock, { pwsh });
  console.log('PASS: saved completed closeout composes native proof, task and worker retirement, and unlock without replacing the accepted runtime');
}
