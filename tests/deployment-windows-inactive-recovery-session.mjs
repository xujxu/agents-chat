import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, control, pwsh, mode = 'inspect'] = process.argv.slice(2);
assert.ok(['inspect', 'advance', 'crash', 'refuse'].includes(mode));
const load = name => import(pathToFileURL(path.join(source, name)).href);
const api = await load('windows-task-completion-recovery.mjs');
const { withWindowsAdmission } = await load('windows-admission.mjs');
const { processIdentity } = await load('process-identity.mjs');
assert.equal(typeof api.openWindowsInactiveTaskCompletionRecovery, 'function',
  'Missing owned inactive completion recovery transport');
if (mode === 'refuse') {
  await withWindowsAdmission(control, { pwsh }, async admission => {
    await assert.rejects(api.openWindowsInactiveTaskCompletionRecovery({ control, pwsh, admission }),
      error => error.code === 'DEPLOYMENT_WINDOWS_COMPLETION_RECOVERY_REFUSED'
        && /inactive-complete-release-requested/.test(error.diagnostic ?? ''));
  });
  console.log('PASS: fresh admission cannot overlap the retained original inactive recovery bridge');
} else {
const directory = path.join(control, 'task-maintenance');
const state = await readFile(path.join(control, 'state.json'));
const originals = await Promise.all((await readdir(directory)).map(async name => {
  const file = path.join(directory, name);
  return { name, bytes: await readFile(file), identity: await stat(file, { bigint: true }) };
}));
await withWindowsAdmission(control, { pwsh }, async admission => {
  const options = { control, pwsh, admission };
  await assert.rejects(api.openWindowsInactiveTaskCompletionRecovery({ ...options, admission: {} }));
  await assert.rejects(api.openWindowsTaskCompletionRecovery(options));
  const scope = await api.openWindowsInactiveTaskCompletionRecovery(options);
  try {
    assert.ok(Object.isFrozen(scope));
    assert.ok(Object.isFrozen(scope.observation));
    assert.ok(Object.isFrozen(scope.observation.runtime));
    assert.equal(scope.observation.status, 'pending');
    assert.equal(scope.observation.lease, 'released');
    assert.equal(await processIdentity(scope.identity.pid), scope.identity.processIdentity);
    assert.deepEqual(await scope.check(), scope.observation);
    await assert.rejects(api.openWindowsInactiveTaskCompletionRecovery(options));
    assert.deepEqual(await scope.check(), scope.observation);
    if (mode === 'advance' || mode === 'crash') {
      const initial = scope.observation;
      const steps = ['release-requested', 'released', 'policy-restore-requested', 'permanent-policy-applied', 'complete'];
      const index = steps.indexOf(initial.step);
      assert.ok(index >= 0 && index < steps.length - 1);
      for (const step of steps.slice(index + 1)) {
        const observed = await scope.advance();
        assert.equal(observed.step, step);
        assert.deepEqual(observed.runtime, initial.runtime);
        assert.equal(observed.stateSha256, initial.stateSha256);
        assert.deepEqual(await scope.check(), observed);
        if (mode === 'crash') {
          assert.equal(step, 'released');
          console.log('INACTIVE_RECOVERY_HELD ' + JSON.stringify({
            step, bridge: scope.identity, admission: admission.identity,
          }));
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
      }
      assert.equal(scope.observation.status, 'complete');
      assert.deepEqual(await scope.advance(), scope.observation);
    }
  } finally { await scope.close(); }
  assert.notEqual(await processIdentity(scope.identity.pid), scope.identity.processIdentity);
  await assert.rejects(scope.check());
});
assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
for (const original of originals) {
  const file = path.join(directory, original.name);
  assert.deepEqual(await readFile(file), original.bytes);
  const identity = await stat(file, { bigint: true });
  assert.equal(identity.dev, original.identity.dev);
  assert.equal(identity.ino, original.identity.ino);
}
console.log(`PASS: owned inactive recovery transport ${mode} preserves original evidence and runtime identity`);
}
