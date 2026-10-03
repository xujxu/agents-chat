import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [control, pwsh, taskName, project, runtimeIdentity, generation] = process.argv.slice(2);
const entry = path.join(control, 'recovery-engine', 'windows-managed-task.mjs');
await assert.doesNotReject(access(entry), 'Missing saved managed-task discovery entry');
const { inspectWindowsManagedTask } = await import(pathToFileURL(entry).href);
const before = (await readdir(control)).sort();
const state = await readFile(path.join(control, 'state.json'));
assert.ok(!before.includes('lock') && !before.includes('task-maintenance'));
const options = { taskName, project, pwsh };
let scope = await inspectWindowsManagedTask(options);
const observed = scope.observation;
try {
  assert.equal(observed.status, 'managed-task-observed');
  assert.equal(observed.runtimeAuthority, false);
  assert.equal(observed.project, project);
  assert.equal(observed.taskName, taskName);
  assert.equal(observed.runtime.identity, runtimeIdentity);
  assert.equal(observed.runtime.generation, generation);
  assert.equal(observed.lease, 'released');
  assert.equal(observed.configuration, path.join(control, 'replacement', 'configuration.json'));
  assert.deepEqual(await scope.check(), observed);
  await assert.rejects(inspectWindowsManagedTask({ ...options, project: `${project}-foreign` }));
} finally { await scope.close(); }
const setEnabled = enabled => promisify(execFile)(pwsh, [
  '-NoProfile', '-NonInteractive', '-File',
  fileURLToPath(new URL('./deployment-windows-managed-task-policy.ps1', import.meta.url)),
  '-TaskName', taskName, '-Enabled', String(enabled),
], { timeout: 30000, maxBuffer: 4096 });
scope = await inspectWindowsManagedTask(options);
try {
  await setEnabled(!observed.enabled);
  await assert.rejects(scope.check(), { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
} finally {
  await setEnabled(observed.enabled);
  await scope.close();
}
scope = await inspectWindowsManagedTask(options);
try { assert.deepEqual(scope.observation, observed); }
finally { await scope.close(); }
assert.deepEqual((await readdir(control)).sort(), before);
assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
console.log('PASS: saved managed-task discovery retains original runtime without retired journals or mutations');
