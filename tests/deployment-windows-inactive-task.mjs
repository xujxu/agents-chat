import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const [source, taskName, project, pwsh, control] = process.argv.slice(2);
const { inspectWindowsInactiveTask, assertWindowsManagedTaskScope, captureWindowsInactiveTaskAdmission } =
  await import(pathToFileURL(path.join(source, 'windows-managed-task.mjs')).href);
const scope = await inspectWindowsInactiveTask({ taskName, project, pwsh });
try {
  assert.equal(scope.observation.status, 'inactive-task-observed');
  assert.equal(scope.observation.runtime, null);
  assert.equal(scope.observation.runtimeAuthority, false);
  assert.equal(scope.observation.enabled, false);
  assert.equal(Object.hasOwn(scope.observation.retiredRuntime, 'instanceGuid'), false);
  assert.equal(Object.hasOwn(scope, 'listener'), false);
  assert.deepEqual(await scope.check(), scope.observation);
  await assert.rejects(assertWindowsManagedTaskScope(scope), { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
  assert.deepEqual(await scope.check(), scope.observation);
} finally { await scope.close(); }
await scope.close();
await assert.rejects(scope.check(), { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
console.log('PASS: inactive task Node bridge retains native proof without active runtime or admission authority');

const { acquireLock, writeState, releaseLock } = await import(pathToFileURL(path.join(source, 'state.mjs')).href);
const { withWindowsAdmission } = await import(pathToFileURL(path.join(source, 'windows-admission.mjs')).href);
const { createWindowsInactiveTaskAdmissionRecord } =
  await import(pathToFileURL(path.join(source, 'windows-inactive-task-admission.mjs')).href);
const lock = await acquireLock(control, { project, pwsh, operationId: randomUUID() });
const admissionScope = await inspectWindowsInactiveTask({ taskName, project, pwsh });
try {
  const state = {
    version: 1, operationId: lock.operationId, project, operation: 'update', phase: 'preflight',
    previousPhase: null, sourceCommit: null, targetCommit: null, backupId: null,
    priorRuntime: 'stopped', runtimeIdentity: admissionScope.observation.retiredRuntime.generation,
    startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
  };
  await writeState(control, state);
  const stateBytes = await readFile(path.join(control, 'state.json'));
  const lockBytes = await readFile(path.join(control, 'lock', 'owner.json'));
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const options = { scope: admissionScope, control, lock, admission };
    await assert.rejects(captureWindowsInactiveTaskAdmission({ ...options, scope: { ...admissionScope } }),
      { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
    assert.ok(!(await readdir(control)).includes('task-maintenance'));
    const published = await captureWindowsInactiveTaskAdmission(options);
    const bytes = await readFile(published.admission);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), published.sha256);
    assert.deepEqual(JSON.parse(bytes), createWindowsInactiveTaskAdmissionRecord({
      observation: admissionScope.observation, lock, state,
    }));
    assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
    assert.deepEqual(await readFile(path.join(control, 'lock', 'owner.json')), lockBytes);
    assert.deepEqual(await admissionScope.check(), admissionScope.observation);
    await assert.rejects(captureWindowsInactiveTaskAdmission(options),
      { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
    assert.deepEqual(await readFile(published.admission), bytes);
  });
} finally {
  await admissionScope.close();
  await releaseLock(control, lock, { pwsh });
}
console.log('PASS: native inactive admission binds actual stopped lock and state, rejects forged scope and preserves create-only evidence');
