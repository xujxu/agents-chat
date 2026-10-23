import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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
  let restoredBundle;
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
    assert.equal(typeof api.inspectWindowsInactiveRollbackSnapshot, 'function',
      'Missing original-update rollback snapshot binding');
    const inspect = extra => api.inspectWindowsInactiveRollbackSnapshot({ ...options, scope, ...extra });
    await assert.rejects(inspect({ scope: { ...scope } }));
    const binding = await inspect();
    const original = JSON.parse(state);
    assert.equal(binding.mutationAuthority, false);
    assert.equal(binding.snapshot.id, original.backupId);
    assert.equal(binding.snapshot.project, original.project);
    assert.equal(binding.snapshot.source.commit, original.sourceCommit);
    assert.equal(binding.snapshot.runtime.state, 'stopped');
    assert.equal(binding.snapshot.runtime.task.name, scope.observation.taskName);
    assert.notEqual(original.sourceCommit, original.targetCommit);
    assert.ok(binding.runtime, 'Missing verified rollback runtime and destination binding');
    assert.deepEqual(binding.runtime.task, binding.snapshot.runtime.task);
    assert.equal(binding.runtime.configuration.command.cwd, original.project);
    assert.deepEqual(binding.authorizedPaths,
      binding.snapshot.externalFiles.map(file => file.path).sort());
    assert.ok(Object.isFrozen(binding.authorizedPaths));
    assert.ok(binding.runtime.files.some(file => file.name === 'configuration.json'));
    await binding.runtime.check();
    await binding.check();
    assert.equal(typeof api.prepareWindowsInactiveRollbackIntent, 'function',
      'Missing durable inactive rollback intent');
    await assert.rejects(api.prepareWindowsInactiveRollbackIntent({ ...options, scope, acceptDataLoss: false }));
    await assert.rejects(api.prepareWindowsInactiveRollbackIntent({
      ...options, scope: { ...scope }, acceptDataLoss: true,
    }));
    const intent = await api.prepareWindowsInactiveRollbackIntent({ ...options, scope, acceptDataLoss: true });
    assert.equal(intent.file, path.join(control, 'inactive-rollback-intent.json'));
    const intentBytes = await readFile(intent.file);
    const record = JSON.parse(intentBytes);
    assert.equal(record.version, 1);
    assert.equal(record.phase, 'rollback-requested');
    assert.equal(record.operationId, original.operationId);
    assert.equal(record.stateSha256, scope.observation.stateSha256);
    assert.equal(record.completionSha256, scope.observation.completionSha256);
    assert.equal(record.backupId, binding.snapshot.id);
    assert.equal(record.sourceCommit, original.sourceCommit);
    assert.equal(record.priorRuntime, 'stopped');
    assert.equal(record.acceptDataLoss, true);
    assert.deepEqual(await api.prepareWindowsInactiveRollbackIntent({ ...options, scope, acceptDataLoss: true }), intent);
    assert.deepEqual(await readFile(intent.file), intentBytes);
    assert.deepEqual(await scope.check(), scope.observation);
    assert.equal(typeof api.restoreWindowsInactiveRollbackProject, 'function',
      'Missing actual inactive rollback project restoration');
    await assert.rejects(api.restoreWindowsInactiveRollbackProject({ ...options, scope, acceptDataLoss: false }));
    await assert.rejects(api.restoreWindowsInactiveRollbackProject({
      ...options, scope: { ...scope }, acceptDataLoss: true,
    }));
    const relative = path.relative(original.project, binding.runtime.task.configuration);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      const names = (await readdir(original.project, { recursive: true })).sort();
      const files = await Promise.all((await readdir(original.project, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile()).map(async entry => {
          const file = path.join(entry.parentPath, entry.name);
          return [file, await readFile(file)];
        }));
      await assert.rejects(api.restoreWindowsInactiveRollbackProject({ ...options, scope, acceptDataLoss: true }),
        /co-located evidence needs a durable handoff/);
      assert.deepEqual((await readdir(original.project, { recursive: true })).sort(), names);
      for (const [file, bytes] of files) {
        assert.deepEqual(await readFile(file), bytes);
      }
    } else {
      const restored = await api.restoreWindowsInactiveRollbackProject({ ...options, scope, acceptDataLoss: true });
      assert.equal(restored.status, 'project-restored');
      assert.equal(restored.sourceCommit, original.sourceCommit);
      for (const entry of binding.snapshot.entries.filter(entry => entry.kind === 'file')) {
        assert.deepEqual(await readFile(path.join(original.project, entry.path)),
          await readFile(path.join(control, 'backup/files', entry.path)), `Rollback did not restore ${entry.path}`);
      }
      assert.equal(typeof api.restoreWindowsInactiveRollbackExternal, 'function',
        'Missing actual inactive rollback external restoration');
      await assert.rejects(api.restoreWindowsInactiveRollbackExternal({ ...options, scope, acceptDataLoss: false }));
      await assert.rejects(api.restoreWindowsInactiveRollbackExternal({
        ...options, scope: { ...scope }, acceptDataLoss: true,
      }));
      const external = await api.restoreWindowsInactiveRollbackExternal({ ...options, scope, acceptDataLoss: true });
      restoredBundle = external.runtimeBundle;
      assert.equal(external.status, 'external-restored');
      assert.equal(external.runtimeBundle.sha256, binding.runtime.task.configurationSha256);
      assert.notEqual(external.runtimeBundle.configuration, binding.runtime.task.configuration);
      const { inspectWindowsRuntimeRelocation } = await load('windows-runtime-relocation.mjs');
      const relocation = await inspectWindowsRuntimeRelocation({
        project: original.project, backup: path.join(control, 'backup'),
        snapshot: binding.snapshot, runtimeBundle: external.runtimeBundle,
      });
      await relocation.verify();
      for (const file of binding.runtime.files) {
        assert.deepEqual(await readFile(path.join(external.runtimeBundle.directory, file.name)),
          await readFile(file.file), `Rollback did not relocate ${file.name}`);
      }
      assert.deepEqual(await scope.check(), scope.observation);
    }
    assert.deepEqual(await readFile(intent.file), intentBytes);
    assert.deepEqual(await scope.check(), scope.observation);
  } finally { await scope.close(); }
  assert.notEqual(await processIdentity(scope.identity.pid), scope.identity.processIdentity);
  await assert.rejects(scope.check());
  if (restoredBundle) {
    const next = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      const resumed = await api.restoreWindowsInactiveRollbackExternal({
        ...options, scope: next, acceptDataLoss: true,
      });
      assert.equal(resumed.status, 'external-restored');
      assert.deepEqual(resumed.runtimeBundle, restoredBundle);
      assert.deepEqual(await next.check(), next.observation);
    } finally { await next.close(); }
    assert.notEqual(await processIdentity(next.identity.pid), next.identity.processIdentity);
  }
});
assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
console.log('PASS: owned lost-runtime authority rejects substitution and concurrent access without granting completion or changing state');
