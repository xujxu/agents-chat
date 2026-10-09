import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [control, pwsh, mode] = process.argv.slice(2);
const saved = name => import(pathToFileURL(path.join(control, 'recovery-engine', name)).href);
const { closeCompletedWindowsDeployment } = await saved('windows-completed-closeout.mjs');
const { acquireLock, releaseLock, reconcileInterruptedOperation } = await saved('state.mjs');
const bytes = await readFile(path.join(control, 'state.json'));
const state = JSON.parse(bytes);
const options = { control, pwsh, project: state.project, operationId: state.operationId };
const inventory = async () => new Map(await Promise.all((await readdir(control)).map(async name => {
  const info = await lstat(path.join(control, name), { bigint: true });
  return [name, { dev: info.dev, ino: info.ino }];
})));
const initial = await inventory();
if (mode === 'live') {
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
  assert.deepEqual(await closeCompletedWindowsDeployment(options), {
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
