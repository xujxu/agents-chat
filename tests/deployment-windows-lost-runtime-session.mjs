import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, control, pwsh, mode = 'complete', crashStep = 'task-restored', terminalCrashStep = ''] = process.argv.slice(2);
const load = name => import(pathToFileURL(path.join(source, name)).href);
const api = await load('windows-task-completion-recovery.mjs');
const { withWindowsAdmission } = await load('windows-admission.mjs');
const { processIdentity } = await load('process-identity.mjs');
assert.equal(typeof api.openWindowsInactiveLostRuntimeAuthority, 'function',
  'Missing owned inactive lost-runtime transport');
const state = await readFile(path.join(control, 'state.json'));
let expectedFinalState = state;
const holdTask = async (scope, step) => {
  if (mode !== 'crash-task' || step !== crashStep) return;
  console.log(`INACTIVE_ROLLBACK_TASK_HELD ${JSON.stringify({ ...scope.identity, step })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
};
const holdTerminal = async (scope, step) => {
  if (step !== terminalCrashStep) return;
  console.log(`INACTIVE_ROLLBACK_TERMINAL_HELD ${JSON.stringify({ ...scope.identity, step })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
};
await withWindowsAdmission(control, { pwsh }, async admission => {
  const options = { control, pwsh, admission };
  if (mode === 'resume-terminal') {
    const retained = new Map();
    for (const name of ['inactive-rollback-terminal.json', 'inactive-rollback-state-intent.json',
      'inactive-rollback-task-intent.json', 'inactive-rollback-task-restored.json',
      'inactive-rollback-files-restored.json']) {
      retained.set(name, await readFile(path.join(control, name)));
    }
    const intent = JSON.parse(retained.get('inactive-rollback-state-intent.json'));
    const record = JSON.parse(retained.get('inactive-rollback-files-restored.json'));
    const wasPublished = terminalCrashStep === 'state-published';
    assert.ok(wasPublished || terminalCrashStep === 'state-staged');
    assert.equal(state.toString('utf8'), wasPublished ? intent.nextState : intent.oldState);
    const inode = await lstat(path.join(control, wasPublished ? 'state.json' : 'state.json.lock'), { bigint: true });
    const scope = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      const publishOptions = { ...options, scope, runtimeBundle: record.runtimeBundle, acceptDataLoss: true };
      const published = await api.publishWindowsInactiveRollbackTerminalState(publishOptions);
      assert.equal(published.status, 'inactive-terminal-state-published');
      assert.deepEqual(await api.publishWindowsInactiveRollbackTerminalState(publishOptions), published);
      expectedFinalState = Buffer.from(intent.nextState);
      assert.deepEqual(await readFile(published.file), expectedFinalState);
      const actual = await lstat(published.file, { bigint: true });
      assert.equal(actual.dev, inode.dev);
      assert.equal(actual.ino, inode.ino);
      await assert.rejects(readFile(path.join(control, 'state.json.lock')), { code: 'ENOENT' });
      for (const [name, bytes] of retained) assert.deepEqual(await readFile(path.join(control, name)), bytes);
      assert.deepEqual(await scope.check(), scope.observation);
      assert.equal(typeof api.prepareWindowsInactiveRollbackCompletionReceipt, 'function',
        'Missing durable stopped rollback completion receipt');
      await assert.rejects(api.prepareWindowsInactiveRollbackCompletionReceipt({
        ...publishOptions, acceptDataLoss: false,
      }));
      await assert.rejects(api.prepareWindowsInactiveRollbackCompletionReceipt({
        ...publishOptions, scope: { ...scope },
      }));
      const complete = await api.prepareWindowsInactiveRollbackCompletionReceipt(publishOptions);
      assert.equal(complete.status, 'inactive-rollback-complete');
      assert.equal(complete.file, path.join(control, 'inactive-rollback-complete.json'));
      const bytes = await readFile(complete.file);
      assert.equal(complete.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(JSON.parse(bytes), {
        version: 1, phase: 'rollback-complete', operationId: scope.observation.operationId,
        stateSha256: published.sha256, priorRuntime: 'stopped', restoredRuntime: 'stopped',
        terminalSha256: createHash('sha256').update(retained.get('inactive-rollback-terminal.json')).digest('hex'),
        stateIntentSha256: createHash('sha256').update(retained.get('inactive-rollback-state-intent.json')).digest('hex'),
        taskReceiptSha256: createHash('sha256').update(retained.get('inactive-rollback-task-restored.json')).digest('hex'),
      });
      assert.deepEqual(await api.prepareWindowsInactiveRollbackCompletionReceipt(publishOptions), complete);
      assert.deepEqual(await readFile(complete.file), bytes);
      assert.deepEqual(await scope.check(), scope.observation);
    } finally { await scope.close(); }
    const receiptBefore = await readFile(path.join(control, 'inactive-rollback-complete.json'));
    const receiptFile = path.join(control, 'inactive-rollback-complete.json');
    const foreignReceipt = Buffer.from(JSON.stringify({ ...JSON.parse(receiptBefore), restoredRuntime: 'running' }));
    await writeFile(receiptFile, foreignReceipt);
    try {
      await assert.rejects(api.openWindowsInactiveLostRuntimeAuthority(options));
      assert.deepEqual(await readFile(receiptFile), foreignReceipt);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedFinalState);
    } finally { await writeFile(receiptFile, receiptBefore); }
    const history = path.join(control, 'task-maintenance');
    const names = (await readdir(history)).sort();
    const entries = [];
    for (const name of names) {
      const file = path.join(history, name);
      const info = await lstat(file, { bigint: true });
      assert.ok(info.isFile());
      const bytes = await readFile(file);
      entries.push({
        path: path.join('task-maintenance', name), dev: String(info.dev), ino: String(info.ino),
        bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    const reopened = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      await api.prepareWindowsInactiveRollbackCompletionReceipt({
        ...options, scope: reopened, runtimeBundle: record.runtimeBundle, acceptDataLoss: true,
      });
      assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-complete.json')), receiptBefore);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedFinalState);
      assert.equal(typeof api.prepareWindowsInactiveRollbackRetirementIntent, 'function',
        'Missing stopped rollback task-history retirement intent');
      const retirementOptions = {
        ...options, scope: reopened, runtimeBundle: record.runtimeBundle, acceptDataLoss: true,
      };
      await assert.rejects(api.prepareWindowsInactiveRollbackRetirementIntent({
        ...retirementOptions, acceptDataLoss: false,
      }));
      await assert.rejects(api.prepareWindowsInactiveRollbackRetirementIntent({
        ...retirementOptions, scope: { ...reopened },
      }));
      const prepared = await api.prepareWindowsInactiveRollbackRetirementIntent(retirementOptions);
      assert.equal(prepared.file, path.join(control, 'inactive-rollback-retirement.json'));
      const preparedBytes = await readFile(prepared.file);
      assert.equal(prepared.sha256, createHash('sha256').update(preparedBytes).digest('hex'));
      const retirement = JSON.parse(preparedBytes);
      assert.equal(retirement.phase, 'task-retirement-prepared');
      assert.equal(retirement.operationId, reopened.observation.operationId);
      assert.equal(retirement.completionSha256, createHash('sha256').update(receiptBefore).digest('hex'));
      assert.equal(retirement.stateSha256, createHash('sha256').update(expectedFinalState).digest('hex'));
      assert.deepEqual(retirement.entries, entries);
      assert.deepEqual(await api.prepareWindowsInactiveRollbackRetirementIntent(retirementOptions), prepared);
      assert.deepEqual(await readFile(prepared.file), preparedBytes);
      assert.deepEqual((await readdir(history)).sort(), names);
      assert.deepEqual(await reopened.check(), reopened.observation);
    } finally { await reopened.close(); }
    const retirementBefore = await readFile(path.join(control, 'inactive-rollback-retirement.json'));
    const retirementScope = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      await api.prepareWindowsInactiveRollbackRetirementIntent({
        ...options, scope: retirementScope, runtimeBundle: record.runtimeBundle, acceptDataLoss: true,
      });
      assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-retirement.json')), retirementBefore);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedFinalState);
    } finally { await retirementScope.close(); }
    assert.equal(typeof api.openWindowsInactiveRollbackRetirement, 'function',
      'Missing independent stopped rollback retirement authority');
    await assert.rejects(api.openWindowsInactiveRollbackRetirement({ ...options, admission: {} }));
    const cleanup = await api.openWindowsInactiveRollbackRetirement(options);
    try {
      assert.ok(Object.isFrozen(cleanup));
      const observed = await cleanup.check();
      assert.equal(observed.status, 'retiring');
      assert.equal(observed.operationId, JSON.parse(expectedFinalState).operationId);
      assert.equal(observed.retiredEntries, 0);
      assert.equal(observed.totalEntries, entries.length);
      assert.equal(observed.stateSha256, createHash('sha256').update(expectedFinalState).digest('hex'));
      assert.equal(observed.completionSha256, createHash('sha256').update(receiptBefore).digest('hex'));
      await assert.rejects(api.openWindowsInactiveRollbackRetirement(options));
      await assert.rejects(api.openWindowsInactiveLostRuntimeAuthority(options));
      assert.deepEqual(await cleanup.check(), observed);
      assert.deepEqual((await readdir(history)).sort(), names);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedFinalState);
      assert.deepEqual(await readFile(receiptFile), receiptBefore);
    } finally { await cleanup.close(); }
    assert.notEqual(await processIdentity(cleanup.identity.pid), cleanup.identity.processIdentity);
    const nextCleanup = await api.openWindowsInactiveRollbackRetirement(options);
    try {
      assert.equal((await nextCleanup.check()).retiredEntries, 0);
      assert.equal(typeof nextCleanup.advance, 'function',
        'Missing identity-bound stopped task history retirement step');
      const advanced = await nextCleanup.advance();
      assert.equal(advanced.status, 'retiring');
      assert.equal(advanced.retiredEntries, 1);
      assert.equal(advanced.totalEntries, entries.length);
      await assert.rejects(readFile(path.join(control, entries[0].path)), { code: 'ENOENT' });
      assert.deepEqual((await readdir(history)).sort(), names.slice(1));
      assert.deepEqual(await nextCleanup.check(), advanced);
    } finally { await nextCleanup.close(); }
    const partial = await api.openWindowsInactiveRollbackRetirement(options);
    try {
      const observed = await partial.check();
      assert.equal(observed.retiredEntries, 1);
      assert.equal(observed.totalEntries, entries.length);
      await assert.rejects(api.openWindowsInactiveRollbackRetirement(options));
      assert.deepEqual(await partial.check(), observed);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedFinalState);
      assert.deepEqual(await readFile(receiptFile), receiptBefore);
      assert.deepEqual((await readdir(history)).sort(), names.slice(1));
    } finally { await partial.close(); }
    assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-retirement.json')), retirementBefore);
    return;
  }
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
      assert.equal(typeof api.stageWindowsInactiveRollbackTerminalState, 'function',
        'Missing stopped rollback terminal state staging');
      const stageOptions = { ...options, scope: reopened, runtimeBundle: record.runtimeBundle, acceptDataLoss: true };
      await assert.rejects(api.stageWindowsInactiveRollbackTerminalState({ ...stageOptions, acceptDataLoss: false }));
      await assert.rejects(api.stageWindowsInactiveRollbackTerminalState({ ...stageOptions, scope: { ...reopened } }));
      const staged = await api.stageWindowsInactiveRollbackTerminalState(stageOptions);
      assert.equal(staged.status, 'inactive-terminal-state-staged');
      assert.equal(staged.file, path.join(control, 'state.json.lock'));
      const stagedBytes = await readFile(staged.file);
      const proposed = JSON.parse(stagedBytes);
      const original = JSON.parse(state);
      assert.deepEqual(proposed, {
        ...original, phase: 'restored', previousPhase: 'accepted', updatedAt: proposed.updatedAt,
      });
      assert.equal(new Date(proposed.updatedAt).toISOString(), proposed.updatedAt);
      assert.ok(Date.parse(proposed.updatedAt) >= Date.parse(original.updatedAt));
      assert.equal(staged.sha256, createHash('sha256').update(stagedBytes).digest('hex'));
      const stateIntent = JSON.parse(await readFile(path.join(control, 'inactive-rollback-state-intent.json')));
      assert.equal(stateIntent.terminalSha256, terminal.sha256);
      assert.equal(stateIntent.oldState, state.toString('utf8'));
      assert.equal(stateIntent.nextState, stagedBytes.toString('utf8'));
      assert.deepEqual(await api.stageWindowsInactiveRollbackTerminalState(stageOptions), staged);
      assert.deepEqual(await readFile(staged.file), stagedBytes);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      assert.deepEqual(await reopened.check(), reopened.observation);
      assert.equal(typeof api.publishWindowsInactiveRollbackTerminalState, 'function',
        'Missing actual stopped rollback terminal state publication');
      await assert.rejects(api.publishWindowsInactiveRollbackTerminalState({ ...stageOptions, acceptDataLoss: false }));
      await assert.rejects(api.publishWindowsInactiveRollbackTerminalState({ ...stageOptions, scope: { ...reopened } }));
      const stageIdentity = await lstat(staged.file, { bigint: true });
      await holdTerminal(reopened, 'state-staged');
      const published = await api.publishWindowsInactiveRollbackTerminalState(stageOptions);
      assert.equal(published.status, 'inactive-terminal-state-published');
      assert.equal(published.file, path.join(control, 'state.json'));
      assert.equal(published.sha256, staged.sha256);
      assert.deepEqual(await readFile(published.file), stagedBytes);
      const publishedIdentity = await lstat(published.file, { bigint: true });
      assert.equal(publishedIdentity.dev, stageIdentity.dev);
      assert.equal(publishedIdentity.ino, stageIdentity.ino);
      await assert.rejects(readFile(staged.file), { code: 'ENOENT' });
      await holdTerminal(reopened, 'state-published');
      assert.deepEqual(await api.publishWindowsInactiveRollbackTerminalState(stageOptions), published);
      const repeatedIdentity = await lstat(published.file, { bigint: true });
      assert.equal(repeatedIdentity.dev, stageIdentity.dev);
      assert.equal(repeatedIdentity.ino, stageIdentity.ino);
      assert.deepEqual(await reopened.check(), reopened.observation);
      expectedFinalState = stagedBytes;
    } finally { await reopened.close(); }
    const finalIdentity = await lstat(path.join(control, 'state.json'), { bigint: true });
    const completed = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      const published = await api.publishWindowsInactiveRollbackTerminalState({
        ...options, scope: completed, runtimeBundle: record.runtimeBundle, acceptDataLoss: true,
      });
      assert.equal(published.status, 'inactive-terminal-state-published');
      assert.deepEqual(await readFile(published.file), expectedFinalState);
      const reopenedIdentity = await lstat(published.file, { bigint: true });
      assert.equal(reopenedIdentity.dev, finalIdentity.dev);
      assert.equal(reopenedIdentity.ino, finalIdentity.ino);
      await assert.rejects(readFile(path.join(control, 'state.json.lock')), { code: 'ENOENT' });
    } finally { await completed.close(); }
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
assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedFinalState);
console.log('PASS: owned lost-runtime rollback rejects foreign authority and preserves only its authorized state outcome');
