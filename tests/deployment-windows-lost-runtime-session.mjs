import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, control, pwsh, mode = 'complete', crashStep = 'task-restored'] = process.argv.slice(2);
const load = name => import(pathToFileURL(path.join(source, name)).href);
const api = await load('windows-task-completion-recovery.mjs');
const { withWindowsAdmission } = await load('windows-admission.mjs');
const { processIdentity } = await load('process-identity.mjs');
assert.equal(typeof api.openWindowsInactiveLostRuntimeAuthority, 'function',
  'Missing owned inactive lost-runtime transport');
const state = await readFile(path.join(control, 'state.json'));
const holdTask = async (scope, step) => {
  if (mode !== 'crash-task' || step !== crashStep) return;
  console.log(`INACTIVE_ROLLBACK_TASK_HELD ${JSON.stringify({ ...scope.identity, step })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
};
await withWindowsAdmission(control, { pwsh }, async admission => {
  const options = { control, pwsh, admission };
  if (mode === 'resume-task') {
    const file = path.join(control, 'inactive-rollback-task-restored.json');
    const before = crashStep === 'task-restored' ? await readFile(file) : null;
    if (!before) await assert.rejects(readFile(file), { code: 'ENOENT' });
    const intentFile = path.join(control, 'inactive-rollback-task-intent.json');
    const intentBefore = await readFile(intentFile);
    const record = JSON.parse(await readFile(path.join(control, 'inactive-rollback-files-restored.json')));
    const scope = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      const restored = await api.restoreWindowsInactiveRollbackTask({
        ...options, scope, runtimeBundle: record.runtimeBundle, acceptDataLoss: true,
      });
      assert.equal(restored.status, 'task-restored');
      assert.equal(restored.file, file);
      if (before) assert.deepEqual(await readFile(file), before);
      else assert.equal(JSON.parse(await readFile(file)).phase, 'task-restored');
      assert.deepEqual(await readFile(intentFile), intentBefore);
      assert.deepEqual(await scope.check(), scope.observation);
      assert.equal(typeof api.prepareWindowsInactiveRollbackTerminalIntent, 'function',
        'Missing stopped rollback terminal evidence handoff');
      const terminalOptions = { ...options, scope, runtimeBundle: record.runtimeBundle, acceptDataLoss: true };
      await assert.rejects(api.prepareWindowsInactiveRollbackTerminalIntent({
        ...terminalOptions, acceptDataLoss: false,
      }));
      await assert.rejects(api.prepareWindowsInactiveRollbackTerminalIntent({
        ...terminalOptions, scope: { ...scope },
      }));
      const terminal = await api.prepareWindowsInactiveRollbackTerminalIntent(terminalOptions);
      assert.equal(terminal.file, path.join(control, 'inactive-rollback-terminal.json'));
      const terminalBytes = await readFile(terminal.file);
      const handoff = JSON.parse(terminalBytes);
      assert.equal(handoff.version, 1);
      assert.equal(handoff.phase, 'terminal-prepared');
      assert.equal(handoff.operationId, JSON.parse(state).operationId);
      assert.equal(handoff.stateSha256, scope.observation.stateSha256);
      assert.equal(handoff.oldState, state.toString('utf8'));
      assert.equal(handoff.sourceCommit, JSON.parse(state).sourceCommit);
      assert.equal(handoff.priorRuntime, 'stopped');
      assert.equal(handoff.restoredRuntime, 'stopped');
      assert.equal(handoff.taskReceiptSha256, restored.sha256);
      for (const [key, name] of [
        ['rollbackIntentSha256', 'inactive-rollback-intent.json'],
        ['filesReceiptSha256', 'inactive-rollback-files-restored.json'],
        ['taskIntentSha256', 'inactive-rollback-task-intent.json'],
      ]) {
        assert.equal(handoff[key], createHash('sha256').update(await readFile(path.join(control, name))).digest('hex'));
      }
      assert.equal(handoff.stateIdentity.bytes, state.length);
      assert.deepEqual(handoff.runtimeBundle, record.runtimeBundle);
      assert.deepEqual(await api.prepareWindowsInactiveRollbackTerminalIntent(terminalOptions), terminal);
      assert.deepEqual(await readFile(terminal.file), terminalBytes);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
    } finally { await scope.close(); }
    assert.notEqual(await processIdentity(scope.identity.pid), scope.identity.processIdentity);
    const terminalFile = path.join(control, 'inactive-rollback-terminal.json');
    const terminalBefore = await readFile(terminalFile);
    const reopened = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      const terminal = await api.prepareWindowsInactiveRollbackTerminalIntent({
        ...options, scope: reopened, runtimeBundle: record.runtimeBundle, acceptDataLoss: true,
      });
      assert.equal(terminal.file, terminalFile);
      assert.deepEqual(await readFile(terminalFile), terminalBefore);
    } finally { await reopened.close(); }
    return;
  }
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
      assert.equal(typeof api.prepareWindowsInactiveRollbackFilesReceipt, 'function',
        'Missing durable inactive rollback files-restored receipt');
      const receiptOptions = { ...options, scope, runtimeBundle: external.runtimeBundle, acceptDataLoss: true };
      await assert.rejects(api.prepareWindowsInactiveRollbackFilesReceipt({
        ...receiptOptions, acceptDataLoss: false,
      }));
      await assert.rejects(api.prepareWindowsInactiveRollbackFilesReceipt({
        ...receiptOptions, scope: { ...scope },
      }));
      const changedFile = path.join(original.project, 'package.json');
      const originalBytes = await readFile(changedFile);
      await writeFile(changedFile, Buffer.concat([originalBytes, Buffer.from('\n')]));
      try {
        await assert.rejects(api.prepareWindowsInactiveRollbackFilesReceipt(receiptOptions),
          /Rollback project (inventory|content) differs/);
        await assert.rejects(readFile(path.join(control, 'inactive-rollback-files-restored.json')), { code: 'ENOENT' });
      } finally { await writeFile(changedFile, originalBytes); }
      const receipt = await api.prepareWindowsInactiveRollbackFilesReceipt(receiptOptions);
      assert.equal(receipt.file, path.join(control, 'inactive-rollback-files-restored.json'));
      const receiptBytes = await readFile(receipt.file);
      const completedFiles = JSON.parse(receiptBytes);
      assert.equal(completedFiles.version, 1);
      assert.equal(completedFiles.phase, 'files-restored');
      assert.equal(completedFiles.operationId, original.operationId);
      assert.equal(completedFiles.stateSha256, scope.observation.stateSha256);
      assert.equal(completedFiles.intentSha256, intent.sha256);
      assert.equal(completedFiles.snapshotSha256, record.snapshotSha256);
      assert.equal(completedFiles.sourceCommit, original.sourceCommit);
      assert.equal(completedFiles.priorRuntime, 'stopped');
      assert.deepEqual(completedFiles.runtimeBundle, external.runtimeBundle);
      assert.deepEqual(await api.prepareWindowsInactiveRollbackFilesReceipt(receiptOptions), receipt);
      assert.deepEqual(await readFile(receipt.file), receiptBytes);
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
      const foreign = path.join(restoredBundle.directory, 'foreign-reentry-test.txt');
      await writeFile(foreign, 'untrusted publication', { flag: 'wx' });
      try {
        await assert.rejects(api.restoreWindowsInactiveRollbackExternal({
          ...options, scope: next, acceptDataLoss: true,
        }), /exactly the archived configuration and helpers/);
        assert.equal(await readFile(foreign, 'utf8'), 'untrusted publication');
        assert.deepEqual(await next.check(), next.observation);
      } finally { await unlink(foreign); }
      const resumed = await api.restoreWindowsInactiveRollbackExternal({
        ...options, scope: next, acceptDataLoss: true,
      });
      assert.equal(resumed.status, 'external-restored');
      assert.deepEqual(resumed.runtimeBundle, restoredBundle);
      assert.deepEqual(await next.check(), next.observation);
      assert.equal(typeof api.restoreWindowsInactiveRollbackTask, 'function',
        'Missing actual inactive rollback task policy restoration');
      const taskOptions = { ...options, scope: next, runtimeBundle: restoredBundle, acceptDataLoss: true };
      await assert.rejects(api.restoreWindowsInactiveRollbackTask({ ...taskOptions, acceptDataLoss: false }));
      await assert.rejects(api.restoreWindowsInactiveRollbackTask({ ...taskOptions, scope: { ...next } }));
      assert.equal(typeof api.advanceWindowsInactiveRollbackTask, 'function',
        'Missing deterministic inactive rollback task advancement');
      await assert.rejects(api.advanceWindowsInactiveRollbackTask({ ...taskOptions, acceptDataLoss: false }));
      await assert.rejects(api.advanceWindowsInactiveRollbackTask({ ...taskOptions, scope: { ...next } }));
      const requested = await api.advanceWindowsInactiveRollbackTask(taskOptions);
      assert.equal(requested.step, 'task-restore-requested');
      const taskIntent = path.join(control, 'inactive-rollback-task-intent.json');
      const requestedBytes = await readFile(taskIntent);
      await assert.rejects(readFile(path.join(control, 'inactive-rollback-task-restored.json')), { code: 'ENOENT' });
      await holdTask(next, 'task-restore-requested');
      const registered = await api.advanceWindowsInactiveRollbackTask(taskOptions);
      assert.equal(registered.step, 'task-registered');
      assert.deepEqual(await readFile(taskIntent), requestedBytes);
      await assert.rejects(readFile(path.join(control, 'inactive-rollback-task-restored.json')), { code: 'ENOENT' });
      await holdTask(next, 'task-registered');
      const completed = await api.advanceWindowsInactiveRollbackTask(taskOptions);
      assert.equal(completed.step, 'task-restored');
      const task = await api.restoreWindowsInactiveRollbackTask(taskOptions);
      assert.equal(task.status, 'task-restored');
      assert.equal(task.taskName, next.observation.taskName);
      assert.equal(task.priorRuntime, 'stopped');
      assert.equal(task.file, path.join(control, 'inactive-rollback-task-restored.json'));
      const taskBytes = await readFile(task.file);
      assert.deepEqual(await api.advanceWindowsInactiveRollbackTask(taskOptions), completed);
      assert.deepEqual(await readFile(task.file), taskBytes);
      const taskRecord = JSON.parse(taskBytes);
      assert.equal(taskRecord.phase, 'task-restored');
      assert.deepEqual(taskRecord.runtimeBundle, restoredBundle);
      assert.deepEqual(await api.restoreWindowsInactiveRollbackTask(taskOptions), task);
      assert.deepEqual(await readFile(task.file), taskBytes);
      assert.deepEqual(await next.check(), next.observation);
      await holdTask(next, 'task-restored');
    } finally { await next.close(); }
    assert.notEqual(await processIdentity(next.identity.pid), next.identity.processIdentity);
  }
});
assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
console.log('PASS: owned lost-runtime authority rejects substitution and concurrent access without granting completion or changing state');
