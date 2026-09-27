import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { acquireLock, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

const source = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
const unsafe = error => error.recoveryAllowed === false;

export async function acceptOperation(control, lock, operation = 'deploy') {
  const phases = operation === 'restore' ? ['restore-preflight', 'restoring', 'restore-activating', 'restored']
    : ['preflight', 'source-selected', 'dependencies', 'building', 'configuring', 'activating', 'accepted'];
  let previousPhase = null;
  for (const phase of phases) {
    await writeState(control, {
      version: 1, operationId: lock.operationId, project: lock.project, operation, phase, previousPhase,
      sourceCommit: null, targetCommit: 'a'.repeat(40), backupId: null, priorRuntime: 'absent',
      runtimeIdentity: 'retirement-fixture', startedAt: lock.createdAt,
      updatedAt: new Date().toISOString(), errorCode: null,
    });
    previousPhase = phase;
  }
}

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'control');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
  const operation = await createWorkerOperation({ control, lock, saved });
  t.after(() => operation.close());
  return { project, control, lock, saved, operation };
}

test('retirement requires both sealed workers and matching application acceptance', async t => {
  for (const mode of ['unsealed', 'unaccepted', 'closed']) {
    const f = await fixture(t);
    if (mode !== 'unsealed') await f.operation.seal();
    if (mode !== 'unaccepted') await acceptOperation(f.control, f.lock);
    if (mode === 'closed') await f.operation.close();
    await assert.rejects(f.operation.retire(), unsafe);
    assert.ok((await readdir(f.control)).includes('worker-engine'));
    await assert.rejects(releaseLock(f.control, f.lock), /worker|evidence/);
  }
});

test('accepted or restored live operation retires only worker artifacts and permits next fixed slot', async t => {
  for (const phase of ['deploy', 'restore']) {
    const f = await fixture(t);
    await mkdir(path.join(f.control, 'backup'));
    await writeFile(path.join(f.control, 'backup', 'sentinel'), 'retained full backup');
    await f.operation.seal();
    await acceptOperation(f.control, f.lock, phase);
    const state = await readFile(path.join(f.control, 'state.json'));
    await f.operation.retire();
    assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'lock', 'state.json']);
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained full backup');
    await assert.rejects(f.operation.retire(), unsafe);
    await releaseLock(f.control, f.lock);
    const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
    await saveWorkerEngine({ source, control: f.control, project: f.project, operationId: lock.operationId });
    assert.ok((await readdir(f.control)).includes('worker-engine'));
  }
});

test('retirement intent alone prevents lock release after partial deletion', async t => {
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: randomUUID() });
  await writeFile(path.join(root, 'worker-retirement.json'), '{"partial":');
  await assert.rejects(releaseLock(root, lock), /worker|evidence/);
});

test('unexpected helper file is retained rather than recursively removed', async t => {
  const f = await fixture(t);
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  await writeFile(path.join(f.saved.directory, 'foreign'), 'not owned');
  await assert.rejects(f.operation.retire(), unsafe);
  assert.equal(await readFile(path.join(f.saved.directory, 'foreign'), 'utf8'), 'not owned');
  await assert.rejects(releaseLock(f.control, f.lock), /worker|evidence/);
});
