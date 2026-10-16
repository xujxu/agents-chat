import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, writeFile } from 'node:fs/promises';
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
    await assert.rejects(captureWindowsInactiveTaskAdmission({ ...options, admission: { ...admission } }));
    await assert.rejects(captureWindowsInactiveTaskAdmission({
      ...options, lock: { ...lock, token: randomUUID() },
    }));
    try {
      await writeFile(path.join(control, 'state.json'), JSON.stringify({ ...state, priorRuntime: 'running' }));
      await assert.rejects(captureWindowsInactiveTaskAdmission(options), /original locked stopped preflight/);
      assert.ok(!(await readdir(control)).includes('task-maintenance'));
    } finally { await writeFile(path.join(control, 'state.json'), stateBytes); }
    assert.deepEqual(await admissionScope.check(), admissionScope.observation);
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
    const duplicateScope = await inspectWindowsInactiveTask({ taskName, project, pwsh });
    try {
      await assert.rejects(captureWindowsInactiveTaskAdmission({ ...options, scope: duplicateScope }),
        { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
    } finally { await duplicateScope.close(); }
    const { beginWindowsInactiveTaskTransaction, assertWindowsInactiveTaskSnapshotStage } =
      await import(pathToFileURL(path.join(source, 'windows-inactive-task-transaction.mjs')).href);
    const transactionOptions = { scope: admissionScope, control, lock, ...published };
    await assert.rejects(beginWindowsInactiveTaskTransaction(transactionOptions),
      /stopped-phase transaction/);
    const sourceCommit = 'a'.repeat(40);
    const stoppedState = {
      ...state, phase: 'stopped', previousPhase: 'preflight', sourceCommit, targetCommit: 'b'.repeat(40),
    };
    await writeState(control, stoppedState);
    await assert.rejects(beginWindowsInactiveTaskTransaction({ ...transactionOptions, scope: { ...admissionScope } }));
    const transaction = await beginWindowsInactiveTaskTransaction(transactionOptions);
    try {
      const snapshotOptions = { context: transaction, control, lock, sourceCommit };
      await assert.rejects(assertWindowsInactiveTaskSnapshotStage(snapshotOptions), /copying/);
      await writeState(control, { ...stoppedState, phase: 'copying', previousPhase: 'stopped' });
      const metadata = await assertWindowsInactiveTaskSnapshotStage(snapshotOptions);
      assert.equal(metadata.project, project);
      assert.equal(metadata.sourceCommit, sourceCommit);
      assert.equal(metadata.task.name, taskName);
      assert.equal(Object.hasOwn(metadata.task, 'instanceGuid'), false);
      await assert.rejects(assertWindowsInactiveTaskSnapshotStage({
        ...snapshotOptions, context: { ...transaction },
      }));
      await assert.rejects(assertWindowsInactiveTaskSnapshotStage({
        ...snapshotOptions, sourceCommit: 'c'.repeat(40),
      }));
      await transaction.check();
    } finally { await transaction.close(); }
    await assert.rejects(transaction.check(), /closed/);
    console.log('PASS: inactive transaction consumes original stopped admission and grants only matching copying-stage snapshot metadata');
    assert.deepEqual(await readFile(published.admission), bytes);
  });
} finally {
  await admissionScope.close();
}
await assert.rejects(releaseLock(control, lock, { pwsh }), /maintenance evidence requires explicit runtime recovery/);
assert.deepEqual(JSON.parse(await readFile(path.join(control, 'lock', 'owner.json'))), lock);
console.log('PASS: native inactive admission binds actual stopped lock and state, rejects forged scope and preserves create-only evidence');
