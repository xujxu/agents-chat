import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, control, pwsh] = process.argv.slice(2);
const load = name => import(pathToFileURL(path.join(source, name)).href);
const api = await load('windows-task-completion-recovery.mjs');
const { withWindowsAdmission } = await load('windows-admission.mjs');
const { processIdentity } = await load('process-identity.mjs');
assert.equal(typeof api.openWindowsInactiveLostRuntimeAuthority, 'function',
  'Missing owned inactive lost-runtime transport');
const state = await readFile(path.join(control, 'state.json'));
await withWindowsAdmission(control, { pwsh }, async admission => {
  const options = { control, pwsh, admission };
  await assert.rejects(api.openWindowsInactiveLostRuntimeAuthority({ ...options, admission: {} }));
  await assert.rejects(api.openWindowsInactiveTaskCompletionRecovery(options));
  const scope = await api.openWindowsInactiveLostRuntimeAuthority(options);
  try {
    assert.ok(Object.isFrozen(scope));
    assert.ok(Object.isFrozen(scope.observation));
    assert.ok(Object.isFrozen(scope.observation.runtime));
    assert.equal(scope.observation.status, 'inactive-runtime-lost');
    assert.equal(scope.observation.priorRuntime, 'stopped');
    assert.equal(scope.observation.mutationAuthority, false);
    assert.equal(scope.advance, undefined);
    assert.equal(await processIdentity(scope.identity.pid), scope.identity.processIdentity);
    assert.deepEqual(await scope.check(), scope.observation);
    await assert.rejects(api.openWindowsInactiveLostRuntimeAuthority(options));
    assert.deepEqual(await scope.check(), scope.observation);
  } finally { await scope.close(); }
  assert.notEqual(await processIdentity(scope.identity.pid), scope.identity.processIdentity);
  await assert.rejects(scope.check());
});
assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
console.log('PASS: owned lost-runtime authority rejects substitution and concurrent access without granting completion or changing state');
