import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, taskName, project, pwsh] = process.argv.slice(2);
const { inspectWindowsInactiveTask, assertWindowsManagedTaskScope } =
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
