import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, unlink, lstat, rename, mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { holdLockRetirementIntent, holdLockOwnerRetirement, assertLockRetirementIntentAfterDeath } from './deployment-windows-lock-retirement-observation.mjs';
import { holdLockDirectoryRetirement, assertLockDirectoryRetirementAfterDeath } from './deployment-windows-directory-retirement-observation.mjs';
import { holdLockRetirementSettlement, assertLockRetirementSettlementAfterDeath } from './deployment-windows-lock-settlement-observation.mjs';
import { holdSuccessorPrepared, assertSuccessorAfterDeath } from './deployment-windows-successor-observation.mjs';
import { holdSuccessorAbandoned, assertSuccessorAbandonedAfterDeath } from './deployment-windows-successor-abandoned-observation.mjs';
import { assertRestartPreparation } from './deployment-windows-restart-preparation.mjs';
import { assertRestartHandoffCloseout } from './deployment-windows-restart-handoff-closeout.mjs';
import { holdRestartRetirement } from './deployment-windows-restart-retirement-death.mjs';

const [source, control, pwsh, mode = 'complete', crashStep = 'task-restored', terminalCrashStep = ''] = process.argv.slice(2);
const load = name => import(pathToFileURL(path.join(source, name)).href);
const api = await load('windows-task-completion-recovery.mjs');
const { withWindowsAdmission } = await load('windows-admission.mjs');
const { processIdentity } = await load('process-identity.mjs');
assert.equal(typeof api.openWindowsInactiveLostRuntimeAuthority, 'function',
  'Missing owned inactive lost-runtime transport');
// After the dead writer's actual write, the original state is resolvable only through its ninth record.
// The completed handoff owner has exited; this distinct actor closes it out and restores the archived fixture.
const handoffCloseout = mode === 'resume-restart-state-written-history' && terminalCrashStep === 'handoff-closeout';
if (handoffCloseout) {
  await withWindowsAdmission(control, { pwsh }, admission => assertRestartHandoffCloseout({ source, control, pwsh, admission }));
}
let deferredHandoffCloseout = false;
const state = ['resume-restart-state-dead-history', 'resume-restart-state-released-dead-history',
  'resume-restart-state-release-intent-dead-history'].includes(mode)
  ? Buffer.from(JSON.parse(await readFile(path.join(control, JSON.parse(crashStep).restartStateIntent.path))).oldState)
  : await readFile(path.join(control, 'state.json'));
let expectedFinalState = state;
const progress = phase => console.error(`INACTIVE_ROLLBACK_PHASE ${JSON.stringify({
  mode, phase, elapsedMs: Math.round(performance.now()),
})}`);
if (mode === 'resume-project') {
  const proof = JSON.parse(await readFile(path.join(control, 'inactive-copy-crash-fixture.json')));
  assert.equal(proof.phase, 'project-file-copy');
  assert.notEqual(await processIdentity(process.pid), proof.processIdentity);
  assert.notEqual(await processIdentity(proof.bridge.pid), proof.bridge.processIdentity);
  assert.equal(createHash('sha256').update(state).digest('hex'), proof.stateSha256);
  assert.equal(createHash('sha256').update(await readFile(path.join(control, 'backup', 'manifest.json'))).digest('hex'),
    proof.snapshotSha256);
  assert.equal(createHash('sha256').update(await readFile(
    path.join(control, 'inactive-rollback-runtime-released.json'))).digest('hex'), proof.releaseSha256);
  await assert.rejects(lstat(path.join(JSON.parse(state).project, proof.pendingPath)), { code: 'ENOENT' });
}
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
const originalRuntimePaths = async () => {
  const record = JSON.parse(await readFile(path.join(control, 'inactive-rollback-runtime-handoff.json')));
  return [
    { file: record.configuration, sha256: record.configurationSha256 },
    { file: path.join(path.dirname(record.configuration),
      `runtime-${record.runtimeIdentity.replaceAll(':', '-')}.json`), sha256: record.readySha256 },
  ].map((entry, index) => ({ ...entry, saved: path.join(control, `absent-cleanup-runtime-fixture-${index}`) }));
};
const retainOriginalRuntimeAbsence = async () => {
  for (const { file, saved, sha256 } of await originalRuntimePaths()) {
    let missing = false;
    try { await lstat(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing = true;
    }
    if (!missing) {
      await assert.rejects(lstat(saved), { code: 'ENOENT' });
      assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), sha256);
      await rename(file, saved);
    }
    assert.equal(createHash('sha256').update(await readFile(saved)).digest('hex'), sha256);
    await assert.rejects(lstat(file), { code: 'ENOENT' });
  }
};
const restoreOriginalRuntimePaths = async () => {
  for (const { file, saved, sha256 } of await originalRuntimePaths()) {
    await assert.rejects(lstat(file), { code: 'ENOENT' });
    assert.equal(createHash('sha256').update(await readFile(saved)).digest('hex'), sha256);
    await rename(saved, file);
  }
};
const finishWorkers = async options => {
  await retainOriginalRuntimeAbsence();
  const workerFile = path.join(control, 'inactive-rollback-workers.json');
  const before = await readFile(workerFile);
  const record = JSON.parse(before);
  const taskBefore = await readFile(path.join(control, 'inactive-rollback-retirement.json'));
  const stateBefore = await readFile(path.join(control, 'state.json'));
  const receiptBefore = await readFile(path.join(control, 'inactive-rollback-complete.json'));
  const backupBefore = await readFile(path.join(control, 'backup', 'manifest.json'));
  const configurationBefore = await readFile(path.join(control, 'inactive-rollback-runtime', 'configuration.json'));
  const publication = mode === 'resume-worker-publication';
  if (publication) {
    const { closeCompletedWindowsDeployment } = await load('windows-completed-closeout.mjs');
    const accepted = JSON.parse(stateBefore);
    const closeout = { ...options, project: accepted.project, operationId: accepted.operationId };
    await assert.rejects(closeCompletedWindowsDeployment({ ...closeout, operationId: '00000000-0000-0000-0000-000000000000' }));
    await assert.rejects(closeCompletedWindowsDeployment({ ...closeout, project: `${accepted.project}-foreign` }));
    await assert.rejects(closeCompletedWindowsDeployment({ ...closeout, admission: { ...options.admission } }));
    const cancelled = new AbortController();
    cancelled.abort(new Error('Stopped closeout fixture cancellation'));
    await assert.rejects(closeCompletedWindowsDeployment({ ...closeout, signal: cancelled.signal }));
    await assert.rejects(lstat(path.join(control, 'inactive-rollback-retired.json')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(workerFile), before);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBefore);
    const expected = { status: 'completed', operationId: accepted.operationId, phase: 'restored' };
    assert.deepEqual(await closeCompletedWindowsDeployment(closeout), expected,
      'Completed closeout must resume stopped worker retirement after original lock deletion');
    assert.deepEqual(await closeCompletedWindowsDeployment(closeout), expected);
    await options.admission.check();
  }
  const scope = await api.openWindowsInactiveRollbackWorkerRetirement(options);
  try {
    const initial = await scope.check();
    assert.equal(initial.status, publication ? 'retired' : 'retiring-workers');
    assert.equal(initial.retiredEntries, publication ? record.entries.length : 2);
    assert.equal(initial.totalEntries, record.entries.length);
    await assert.rejects(api.openWindowsInactiveRollbackWorkerRetirement(options));
    await assert.rejects(api.openWindowsInactiveRollbackRetirement(options));
    if (!publication) {
      for (let prefix = 3; prefix <= record.entries.length; prefix++) {
        const next = await scope.advance();
        assert.equal(next.status, 'retiring-workers');
        assert.equal(next.retiredEntries, prefix);
        assert.deepEqual(await scope.check(), next);
        await assert.rejects(lstat(path.join(control, record.entries[prefix - 1].path)), { code: 'ENOENT' });
      }
      await assert.rejects(readFile(path.join(control, 'inactive-rollback-retired.json')), { code: 'ENOENT' });
      console.log(`INACTIVE_ROLLBACK_WORKERS_RETIRED_HELD ${JSON.stringify({
        ...scope.identity, prefix: record.entries.length,
      })}`);
      const timer = setInterval(() => {}, 1000);
      try { await new Promise(() => {}); } finally { clearInterval(timer); }
    }
    const complete = await scope.advance();
    assert.equal(complete.status, 'retired');
    assert.deepEqual(await scope.check(), complete);
    assert.deepEqual(await scope.advance(), complete);
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(control, 'worker-engine')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(control, 'task-maintenance')), { code: 'ENOENT' });
  } finally { await scope.close(); }
  const finalFile = path.join(control, 'inactive-rollback-retired.json');
  const finalBefore = await readFile(finalFile);
  const archiveNames = (await readdir(control)).filter(name =>
    name.startsWith('inactive-rollback-') && name.endsWith('.json')).sort();
  let archiveIntent;
  const reopened = await api.openWindowsInactiveRollbackWorkerRetirement(options);
  try {
    assert.equal((await reopened.check()).status, 'retired');
    assert.deepEqual(await reopened.advance(), await reopened.check());
    assert.deepEqual(await readFile(finalFile), finalBefore);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBefore);
    assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-complete.json')), receiptBefore);
    assert.deepEqual(await readFile(path.join(control, 'backup', 'manifest.json')), backupBefore);
    assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-runtime', 'configuration.json')), configurationBefore);
    assert.equal(typeof reopened.prepareHistory, 'function', 'Missing exact stopped-history archival intent');
    archiveIntent = await reopened.prepareHistory();
    assert.equal(archiveIntent.file, path.join(control, 'inactive-rollback-history-intent.json'));
    assert.deepEqual(await reopened.prepareHistory(), archiveIntent);
  } finally { await reopened.close(); }
  const archiveBytes = await readFile(archiveIntent.file);
  assert.equal(createHash('sha256').update(archiveBytes).digest('hex'), archiveIntent.sha256);
  const archive = JSON.parse(archiveBytes);
  assert.equal(archive.phase, 'stopped-history-archive-prepared');
  assert.equal(archive.operationId, JSON.parse(stateBefore).operationId);
  assert.equal(archive.stateSha256, createHash('sha256').update(stateBefore).digest('hex'));
  assert.equal(archive.retiredSha256, createHash('sha256').update(finalBefore).digest('hex'));
  assert.deepEqual(archive.entries.map(entry => entry.path), archiveNames);
  for (const entry of archive.entries) {
    const original = await readFile(path.join(control, entry.path));
    assert.equal(entry.destination, `retired-${archive.operationId}-${entry.path}`);
    assert.equal(entry.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(entry.bytes, original.length);
    await assert.rejects(lstat(path.join(control, entry.destination)), { code: 'ENOENT' });
  }
  const freshHistory = await api.openWindowsInactiveRollbackWorkerRetirement(options);
  try { assert.deepEqual(await freshHistory.prepareHistory(), archiveIntent); }
  finally { await freshHistory.close(); }
  const foreignHistory = path.join(control, 'inactive-rollback-foreign.json');
  await writeFile(foreignHistory, '{}', { flag: 'wx' });
  try {
    const contaminated = await api.openWindowsInactiveRollbackWorkerRetirement(options);
    try { await assert.rejects(contaminated.prepareHistory()); }
    finally { await contaminated.close(); }
  } finally { await unlink(foreignHistory); }
  const collision = path.join(control, archive.entries[0].destination);
  const foreignBytes = Buffer.from('foreign archive destination');
  await writeFile(collision, foreignBytes, { flag: 'wx' });
  try {
    const occupied = await api.openWindowsInactiveRollbackWorkerRetirement(options);
    try { await assert.rejects(occupied.prepareHistory()); }
    finally { await occupied.close(); }
    assert.deepEqual(await readFile(collision), foreignBytes);
  } finally { await unlink(collision); }
  const changedArchive = Buffer.from(JSON.stringify({ ...archive, retiredSha256: '0'.repeat(64) }));
  await writeFile(archiveIntent.file, changedArchive);
  try {
    const changed = await api.openWindowsInactiveRollbackWorkerRetirement(options);
    try { await assert.rejects(changed.prepareHistory()); }
    finally { await changed.close(); }
    assert.deepEqual(await readFile(archiveIntent.file), changedArchive);
  } finally { await writeFile(archiveIntent.file, archiveBytes); }
  assert.deepEqual(await readFile(archiveIntent.file), archiveBytes);
  assert.equal(typeof api.openWindowsInactiveRollbackHistoryArchive, 'function',
    'Missing independent mixed-namespace stopped history verification');
  const mixedEntry = archive.entries[0];
  const moveArgs = ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./deployment-windows-history-archive-entry.ps1', import.meta.url)),
    '-Source', source, '-Control', control, '-Name', mixedEntry.path];
  const moved = await promisify(execFile)(pwsh, moveArgs, { timeout: 60000, maxBuffer: 8192 });
  assert.equal(moved.stderr, '');
  try {
    await assert.rejects(api.openWindowsInactiveRollbackWorkerRetirement(options));
    const mixed = await api.openWindowsInactiveRollbackHistoryArchive(options);
    try {
      assert.equal((await mixed.check()).status, 'retired');
      assert.equal(mixed.advance, undefined);
      assert.equal(mixed.prepareHistory, undefined);
      await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
      await assert.rejects(lstat(path.join(control, mixedEntry.path)), { code: 'ENOENT' });
      assert.equal(createHash('sha256').update(await readFile(path.join(control, mixedEntry.destination))).digest('hex'),
        mixedEntry.sha256);
    } finally { await mixed.close(); }
    assert.deepEqual(await readFile(archiveIntent.file), archiveBytes);
    const duplicate = path.join(control, mixedEntry.path);
    await writeFile(duplicate, await readFile(path.join(control, mixedEntry.destination)), { flag: 'wx' });
    try { await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options)); }
    finally { await unlink(duplicate); }
  } finally {
    const restored = await promisify(execFile)(pwsh, [...moveArgs, '-Restore'], { timeout: 60000, maxBuffer: 8192 });
    assert.equal(restored.stderr, '');
  }
  const nonPrefixArgs = [...moveArgs.slice(0, -1), archive.entries[1].path];
  const nonPrefixMove = await promisify(execFile)(pwsh, nonPrefixArgs, { timeout: 60000, maxBuffer: 8192 });
  assert.equal(nonPrefixMove.stderr, '');
  try { await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options)); }
  finally {
    const restored = await promisify(execFile)(pwsh, [...nonPrefixArgs, '-Restore'], { timeout: 60000, maxBuffer: 8192 });
    assert.equal(restored.stderr, '');
  }
  assert.deepEqual(await readFile(archiveIntent.file), archiveBytes);
  const archived = [];
  assert.equal(typeof api.openWindowsInactiveRollbackHistoryRetirement, 'function',
    'Missing identity-bound ordered native history archival');
  const prematureFinalizer = await api.openWindowsInactiveRollbackHistoryRetirement(options);
  try {
    assert.equal(typeof prematureFinalizer.finalizeHistory, 'function');
    await assert.rejects(prematureFinalizer.finalizeHistory());
  } finally { await prematureFinalizer.close(); }
  assert.deepEqual(await readFile(archiveIntent.file), archiveBytes);
  const prematureCompletion = await api.openWindowsInactiveRollbackHistoryCompletion(options);
  try {
    assert.equal(prematureCompletion.advance, undefined);
    assert.equal(prematureCompletion.finalizeHistory, undefined);
    await assert.rejects(prematureCompletion.completeHistory());
  } finally { await prematureCompletion.close(); }
  await assert.rejects(lstat(path.join(control,
    `retired-${archive.operationId}-inactive-rollback-history-complete.json`)), { code: 'ENOENT' });
  const blockedWriter = await api.openWindowsInactiveRollbackHistoryRetirement(options);
  try {
    await writeFile(collision, foreignBytes, { flag: 'wx' });
    try {
      await assert.rejects(blockedWriter.advance());
      assert.deepEqual(await readFile(collision), foreignBytes);
    } finally { await unlink(collision); }
  } finally { await blockedWriter.close(); }
  assert.equal(createHash('sha256').update(await readFile(path.join(control, mixedEntry.path))).digest('hex'),
    mixedEntry.sha256);
  assert.deepEqual(await readFile(archiveIntent.file), archiveBytes);
  try {
    const archiveWriter = await api.openWindowsInactiveRollbackHistoryRetirement(options);
    try {
      assert.equal(archiveWriter.observation.archivedEntries, 0);
      const first = await archiveWriter.advance();
      archived.push(moveArgs);
      assert.equal(first.archivedEntries, 1);
      assert.equal(first.totalEntries, archive.entries.length);
      assert.equal(first.status, 'archiving');
      assert.deepEqual(await archiveWriter.check(), first);
      await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
      await assert.rejects(lstat(path.join(control, mixedEntry.path)), { code: 'ENOENT' });
    } finally { await archiveWriter.close(); }
    const resumed = await api.openWindowsInactiveRollbackHistoryRetirement(options);
    try {
      assert.equal(resumed.observation.archivedEntries, 1);
      for (let index = 1; index < archive.entries.length; index++) {
        const next = await resumed.advance();
        archived.push([...moveArgs.slice(0, -1), archive.entries[index].path]);
        assert.equal(next.archivedEntries, index + 1);
        assert.equal(next.status, index + 1 === archive.entries.length ? 'archived' : 'archiving');
        assert.deepEqual(await resumed.check(), next);
      }
      assert.deepEqual(await resumed.advance(), resumed.observation);
    } finally { await resumed.close(); }
    await assert.rejects(api.openWindowsInactiveRollbackWorkerRetirement(options));
    const fullyArchived = await api.openWindowsInactiveRollbackHistoryArchive(options);
    try {
      assert.equal((await fullyArchived.check()).status, 'retired');
      assert.equal(fullyArchived.advance, undefined);
      assert.equal(fullyArchived.prepareHistory, undefined);
    } finally { await fullyArchived.close(); }
    const intentArgs = [...moveArgs.slice(0, -1), 'inactive-rollback-history-intent.json',
      '-Intent', '-OperationId', archive.operationId];
    const finalIntentFile = path.join(control, `retired-${archive.operationId}-inactive-rollback-history-intent.json`);
    const blockedFinalizer = await api.openWindowsInactiveRollbackHistoryRetirement(options);
    try {
      await writeFile(finalIntentFile, foreignBytes, { flag: 'wx' });
      try {
        await assert.rejects(blockedFinalizer.finalizeHistory());
        assert.deepEqual(await readFile(finalIntentFile), foreignBytes);
      } finally { await unlink(finalIntentFile); }
    } finally { await blockedFinalizer.close(); }
    assert.deepEqual(await readFile(archiveIntent.file), archiveBytes);
    const finalizer = await api.openWindowsInactiveRollbackHistoryRetirement(options);
    try {
      const finalized = await finalizer.finalizeHistory();
      assert.deepEqual(finalized, {
        file: path.join(control, `retired-${archive.operationId}-inactive-rollback-history-intent.json`),
        sha256: archiveIntent.sha256,
      });
      assert.deepEqual(await finalizer.finalizeHistory(), finalized);
      assert.deepEqual(await finalizer.check(), finalizer.observation);
    } finally { await finalizer.close(); }
    try {
      const { requireNoServiceMaintenance } = await load('state.mjs');
      await assert.rejects(requireNoServiceMaintenance(control));
      const foreignLock = path.join(control, 'lock');
      const foreignOwner = Buffer.from(JSON.stringify({
        project: JSON.parse(stateBefore).project, operationId: randomUUID(), pid: process.pid,
        processIdentity: await processIdentity(process.pid), createdAt: new Date().toISOString(),
      }));
      await mkdir(foreignLock, { mode: 0o700 });
      try {
        await writeFile(path.join(foreignLock, 'owner.json'), foreignOwner, { flag: 'wx', mode: 0o600 });
        const { archiveCompletedWindowsInactiveRollback } = await load('windows-completed-closeout.mjs');
        await assert.rejects(archiveCompletedWindowsInactiveRollback({
          ...options, project: JSON.parse(stateBefore).project, operationId: archive.operationId,
        }));
        assert.deepEqual(await readFile(path.join(foreignLock, 'owner.json')), foreignOwner);
        assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBefore);
      } finally {
        await unlink(path.join(foreignLock, 'owner.json'));
        await rmdir(foreignLock);
      }
      const archivedIntentFile = path.join(control,
        `retired-${archive.operationId}-inactive-rollback-history-intent.json`);
      await writeFile(archiveIntent.file, archiveBytes, { flag: 'wx' });
      try {
        await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
        assert.deepEqual(await readFile(archiveIntent.file), archiveBytes);
        assert.deepEqual(await readFile(archivedIntentFile), archiveBytes);
      } finally { await unlink(archiveIntent.file); }
      await writeFile(archivedIntentFile, changedArchive);
      try {
        await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
        assert.deepEqual(await readFile(archivedIntentFile), changedArchive);
      } finally { await writeFile(archivedIntentFile, archiveBytes); }
      const archivedIntent = await api.openWindowsInactiveRollbackHistoryArchive(options);
      try {
        assert.equal((await archivedIntent.check()).status, 'retired');
        assert.equal(archivedIntent.advance, undefined);
        assert.equal(archivedIntent.prepareHistory, undefined);
        assert.equal(archivedIntent.finalizeHistory, undefined);
      }
      finally { await archivedIntent.close(); }
      await assert.rejects(api.openWindowsInactiveRollbackHistoryRetirement(options));
      assert.deepEqual(await readFile(archivedIntentFile), archiveBytes);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBefore);
    } finally {
      const restored = await promisify(execFile)(pwsh, [...intentArgs, '-Restore'], { timeout: 60000, maxBuffer: 8192 });
      assert.equal(restored.stderr, '');
    }
  } finally {
    for (const args of archived.reverse()) {
      const restored = await promisify(execFile)(pwsh, [...args, '-Restore'], { timeout: 60000, maxBuffer: 8192 });
      assert.equal(restored.stderr, '');
    }
  }
  assert.deepEqual(await readFile(archiveIntent.file), archiveBytes);
  assert.deepEqual(await readFile(workerFile), before);
  assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-retirement.json')), taskBefore);
  await writeFile(finalFile, Buffer.from(JSON.stringify({ ...JSON.parse(finalBefore), restoredRuntime: 'running' })));
  try { await assert.rejects(api.openWindowsInactiveRollbackWorkerRetirement(options)); }
  finally { await writeFile(finalFile, finalBefore); }
  await restoreOriginalRuntimePaths();
};
const drainRetirement = async (options, entries, expectedState, expectedReceipt, retirementBefore) => {
  await retainOriginalRuntimeAbsence();
  const history = path.join(control, 'task-maintenance');
  const names = entries.map(entry => path.basename(entry.path));
  const scope = await api.openWindowsInactiveRollbackRetirement(options);
  try {
    assert.equal((await scope.check()).retiredEntries, 1);
    await assert.rejects(api.openWindowsInactiveRollbackRetirement(options));
    for (let prefix = 2; prefix <= entries.length; prefix++) {
      const advanced = await scope.advance();
      assert.equal(advanced.retiredEntries, prefix);
      assert.deepEqual(await scope.check(), advanced);
      assert.deepEqual((await readdir(history)).sort(), names.slice(prefix));
      await assert.rejects(api.openWindowsInactiveLostRuntimeAuthority(options));
    }
    assert.deepEqual(await scope.advance(), await scope.check());
  } finally { await scope.close(); }
  const empty = await api.openWindowsInactiveRollbackRetirement(options);
  try {
    assert.equal((await empty.check()).retiredEntries, entries.length);
    await assert.rejects(api.openWindowsInactiveRollbackRetirement(options));
    assert.equal(typeof empty.prepareWorkers, 'function', 'Missing stopped rollback worker retirement checkpoint');
    const prepared = await empty.prepareWorkers();
    assert.equal(prepared.file, path.join(control, 'inactive-rollback-workers.json'));
    assert.match(prepared.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await empty.prepareWorkers(), prepared);
    await assert.rejects(api.openWindowsInactiveRollbackWorkerRetirement(options));
  } finally { await empty.close(); }
  await assert.rejects(api.openWindowsInactiveRollbackRetirement(options));
  assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedState);
  assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-complete.json')), expectedReceipt);
  const workerBytes = await readFile(path.join(control, 'inactive-rollback-workers.json'));
  const worker = JSON.parse(workerBytes);
  assert.equal(worker.version, 1);
  assert.equal(worker.phase, 'stopped-worker-retirement-prepared');
  assert.equal(worker.operationId, JSON.parse(expectedState).operationId);
  assert.equal(worker.task.sha256, createHash('sha256').update(retirementBefore).digest('hex'));
  assert.equal(worker.entries[0].path, 'task-maintenance');
  assert.equal(worker.entries.at(-2).path, path.join('lock', 'owner.json'));
  assert.equal(worker.entries.at(-1).path, 'lock');
  assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-retirement.json')), retirementBefore);
  assert.equal(typeof api.openWindowsInactiveRollbackWorkerRetirement, 'function',
    'Missing independent stopped worker cleanup resumption');
  const prematureHistory = await api.openWindowsInactiveRollbackWorkerRetirement(options);
  try {
    assert.equal(typeof prematureHistory.prepareHistory, 'function', 'Missing stopped history retirement guard');
    await assert.rejects(prematureHistory.prepareHistory());
  } finally { await prematureHistory.close(); }
  await assert.rejects(lstat(path.join(control, 'inactive-rollback-history-intent.json')), { code: 'ENOENT' });
  const workers = await api.openWindowsInactiveRollbackWorkerRetirement(options);
  try {
    assert.equal((await workers.check()).retiredEntries, 0);
    for (let prefix = 1; prefix <= 2; prefix++) {
      assert.equal((await workers.advance()).retiredEntries, prefix);
      await assert.rejects(lstat(path.join(control, worker.entries[prefix - 1].path)), { code: 'ENOENT' });
    }
    console.log(`INACTIVE_ROLLBACK_WORKERS_HELD ${JSON.stringify({ ...workers.identity, prefix: 2 })}`);
    const timer = setInterval(() => {}, 1000);
    try { await new Promise(() => {}); } finally { clearInterval(timer); }
  } finally { await workers.close(); }
};
if (mode === 'resume-history-saved') {
  const { saveRecoveryEngine, retirementRecoveryInvocation } = await load('saved-recovery-engine.mjs');
  const saved = await saveRecoveryEngine({ source, control, allowVersionChange: true });
  const originalState = JSON.parse(state);
  const command = retirementRecoveryInvocation(saved, {
    control, project: originalState.project, operationId: originalState.operationId, kind: 'stopped-history', pwsh,
  });
  const preparedIntent = await readFile(path.join(control, 'inactive-rollback-history-intent.json'));
  await assert.rejects(promisify(execFile)(command.file, [
    fileURLToPath(new URL('../scripts/deployment/retirement-recovery-entry.mjs', import.meta.url)),
    ...command.args.slice(1),
  ], {
    env: command.env, cwd: control, timeout: 120000, maxBuffer: 8192,
  }), error => error.code === 1 && error.stdout === ''
    && error.stderr.startsWith('Retirement recovery failed; retain lock and evidence for inspection.'));
  assert.deepEqual(await readFile(path.join(control, 'inactive-rollback-history-intent.json')), preparedIntent);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
  const result = await promisify(execFile)(command.file, command.args, {
    env: command.env, cwd: control, timeout: 120000, maxBuffer: 8192,
  });
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'history-archived', operationId: originalState.operationId, phase: 'restored',
  });
}
await withWindowsAdmission(control, { pwsh }, async admission => {
  const options = { control, pwsh, admission };
  const retirementCrash = mode === 'crash-lock-retirement-history';
  const retirementResume = mode === 'resume-lock-retirement-history';
  const ownerRetirementCrash = mode === 'crash-lock-owner-retired-history';
  const ownerRetirementResume = mode === 'resume-lock-owner-retired-history';
  const ownerRetirementCheck = mode === 'check-lock-owner-retired-history';
  const directoryRetirementCrash = mode === 'crash-lock-directory-retired-history';
  const directoryRetirementResume = mode === 'resume-lock-directory-retired-history';
  const settlementCrash = mode === 'crash-lock-settled-history';
  const settlementResume = mode === 'resume-lock-settled-history';
  const settlementCheck = mode === 'check-lock-settled-history';
  const successorCrash = mode === 'crash-successor-prepared-history';
  const successorResume = mode === 'resume-successor-prepared-history';
  const successorCheck = mode === 'check-successor-prepared-history';
  const successorAbandonedCrash = mode === 'crash-successor-abandoned-history';
  const successorAbandonedResume = mode === 'resume-successor-abandoned-history';
  const restartPublishedResume = mode === 'resume-restart-published-history';
  const restartDirectoryResume = mode === 'resume-restart-directory-history';
  const restartDirectoryCrash = mode === 'crash-restart-directory-history';
  const restartDirectoryDeadResume = mode === 'resume-restart-directory-dead-history';
  const restartOwnerResume = mode === 'resume-restart-owner-history';
  const restartOwnerCrash = mode === 'crash-restart-owner-history';
  const restartOwnerDeadResume = mode === 'resume-restart-owner-dead-history';
  const restartCommittedResume = mode === 'resume-restart-committed-history'
    || mode === 'resume-restart-released-history';
  const restartReleasedResume = mode === 'resume-restart-released-history'
    || mode === 'resume-restart-state-released-history';
  const restartStateIntentResume = mode === 'resume-restart-state-intent-history'
    || mode === 'resume-restart-state-written-history' || mode === 'resume-restart-state-released-history';
  const restartStateWrittenResume = mode === 'resume-restart-state-written-history'
    || mode === 'resume-restart-state-released-history';
  const restartCommittedCrash = mode === 'crash-restart-committed-history';
  const restartCommittedDeadResume = mode === 'resume-restart-committed-dead-history';
  const restartStateReleasedCrash = mode === 'crash-restart-state-released-history';
  const restartStateReleasedDeadResume = mode === 'resume-restart-state-released-dead-history';
  const restartStateReleaseIntentCrash = mode === 'crash-restart-state-release-intent-history';
  const restartStateReleaseIntentDeadResume = mode === 'resume-restart-state-release-intent-dead-history';
  const restartStateCrash = mode === 'crash-restart-state-history' || restartStateReleasedCrash || restartStateReleaseIntentCrash;
  const restartStateDeadResume = mode === 'resume-restart-state-dead-history' || restartStateReleasedDeadResume ||
    restartStateReleaseIntentDeadResume;
  const restartReleasedCrash = mode === 'crash-restart-released-history';
  const restartReleasedDeadResume = mode === 'resume-restart-released-dead-history';
  const restartRetirementCrash = mode === 'crash-restart-retirement-history';
  const restartReleaseIntentCrash = mode === 'crash-restart-release-intent-history';
  const restartReleaseIntentDeadResume = mode === 'resume-restart-release-intent-dead-history';
  const restartRetirementDeadResume = mode === 'resume-restart-retirement-dead-history';
  const restartCrash = mode === 'crash-restart-prepared-history';
  const restartResume = mode === 'resume-restart-prepared-history';
  const successorAbandonedCheck = mode === 'check-successor-abandoned-history';
  const lockStages = {
    'crash-lock-directory-history': 'Directory', 'resume-lock-directory-history': 'Directory',
    'crash-lock-owner-history': 'Owner', 'resume-lock-owner-history': 'Owner',
    'crash-lock-committed-history': 'Committed', 'resume-lock-committed-history': 'Committed',
    'crash-lock-retirement-history': 'Committed', 'resume-lock-retirement-history': 'Committed',
    'crash-lock-owner-retired-history': 'Committed', 'resume-lock-owner-retired-history': 'Committed',
    'check-lock-owner-retired-history': 'Committed',
    'crash-lock-directory-retired-history': 'Committed', 'resume-lock-directory-retired-history': 'Committed',
    'crash-lock-settled-history': 'Committed', 'resume-lock-settled-history': 'Committed',
    'check-lock-settled-history': 'Committed',
    'crash-successor-prepared-history': 'Committed', 'resume-successor-prepared-history': 'Committed',
    'check-successor-prepared-history': 'Committed',
    'crash-successor-abandoned-history': 'Committed', 'resume-successor-abandoned-history': 'Committed',
    'check-successor-abandoned-history': 'Committed',
    'resume-restart-published-history': 'Committed',
    'resume-restart-directory-history': 'Committed',
    'resume-restart-owner-history': 'Committed',
    'crash-restart-owner-history': 'Committed', 'resume-restart-owner-dead-history': 'Committed',
    'resume-restart-committed-history': 'Committed', 'resume-restart-state-intent-history': 'Committed', 'resume-restart-state-written-history': 'Committed',
    'resume-restart-state-released-history': 'Committed',
    'resume-restart-released-history': 'Committed',
    'crash-restart-committed-history': 'Committed', 'resume-restart-committed-dead-history': 'Committed',
    'crash-restart-state-history': 'Committed', 'resume-restart-state-dead-history': 'Committed',
    'crash-restart-released-history': 'Committed', 'resume-restart-released-dead-history': 'Committed',
    'crash-restart-state-released-history': 'Committed', 'resume-restart-state-released-dead-history': 'Committed',
    'crash-restart-retirement-history': 'Committed', 'resume-restart-retirement-dead-history': 'Committed',
    'crash-restart-release-intent-history': 'Committed', 'resume-restart-release-intent-dead-history': 'Committed',
    'crash-restart-state-release-intent-history': 'Committed', 'resume-restart-state-release-intent-dead-history': 'Committed',
    'crash-restart-directory-history': 'Committed', 'resume-restart-directory-dead-history': 'Committed',
    'crash-restart-prepared-history': 'Committed', 'resume-restart-prepared-history': 'Committed',
  };
  const lockStage = lockStages[mode];
  const lockCrash = Boolean(lockStage && mode.startsWith('crash-') &&
    !retirementCrash && !ownerRetirementCrash && !directoryRetirementCrash && !settlementCrash && !successorCrash && !successorAbandonedCrash && !restartCrash && !restartDirectoryCrash && !restartOwnerCrash && !restartCommittedCrash && !restartStateCrash && !restartReleasedCrash && !restartRetirementCrash && !restartReleaseIntentCrash);
  const lockResume = Boolean(lockStage &&
    (mode.startsWith('resume-') || retirementCrash || ownerRetirementCrash || directoryRetirementCrash || ownerRetirementCheck || settlementCrash || settlementCheck || successorCrash || successorCheck || successorAbandonedCrash || successorAbandonedCheck || restartCrash || restartDirectoryCrash || restartOwnerCrash || restartCommittedCrash || restartStateCrash || restartReleasedCrash || restartRetirementCrash || restartReleaseIntentCrash));
  if (['crash-history', 'resume-history', 'crash-finalized-history', 'resume-finalized-history',
    'resume-history-saved', 'crash-completed-history', 'resume-completed-history',
    'crash-prepared-history', 'resume-prepared-history',
    'crash-abandoned-history', 'resume-abandoned-history'].includes(mode) || lockStage) {
    const finalizedResume = ['resume-finalized-history', 'resume-history-saved',
      'resume-completed-history', 'resume-prepared-history',
      'crash-abandoned-history', 'resume-abandoned-history'].includes(mode) || lockResume;
    if (!finalizedResume) await retainOriginalRuntimeAbsence();
    const intentFile = path.join(control, 'inactive-rollback-history-intent.json');
    const originalIntent = await readFile(finalizedResume
      ? path.join(control, `retired-${JSON.parse(state).operationId}-inactive-rollback-history-intent.json`)
      : intentFile);
    const intent = JSON.parse(originalIntent);
    const completionFile = path.join(control, `retired-${intent.operationId}-inactive-rollback-history-complete.json`);
    const retainedCompletion = ['resume-completed-history', 'resume-prepared-history',
      'crash-abandoned-history', 'resume-abandoned-history'].includes(mode) || lockResume ? {
      bytes: await readFile(completionFile), identity: await lstat(completionFile, { bigint: true }),
    } : undefined;
    if (mode === 'resume-history' || finalizedResume) {
      const previous = JSON.parse(crashStep);
      assert.notEqual(await processIdentity(process.pid), previous.actorIdentity);
      assert.notEqual(await processIdentity(previous.pid), previous.processIdentity);
    }
    if ((mode === 'resume-history' || finalizedResume) && !lockResume) {
      const { archiveCompletedWindowsInactiveRollback } = await load('windows-completed-closeout.mjs');
      assert.equal(typeof archiveCompletedWindowsInactiveRollback, 'function');
      const originalState = JSON.parse(state);
      const closeout = { ...options, project: originalState.project, operationId: originalState.operationId };
      await assert.rejects(archiveCompletedWindowsInactiveRollback({ ...closeout, project: `${originalState.project}-foreign` }));
      await assert.rejects(archiveCompletedWindowsInactiveRollback({ ...closeout, admission: { ...admission } }));
      const cancelled = new AbortController();
      cancelled.abort(new Error('Stopped archive closeout fixture cancellation'));
      await assert.rejects(archiveCompletedWindowsInactiveRollback({ ...closeout, signal: cancelled.signal }));
      const expected = { status: 'history-archived', operationId: originalState.operationId, phase: 'restored' };
      assert.deepEqual(await archiveCompletedWindowsInactiveRollback(closeout), expected);
      assert.deepEqual(await archiveCompletedWindowsInactiveRollback(closeout), expected);
    } else if (!lockResume) {
      const writer = await api.openWindowsInactiveRollbackHistoryRetirement(options);
      try {
        assert.equal(writer.observation.archivedEntries, 0);
        if (mode === 'crash-history') {
          assert.equal((await writer.advance()).archivedEntries, 1);
          console.log(`INACTIVE_HISTORY_ARCHIVE_HELD ${JSON.stringify({
            ...writer.identity, actorIdentity: await processIdentity(process.pid),
          })}`);
          const timer = setInterval(() => {}, 1000);
          try { await new Promise(() => {}); } finally { clearInterval(timer); }
        }
        for (let prefix = writer.observation.archivedEntries + 1; prefix <= intent.entries.length; prefix++) {
          const advanced = await writer.advance();
          assert.equal(advanced.archivedEntries, prefix);
          assert.deepEqual(await writer.check(), advanced);
        }
        assert.equal(writer.observation.status, 'archived');
        assert.deepEqual(await writer.finalizeHistory(), {
          file: path.join(control, `retired-${intent.operationId}-inactive-rollback-history-intent.json`),
          sha256: createHash('sha256').update(originalIntent).digest('hex'),
        });
        if (mode === 'crash-finalized-history') {
          console.log(`INACTIVE_HISTORY_ARCHIVE_HELD ${JSON.stringify({
            ...writer.identity, actorIdentity: await processIdentity(process.pid),
          })}`);
          const timer = setInterval(() => {}, 1000);
          try { await new Promise(() => {}); } finally { clearInterval(timer); }
        }
      } finally { await writer.close(); }
    }
    if (['crash-completed-history', 'crash-prepared-history'].includes(mode) || lockCrash) {
      const publisher = await api.openWindowsInactiveRollbackHistoryCompletion(options);
      try {
        const completed = await publisher.completeHistory();
        if (mode === 'crash-completed-history') {
          console.log(`INACTIVE_HISTORY_ARCHIVE_HELD ${JSON.stringify({
            ...publisher.identity, actorIdentity: await processIdentity(process.pid), completionSha256: completed.sha256,
          })}`);
          const timer = setInterval(() => {}, 1000);
          try { await new Promise(() => {}); } finally { clearInterval(timer); }
        }
      } finally { await publisher.close(); }
    }
    if (mode === 'crash-prepared-history' || lockCrash) {
      const { openWindowsStoppedHistoryHandoffPreparation } = await load('windows-stopped-history-handoff.mjs');
      const actorIdentity = await processIdentity(process.pid);
      const attemptId = randomUUID();
      const completionSha256 = createHash('sha256').update(await readFile(completionFile)).digest('hex');
      const originalState = JSON.parse(state);
      const scope = await openWindowsStoppedHistoryHandoffPreparation({
        ...options, project: originalState.project, previousOperationId: originalState.operationId,
        operation: 'update', attemptId, operationId: randomUUID(), token: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      const descriptor = await scope.publish();
      assert.deepEqual((await scope.check()).prepared, descriptor);
      assert.equal(scope.identity.processIdentity, await processIdentity(scope.identity.pid));
      if (lockCrash) {
        await scope.close();
        const owner = JSON.parse(await readFile(path.join(control, descriptor.path))).newOwner;
        const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
        const { captureWorkerFields } = await load('worker-identity.mjs');
        const transport = windowsControllerTransport({
          pwsh, label: 'Held native handoff lock fixture',
          refused: cause => new Error('Held native handoff lock fixture failed.', { cause }),
          args: [
            '-NoProfile', '-NonInteractive', '-File',
            fileURLToPath(new URL('./deployment-windows-history-handoff-commit.ps1', import.meta.url)),
            '-Source', source, '-Control', control, '-ControllerPid', String(process.pid),
            '-ControllerIdentity', actorIdentity, '-AttemptId', attemptId,
            '-OperationId', owner.operationId, '-Token', owner.token, '-CreatedAt', owner.createdAt,
            '-PreparedDev', descriptor.dev, '-PreparedIno', descriptor.ino,
            '-PreparedBytes', String(descriptor.bytes), '-PreparedSha256', descriptor.sha256,
            '-HoldAt', lockStage,
          ],
        });
        let ready;
        try {
          ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 60000 }),
            ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held handoff lock');
          assert.equal(ready.type, 'ready');
          assert.equal(ready.pid, transport.child.pid);
          assert.equal(ready.control, control);
          assert.equal(ready.controllerIdentity, actorIdentity);
          assert.equal(ready.processIdentity, await processIdentity(ready.pid));
          assert.equal(ready.value.stage, lockStage);
          assert.equal(ready.value.attemptId, attemptId);
          assert.deepEqual(ready.value.prepared, descriptor);
        } catch (cause) { throw await transport.abandon(cause); }
        console.log(`INACTIVE_HISTORY_ARCHIVE_HELD ${JSON.stringify({
          pid: ready.pid, processIdentity: ready.processIdentity, actorPid: process.pid, actorIdentity,
          ...ready.value, completionSha256,
        })}`);
        const timer = setInterval(() => {}, 1000);
        try { await new Promise(() => {}); } finally { clearInterval(timer); }
      }
      console.log(`INACTIVE_HISTORY_ARCHIVE_HELD ${JSON.stringify({
        ...scope.identity, actorIdentity, actorPid: process.pid, attemptId, prepared: descriptor,
        completionSha256,
      })}`);
      const timer = setInterval(() => {}, 1000);
      try { await new Promise(() => {}); } finally { clearInterval(timer); }
    }
    const completionBytes = await readFile(completionFile);
    if (restartReleaseIntentCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, createDirectory: true, publishOwner: true, commitRestart: true,
        releaseRestart: true, holdReleaseIntent: true,
      });
      throw new Error('Held restart release intent publisher unexpectedly returned.');
    } else if (restartReleaseIntentDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true, blockedOwner: true, blockedCommitted: true, blockedReleaseIntent: true,
      });
    } else if (restartRetirementCrash) {
      await holdRestartRetirement({ source, control, pwsh, previous: JSON.parse(crashStep) });
      throw new Error('Held restart lock retirer unexpectedly returned.');
    } else if (restartRetirementDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true, blockedOwner: true, blockedCommitted: true, blockedRetirement: true,
      });
    } else if (restartStateReleaseIntentCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, createDirectory: true, publishOwner: true, commitRestart: true,
        prepareState: true, writeState: true, releaseRestart: true, holdReleaseIntent: true,
      });
      throw new Error('Held post-write restart release intent publisher unexpectedly returned.');
    } else if (restartStateReleaseIntentDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true, blockedOwner: true, blockedCommitted: true, blockedState: true,
        blockedReleaseIntent: true,
      });
    } else if (restartStateReleasedCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, createDirectory: true, publishOwner: true, commitRestart: true,
        prepareState: true, writeState: true, releaseRestart: true, holdReleased: true,
      });
      throw new Error('Held post-write restart releaser unexpectedly returned.');
    } else if (restartStateReleasedDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true, blockedOwner: true, blockedCommitted: true, blockedState: true,
        blockedReleased: true,
      });
    } else if (restartReleasedCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, createDirectory: true, publishOwner: true, commitRestart: true,
        releaseRestart: true, holdReleased: true,
      });
      throw new Error('Held restart releaser unexpectedly returned.');
    } else if (restartReleasedDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true, blockedOwner: true, blockedCommitted: true, blockedReleased: true,
      });
    } else if (restartStateCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, createDirectory: true, publishOwner: true, commitRestart: true,
        prepareState: true, writeState: true, holdState: true,
      });
      throw new Error('Held restart state writer unexpectedly returned.');
    } else if (restartStateDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true, blockedOwner: true, blockedCommitted: true, blockedState: true,
      });
    } else if (restartCommittedCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, createDirectory: true, publishOwner: true, commitRestart: true, holdCommitted: true,
      });
      throw new Error('Held restart committed publisher unexpectedly returned.');
    } else if (restartCommittedDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true, blockedOwner: true, blockedCommitted: true,
      });
    } else if (restartOwnerCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, createDirectory: true, publishOwner: true, holdOwner: true,
      });
      throw new Error('Held restart owner publisher unexpectedly returned.');
    } else if (restartOwnerDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true, blockedOwner: true,
      });
    } else if (restartDirectoryCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, createDirectory: true, holdDirectory: true,
      });
      throw new Error('Held restart directory publisher unexpectedly returned.');
    } else if (restartDirectoryDeadResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        restart: true, blockedDirectory: true,
      });
    } else if (restartCrash) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: true, hold: true,
      });
      throw new Error('Held restart publisher unexpectedly returned.');
    } else if (restartResume) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes, restart: true,
      });
    } else if (successorAbandonedCrash) {
      await holdSuccessorAbandoned({ source, control, pwsh, previous: JSON.parse(crashStep) });
      throw new Error('Held successor abandonment publisher unexpectedly returned.');
    } else if (successorAbandonedCheck) {
      await assertSuccessorAbandonedAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
      });
      return;
    } else if (handoffCloseout) {
      // The archived fixture was restored by the closeout; continue with the exact archive assertions.
    } else if (successorAbandonedResume || restartPublishedResume || restartDirectoryResume || restartOwnerResume || restartCommittedResume || restartStateIntentResume) {
      await assertRestartPreparation({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        publish: restartPublishedResume || restartDirectoryResume || restartOwnerResume || restartCommittedResume || restartStateIntentResume,
        createDirectory: restartDirectoryResume || restartOwnerResume || restartCommittedResume || restartStateIntentResume,
        publishOwner: restartOwnerResume || restartCommittedResume || restartStateIntentResume,
        commitRestart: restartCommittedResume || restartStateIntentResume, prepareState: restartStateIntentResume,
        writeState: restartStateWrittenResume, releaseRestart: restartReleasedResume,
        refuseAdmission: mode === 'resume-restart-state-written-history',
      });
      if (mode === 'resume-restart-state-written-history') {
        deferredHandoffCloseout = true;
        return;
      }
    } else if (successorCrash) {
      await holdSuccessorPrepared({ source, control, pwsh, previous: JSON.parse(crashStep) });
      throw new Error('Held successor preparation publisher unexpectedly returned.');
    } else if (successorResume || successorCheck) {
      await assertSuccessorAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        stage: successorCheck ? 'proof' : 'abandonment',
      });
      if (successorCheck) return;
    } else if (settlementCrash) {
      await holdLockRetirementSettlement({ source, control, pwsh, previous: JSON.parse(crashStep) });
      throw new Error('Held lock settlement publisher unexpectedly returned.');
    } else if (settlementResume || settlementCheck) {
      await assertLockRetirementSettlementAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        stage: settlementCheck ? 'proof' : 'publication',
      });
      if (settlementCheck) return;
    } else if (directoryRetirementCrash) {
      await holdLockDirectoryRetirement({ source, control, pwsh, previous: JSON.parse(crashStep) });
      throw new Error('Held directory retirement executor unexpectedly returned.');
    } else if (directoryRetirementResume) {
      await assertLockDirectoryRetirementAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
      });
    } else if (ownerRetirementCrash) {
      await holdLockOwnerRetirement({ source, control, pwsh, previous: JSON.parse(crashStep) });
      throw new Error('Held owner retirement executor unexpectedly returned.');
    } else if (retirementResume || ownerRetirementResume || ownerRetirementCheck) {
      await assertLockRetirementIntentAfterDeath({
        source, control, pwsh, admission, previous: JSON.parse(crashStep), state, completionBytes,
        ownerRetired: ownerRetirementResume || ownerRetirementCheck,
        stage: ownerRetirementCheck ? 'owner-proof' : ownerRetirementResume ? 'directory-removal' : 'complete',
      });
      if (ownerRetirementCheck) return;
    } else if (lockResume) {
      const previous = JSON.parse(crashStep);
      assert.equal(previous.stage, lockStage);
      assert.notEqual(await processIdentity(process.pid), previous.actorIdentity);
      assert.notEqual(await processIdentity(previous.actorPid), previous.actorIdentity);
      assert.notEqual(await processIdentity(previous.pid), previous.processIdentity);
      assert.equal(previous.prepared.path, `inactive-handoff-${previous.attemptId}-prepared.json`);
      const snapshots = [];
      let retirement;
      const capture = async descriptor => {
        const file = path.join(control, descriptor.path);
        const bytes = await readFile(file);
        const identity = await lstat(file, { bigint: true });
        assert.equal(bytes.length, descriptor.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
        assert.equal(identity.dev.toString(), descriptor.dev);
        assert.equal(identity.ino.toString(), descriptor.ino);
        const snapshot = { file, bytes, identity };
        snapshots.push(snapshot);
        return snapshot;
      };
      const prepared = JSON.parse((await capture(previous.prepared)).bytes);
      assert.equal(prepared.oldState, state.toString('utf8'));
      assert.equal(prepared.newOwner.pid, previous.actorPid);
      assert.equal(prepared.newOwner.processIdentity, previous.actorIdentity);
      const lockDirectory = path.join(control, 'lock');
      const directory = await lstat(lockDirectory, { bigint: true });
      assert.ok(directory.isDirectory());
      assert.deepEqual(previous.lockIdentity, { dev: directory.dev.toString(), ino: directory.ino.toString() });
      const children = lockStage === 'Directory' ? [] : ['owner.json'];
      assert.deepEqual(await readdir(lockDirectory), children);
      if (lockStage === 'Directory') {
        assert.equal(previous.owner, null);
      } else {
        assert.equal(previous.owner.path, 'lock\\owner.json');
        assert.deepEqual(JSON.parse((await capture(previous.owner)).bytes), prepared.newOwner);
      }
      if (lockStage === 'Committed') {
        assert.equal(previous.committed.path, `inactive-handoff-${previous.attemptId}-committed.json`);
        const record = JSON.parse((await capture(previous.committed)).bytes);
        assert.equal(record.phase, 'stopped-history-handoff-committed');
        assert.equal(record.attemptId, previous.attemptId);
        assert.equal(record.control, control);
        assert.equal(record.project, prepared.project);
        assert.equal(record.previousOperationId, prepared.previousOperationId);
        assert.deepEqual(record.controlIdentity, prepared.controlIdentity);
        assert.deepEqual(record.prepared, previous.prepared);
        assert.deepEqual(record.newOwner, prepared.newOwner);
        assert.deepEqual(record.lockIdentity, previous.lockIdentity);
        assert.deepEqual(record.lock, previous.owner);
        assert.deepEqual(record.creator, { pid: previous.actorPid, processIdentity: previous.actorIdentity,
          bridgePid: previous.pid, bridgeIdentity: previous.processIdentity });
        if (retirementCrash) {
          await holdLockRetirementIntent({ source, control, pwsh, previous });
          throw new Error('Held retirement publisher unexpectedly returned.');
        }
        const observeArgs = [
          '-NoProfile', '-NonInteractive', '-File',
          fileURLToPath(new URL('./deployment-windows-history-handoff-committed-observation.ps1', import.meta.url)),
          '-Source', source, '-Control', control, '-ControllerPid', String(process.pid),
          '-ControllerIdentity', await processIdentity(process.pid), '-AttemptId', previous.attemptId,
          '-PreparedDev', previous.prepared.dev, '-PreparedIno', previous.prepared.ino,
          '-PreparedBytes', String(previous.prepared.bytes), '-PreparedSha256', previous.prepared.sha256,
          '-CommittedDev', previous.committed.dev, '-CommittedBytes', String(previous.committed.bytes),
          '-CommittedSha256', previous.committed.sha256,
        ];
        const observe = ino => promisify(execFile)(pwsh, [...observeArgs, '-CommittedIno', ino],
          { timeout: 45000, maxBuffer: 131072, windowsHide: true });
        const native = await observe(previous.committed.ino);
        assert.equal(native.stderr, '');
        const observed = JSON.parse(native.stdout);
        assert.deepEqual(Object.keys(observed).sort(), [
          'status', 'attemptId', 'previousOperationId', 'project', 'prepared', 'committed',
          'lockIdentity', 'lock', 'runtimeAuthority', 'lockAuthority',
        ].sort());
        assert.equal(observed.status, 'committed-handoff-observed');
        assert.equal(observed.attemptId, previous.attemptId);
        assert.equal(observed.previousOperationId, prepared.previousOperationId);
        assert.equal(observed.project, prepared.project);
        assert.deepEqual(observed.prepared, previous.prepared);
        assert.deepEqual(observed.committed, previous.committed);
        assert.deepEqual(observed.lockIdentity, previous.lockIdentity);
        assert.deepEqual(observed.lock, previous.owner);
        assert.equal(observed.runtimeAuthority, false);
        assert.equal(observed.lockAuthority, false);
        await assert.rejects(observe(previous.committed.ino === '1' ? '2' : '1'),
          error => error.message.includes('Committed handoff observation failed; retain evidence.'));
        const ownerFile = path.join(control, previous.owner.path);
        const original = snapshots.find(snapshot => snapshot.file === ownerFile);
        const heldOwner = path.join(control, 'fixture-handoff-original-owner.json');
        await rename(ownerFile, heldOwner);
        let replacement;
        try {
          await writeFile(ownerFile, original.bytes, { flag: 'wx' });
          replacement = await lstat(ownerFile, { bigint: true });
          assert.notEqual(replacement.ino, original.identity.ino);
          await assert.rejects(observe(previous.committed.ino),
            error => error.message.includes('Committed handoff observation failed; retain evidence.'));
          assert.deepEqual(await readFile(ownerFile), original.bytes);
        } finally {
          if (replacement) {
            const current = await lstat(ownerFile, { bigint: true });
            assert.equal(current.dev, replacement.dev);
            assert.equal(current.ino, replacement.ino);
            assert.deepEqual(await readFile(ownerFile), original.bytes);
            await unlink(ownerFile);
          }
          await rename(heldOwner, ownerFile);
        }
        console.log('PASS: native dead committed handoff observation pins exact lock and original archive under a distinct actor without authority');
        const retirementResult = await promisify(execFile)(pwsh,
          [...observeArgs, '-CommittedIno', previous.committed.ino, '-PrepareRetirement'],
          { timeout: 45000, maxBuffer: 131072, windowsHide: true });
        assert.equal(retirementResult.stderr, '');
        retirement = JSON.parse(retirementResult.stdout);
        assert.equal(retirement.path, `inactive-handoff-${previous.attemptId}-lock-retirement.json`);
        const intent = JSON.parse((await capture(retirement)).bytes);
        assert.deepEqual(Object.keys(intent).sort(), [
          'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
          'prepared', 'committed', 'newOwner', 'lockIdentity', 'lock', 'creator', 'createdAt',
        ].sort());
        assert.equal(intent.version, 1);
        assert.equal(intent.phase, 'stopped-history-handoff-lock-retirement-prepared');
        assert.equal(intent.attemptId, previous.attemptId);
        assert.equal(intent.control, control);
        assert.equal(intent.project, prepared.project);
        assert.deepEqual(intent.controlIdentity, prepared.controlIdentity);
        assert.equal(intent.previousOperationId, prepared.previousOperationId);
        assert.deepEqual(intent.prepared, previous.prepared);
        assert.deepEqual(intent.committed, previous.committed);
        assert.deepEqual(intent.newOwner, prepared.newOwner);
        assert.deepEqual(intent.lockIdentity, previous.lockIdentity);
        assert.deepEqual(intent.lock, previous.owner);
        assert.deepEqual(Object.keys(intent.creator).sort(),
          ['pid', 'processIdentity', 'bridgePid', 'bridgeIdentity'].sort());
        assert.equal(intent.creator.pid, process.pid);
        assert.equal(intent.creator.processIdentity, await processIdentity(process.pid));
        assert.notEqual(intent.creator.bridgePid, process.pid);
        assert.match(intent.creator.bridgeIdentity, new RegExp(`^${intent.creator.bridgePid}:[1-9][0-9]*$`));
        assert.match(intent.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.ok(Date.parse(intent.createdAt) >= Date.parse(record.committedAt));
        await assert.rejects(promisify(execFile)(pwsh,
          [...observeArgs, '-CommittedIno', previous.committed.ino, '-PrepareRetirement'],
          { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
        error => error.message.includes('Committed handoff observation failed; retain evidence.'));
      } else { assert.equal(previous.committed, null); }
      const names = [previous.prepared.path, ...(previous.committed ? [previous.committed.path] : []),
        ...(retirement ? [retirement.path] : [])].sort();
      assert.deepEqual((await readdir(control)).filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort(), names);
      const { acquireLock, releaseLock } = await load('state.mjs');
      await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
      await assert.rejects(acquireLock(control, { ...options, project: prepared.project, operationId: randomUUID() }));
      await assert.rejects(releaseLock(control, prepared.newOwner, { pwsh, admission }));
      for (const snapshot of snapshots) {
        assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
        const current = await lstat(snapshot.file, { bigint: true });
        assert.equal(current.dev, snapshot.identity.dev);
        assert.equal(current.ino, snapshot.identity.ino);
      }
      const after = await lstat(lockDirectory, { bigint: true });
      assert.equal(after.dev, directory.dev);
      assert.equal(after.ino, directory.ino);
      assert.deepEqual(await readdir(lockDirectory), children);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      assert.deepEqual(await readFile(completionFile), retainedCompletion.bytes);
      const completionIdentity = await lstat(completionFile, { bigint: true });
      assert.equal(completionIdentity.dev, retainedCompletion.identity.dev);
      assert.equal(completionIdentity.ino, retainedCompletion.identity.ino);
      if (retirement) await unlink(path.join(control, retirement.path));
      if (previous.committed) await unlink(path.join(control, previous.committed.path));
      if (previous.owner) await unlink(path.join(control, previous.owner.path));
      await rmdir(lockDirectory);
      await unlink(path.join(control, previous.prepared.path));
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      const receipt = {
        Directory: 'PASS: actual handoff directory publisher death preserves an empty exact lock and ordinary refusal',
        Owner: 'PASS: actual handoff owner publisher death preserves exact prepared owner evidence without committed authority',
        Committed: 'PASS: actual committed handoff publisher death preserves exact receipt and blocks ordinary continuation',
      };
      console.log(receipt[lockStage]);
      if (retirement) console.log('PASS: native lock retirement intent binds exact dead committed lock without deleting evidence or granting continuation');
    }
    if (mode === 'resume-abandoned-history') {
      const previous = JSON.parse(crashStep);
      const preparedFile = path.join(control, previous.prepared.path);
      const terminalFile = path.join(control, previous.terminal.path);
      assert.equal(previous.prepared.path, `inactive-handoff-${previous.attemptId}-prepared.json`);
      assert.equal(previous.terminal.path, `inactive-handoff-${previous.attemptId}-abandoned.json`);
      const snapshots = [];
      for (const descriptor of [previous.prepared, previous.terminal]) {
        const file = path.join(control, descriptor.path);
        const bytes = await readFile(file);
        const identity = await lstat(file, { bigint: true });
        assert.equal(bytes.length, descriptor.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
        assert.equal(identity.dev.toString(), descriptor.dev);
        assert.equal(identity.ino.toString(), descriptor.ino);
        snapshots.push({ file, bytes, identity });
      }
      const terminal = JSON.parse(snapshots[1].bytes);
      assert.equal(terminal.phase, 'stopped-history-handoff-abandoned');
      assert.equal(terminal.attemptId, previous.attemptId);
      assert.deepEqual(terminal.prepared, previous.prepared);
      assert.equal(terminal.control, control);
      assert.equal(terminal.previousOperationId, intent.operationId);
      assert.equal(terminal.creator.pid, previous.actorPid);
      assert.equal(terminal.creator.processIdentity, previous.actorIdentity);
      assert.equal(terminal.creator.bridgePid, previous.pid);
      assert.equal(terminal.creator.bridgeIdentity, previous.processIdentity);
      assert.notEqual(await processIdentity(process.pid), previous.actorIdentity);
      assert.notEqual(await processIdentity(previous.actorPid), previous.actorIdentity);
      assert.notEqual(await processIdentity(previous.pid), previous.processIdentity);
      const { captureWindowsStoppedHistoryHandoffPrepared } = await load('windows-stopped-history-handoff-record.mjs');
      const prepared = captureWindowsStoppedHistoryHandoffPrepared(JSON.parse(snapshots[0].bytes));
      assert.equal(terminal.project, prepared.project);
      assert.deepEqual(terminal.controlIdentity, prepared.controlIdentity);
      assert.equal(prepared.newOwner.pid, previous.preparedActor.actorPid);
      assert.equal(prepared.newOwner.processIdentity, previous.preparedActor.actorIdentity);
      assert.notEqual(await processIdentity(prepared.newOwner.pid), prepared.newOwner.processIdentity);
      const abandonArgs = [
        '-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./deployment-windows-history-handoff-entry.ps1', import.meta.url)),
        '-Source', source, '-Control', control,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', await processIdentity(process.pid),
        '-AttemptId', previous.attemptId, '-OperationId', prepared.newOwner.operationId,
        '-Token', prepared.newOwner.token, '-CreatedAt', prepared.newOwner.createdAt,
        '-Abandon', '-PreparedDev', previous.prepared.dev, '-PreparedIno', previous.prepared.ino,
        '-PreparedBytes', String(previous.prepared.bytes), '-PreparedSha256', previous.prepared.sha256,
      ];
      const observeArgs = abandonArgs.filter(argument => argument !== '-Abandon');
      observeArgs.push('-ObserveAbandoned', '-TerminalDev', previous.terminal.dev,
        '-TerminalBytes', String(previous.terminal.bytes), '-TerminalSha256', previous.terminal.sha256);
      const nativeObservation = await promisify(execFile)(pwsh,
        [...observeArgs, '-TerminalIno', previous.terminal.ino],
        { timeout: 45000, maxBuffer: 131072, windowsHide: true });
      assert.equal(nativeObservation.stderr, '');
      const observed = JSON.parse(nativeObservation.stdout);
      assert.equal(observed.status, 'abandoned-handoff-observed');
      assert.equal(observed.attemptId, previous.attemptId);
      assert.deepEqual(observed.prepared, previous.prepared);
      assert.deepEqual(observed.terminal, previous.terminal);
      assert.equal(observed.runtimeAuthority, false);
      assert.equal(observed.lockAuthority, false);
      const wrongIno = previous.terminal.ino === '1' ? '2' : '1';
      await assert.rejects(promisify(execFile)(pwsh, [...observeArgs, '-TerminalIno', wrongIno],
        { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
      error => error.message.includes('Abandoned handoff observation failed; retain evidence.'));
      console.log('PASS: native abandoned handoff observation revalidates exact terminal and prepared evidence under a third actor without lock authority');
      await assert.rejects(promisify(execFile)(pwsh, abandonArgs,
        { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
      error => error.message.includes('Abandoned handoff publication failed; retain evidence.'));
      for (const snapshot of snapshots) {
        assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
        const retained = await lstat(snapshot.file, { bigint: true });
        assert.equal(retained.dev, snapshot.identity.dev);
        assert.equal(retained.ino, snapshot.identity.ino);
      }
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      assert.equal((await readdir(control)).includes('lock'), false);
      await unlink(terminalFile);
      await unlink(preparedFile);
      console.log('PASS: actual abandoned publisher death retains exact terminal evidence and a third actor cannot claim lock authority');
    }
    if (['resume-prepared-history', 'crash-abandoned-history'].includes(mode)) {
      const previous = JSON.parse(crashStep);
      assert.match(previous.attemptId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      assert.equal(previous.prepared.path, `inactive-handoff-${previous.attemptId}-prepared.json`);
      const preparedFile = path.join(control, previous.prepared.path);
      const bytes = await readFile(preparedFile);
      const identity = await lstat(preparedFile, { bigint: true });
      assert.equal(bytes.length, previous.prepared.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), previous.prepared.sha256);
      assert.equal(identity.dev.toString(), previous.prepared.dev);
      assert.equal(identity.ino.toString(), previous.prepared.ino);
      const { captureWindowsStoppedHistoryHandoffPrepared } = await load('windows-stopped-history-handoff-record.mjs');
      const prepared = captureWindowsStoppedHistoryHandoffPrepared(JSON.parse(bytes));
      assert.equal(prepared.newOwner.pid, previous.actorPid);
      assert.equal(prepared.newOwner.processIdentity, previous.actorIdentity);
      assert.notEqual(await processIdentity(previous.actorPid), previous.actorIdentity);
      const { reopenWindowsStoppedHistoryHandoffPreparation } = await load('windows-stopped-history-handoff.mjs');
      await assert.rejects(reopenWindowsStoppedHistoryHandoffPreparation({
        ...options, project: prepared.project, previousOperationId: prepared.previousOperationId,
        operation: 'update', attemptId: prepared.attemptId, operationId: prepared.newOwner.operationId,
        token: prepared.newOwner.token, createdAt: prepared.newOwner.createdAt, prepared: previous.prepared,
      }), error => error.code === 'DEPLOYMENT_WINDOWS_HANDOFF_PREPARATION_REFUSED'
        && error.diagnostic?.includes('Prepared handoff JSON binding differs:'));
      const observeArgs = [
        '-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./deployment-windows-history-handoff-entry.ps1', import.meta.url)),
        '-Source', source, '-Control', control,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', await processIdentity(process.pid),
        '-AttemptId', previous.attemptId, '-OperationId', prepared.newOwner.operationId,
        '-Token', prepared.newOwner.token, '-CreatedAt', prepared.newOwner.createdAt,
        '-ObserveRetired', '-PreparedDev', previous.prepared.dev,
        '-PreparedBytes', String(previous.prepared.bytes), '-PreparedSha256', previous.prepared.sha256,
      ];
      const nativeObservation = await promisify(execFile)(pwsh,
        [...observeArgs, '-PreparedIno', previous.prepared.ino],
        { timeout: 45000, maxBuffer: 131072, windowsHide: true });
      assert.equal(nativeObservation.stderr, '');
      const observed = JSON.parse(nativeObservation.stdout);
      assert.equal(observed.status, 'retired-prepared-handoff-observed');
      assert.equal(observed.attemptId, previous.attemptId);
      assert.deepEqual(observed.prepared, previous.prepared);
      assert.equal(observed.runtimeAuthority, false);
      assert.equal(observed.lockAuthority, false);
      const wrongIno = previous.prepared.ino === '1' ? '2' : '1';
      await assert.rejects(promisify(execFile)(pwsh, [...observeArgs, '-PreparedIno', wrongIno],
        { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
      error => error.message.includes('Retired prepared handoff observation failed; retain evidence.'));
      console.log('PASS: native retired prepared observation pins exact evidence after actual actor death without lock authority');
      await assert.rejects(promisify(execFile)(pwsh, [
        '-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./deployment-windows-history-handoff-entry.ps1', import.meta.url)),
        '-Source', source, '-Control', control,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', await processIdentity(process.pid),
        '-AttemptId', randomUUID(), '-OperationId', randomUUID(), '-Token', randomUUID(),
        '-CreatedAt', new Date().toISOString(), '-Publish',
      ], { timeout: 45000, maxBuffer: 2 * 1024 ** 2, windowsHide: true }),
      error => error.message.includes('Existing handoff requires explicit settlement'));
      assert.deepEqual(await readFile(preparedFile), bytes);
      const retained = await lstat(preparedFile, { bigint: true });
      assert.equal(retained.dev, identity.dev);
      assert.equal(retained.ino, identity.ino);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      assert.equal((await readdir(control)).includes('lock'), false);
      const abandonArgs = observeArgs.filter(argument => argument !== '-ObserveRetired');
      abandonArgs.push('-Abandon', '-PreparedIno', previous.prepared.ino);
      if (mode === 'crash-abandoned-history') {
        const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
        const { captureWorkerFields } = await load('worker-identity.mjs');
        const transport = windowsControllerTransport({
          pwsh, label: 'Held native abandonment fixture',
          refused: cause => new Error('Held native abandonment fixture failed.', { cause }),
          args: [...abandonArgs, '-Hold'],
        });
        let ready;
        try {
          ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 60000 }),
            ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held abandonment');
          assert.equal(ready.type, 'ready');
          assert.equal(ready.pid, transport.child.pid);
          assert.equal(ready.processIdentity, await processIdentity(ready.pid));
          assert.equal(ready.control, control);
          assert.equal(ready.controllerIdentity, await processIdentity(process.pid));
          assert.equal(ready.value.path, `inactive-handoff-${previous.attemptId}-abandoned.json`);
        } catch (cause) { throw await transport.abandon(cause); }
        console.log(`INACTIVE_HISTORY_ABANDONED_HELD ${JSON.stringify({
          pid: ready.pid, processIdentity: ready.processIdentity,
          actorPid: process.pid, actorIdentity: await processIdentity(process.pid),
          attemptId: previous.attemptId, prepared: previous.prepared,
          terminal: ready.value, preparedActor: previous,
          completionSha256: previous.completionSha256,
        })}`);
        const timer = setInterval(() => {}, 1000);
        try { await new Promise(() => {}); } finally { clearInterval(timer); }
      }
      const terminalPublication = await promisify(execFile)(pwsh, abandonArgs,
        { timeout: 45000, maxBuffer: 131072, windowsHide: true });
      assert.equal(terminalPublication.stderr, '');
      const terminalDescriptor = JSON.parse(terminalPublication.stdout);
      assert.equal(terminalDescriptor.path, `inactive-handoff-${previous.attemptId}-abandoned.json`);
      const terminalFile = path.join(control, terminalDescriptor.path);
      const terminalBytes = await readFile(terminalFile);
      const terminalIdentity = await lstat(terminalFile, { bigint: true });
      assert.equal(terminalDescriptor.bytes, terminalBytes.length);
      assert.equal(terminalDescriptor.sha256, createHash('sha256').update(terminalBytes).digest('hex'));
      assert.equal(terminalDescriptor.dev, terminalIdentity.dev.toString());
      assert.equal(terminalDescriptor.ino, terminalIdentity.ino.toString());
      const terminal = JSON.parse(terminalBytes);
      assert.deepEqual(Object.keys(terminal).sort(), [
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
        'previousOperationId', 'prepared', 'creator', 'settledAt',
      ].sort());
      assert.equal(terminal.version, 1);
      assert.equal(terminal.phase, 'stopped-history-handoff-abandoned');
      assert.equal(terminal.attemptId, previous.attemptId);
      assert.equal(terminal.control, control);
      assert.equal(terminal.project, prepared.project);
      assert.deepEqual(terminal.controlIdentity, prepared.controlIdentity);
      assert.equal(terminal.previousOperationId, prepared.previousOperationId);
      assert.deepEqual(terminal.prepared, previous.prepared);
      assert.deepEqual(Object.keys(terminal.creator).sort(),
        ['pid', 'processIdentity', 'bridgePid', 'bridgeIdentity'].sort());
      assert.equal(terminal.creator.pid, process.pid);
      assert.equal(terminal.creator.processIdentity, await processIdentity(process.pid));
      assert.notEqual(terminal.creator.processIdentity, previous.actorIdentity);
      assert.ok(Number.isInteger(terminal.creator.bridgePid) && terminal.creator.bridgePid > 0);
      assert.notEqual(terminal.creator.bridgePid, process.pid);
      assert.match(terminal.creator.bridgeIdentity, new RegExp(`^${terminal.creator.bridgePid}:[1-9][0-9]*$`));
      assert.match(terminal.settledAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.ok(Date.parse(terminal.settledAt) >= Date.parse(prepared.newOwner.createdAt));
      await assert.rejects(promisify(execFile)(pwsh, abandonArgs,
        { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
      error => error.message.includes('Abandoned handoff publication failed; retain evidence.'));
      assert.deepEqual(await readFile(terminalFile), terminalBytes);
      const terminalRetained = await lstat(terminalFile, { bigint: true });
      assert.equal(terminalRetained.dev, terminalIdentity.dev);
      assert.equal(terminalRetained.ino, terminalIdentity.ino);
      assert.deepEqual(await readFile(preparedFile), bytes);
      const preparedRetained = await lstat(preparedFile, { bigint: true });
      assert.equal(preparedRetained.dev, identity.dev);
      assert.equal(preparedRetained.ino, identity.ino);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      assert.equal((await readdir(control)).includes('lock'), false);
      console.log('PASS: native abandoned handoff publication seals one exact dead attempt without replacing evidence or granting lock authority');
      await unlink(terminalFile);
      await unlink(preparedFile);
      console.log('PASS: actual prepared publisher death retains its exact record and a distinct actor cannot claim lock authority');
    }
    if (mode === 'resume-completed-history') {
      const attemptId = randomUUID();
      const operationId = randomUUID();
      const token = randomUUID();
      const actorIdentity = await processIdentity(process.pid);
      const preparedArgs = [
        '-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./deployment-windows-history-handoff-entry.ps1', import.meta.url)),
        '-Source', source, '-Control', control,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', actorIdentity,
        '-AttemptId', attemptId, '-OperationId', operationId,
        '-Token', token, '-CreatedAt', new Date().toISOString(),
      ];
      const nativeRecord = await promisify(execFile)(pwsh, preparedArgs,
        { timeout: 45000, maxBuffer: 2 * 1024 ** 2, windowsHide: true });
      assert.equal(nativeRecord.stderr, '');
      const { captureWindowsStoppedHistoryHandoffPrepared } =
        await load('windows-stopped-history-handoff-record.mjs');
      const prepared = captureWindowsStoppedHistoryHandoffPrepared(JSON.parse(nativeRecord.stdout));
      assert.equal(prepared.attemptId, attemptId);
      assert.equal(prepared.newOwner.operationId, operationId);
      assert.equal(prepared.newOwner.token, token);
      assert.equal(prepared.newOwner.pid, process.pid);
      assert.equal(prepared.newOwner.processIdentity, actorIdentity);
      assert.equal(prepared.oldState, state.toString('utf8'));
      assert.equal(prepared.intent.sha256, createHash('sha256').update(originalIntent).digest('hex'));
      assert.equal(prepared.completion.sha256, createHash('sha256').update(completionBytes).digest('hex'));
      assert.equal((await readdir(control)).some(name => name.toLowerCase().startsWith('inactive-handoff-')), false);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      console.log('PASS: native stopped-history preparation derives exact archive and live prospective owner without publication');
      const publication = await promisify(execFile)(pwsh, [...preparedArgs, '-Publish'],
        { timeout: 45000, maxBuffer: 2 * 1024 ** 2, windowsHide: true });
      assert.equal(publication.stderr, '');
      const descriptor = JSON.parse(publication.stdout);
      assert.equal(descriptor.path, `inactive-handoff-${attemptId}-prepared.json`);
      const preparedFile = path.join(control, descriptor.path);
      const publishedBytes = await readFile(preparedFile);
      const publishedIdentity = await lstat(preparedFile, { bigint: true });
      assert.equal(publishedBytes.length, descriptor.bytes);
      assert.equal(createHash('sha256').update(publishedBytes).digest('hex'), descriptor.sha256);
      assert.equal(publishedIdentity.dev.toString(), descriptor.dev);
      assert.equal(publishedIdentity.ino.toString(), descriptor.ino);
      assert.deepEqual(captureWindowsStoppedHistoryHandoffPrepared(JSON.parse(publishedBytes)), prepared);
      await assert.rejects(promisify(execFile)(pwsh, [...preparedArgs, '-Publish'],
        { timeout: 45000, maxBuffer: 2 * 1024 ** 2, windowsHide: true }));
      assert.deepEqual(await readFile(preparedFile), publishedBytes);
      const retainedIdentity = await lstat(preparedFile, { bigint: true });
      assert.equal(retainedIdentity.dev, publishedIdentity.dev);
      assert.equal(retainedIdentity.ino, publishedIdentity.ino);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      await unlink(preparedFile);
      console.log('PASS: native stopped-history preparation publishes one exact create-only record without lock authority');
      const { openWindowsStoppedHistoryHandoffPreparation, reopenWindowsStoppedHistoryHandoffPreparation } =
        await load('windows-stopped-history-handoff.mjs');
      const handoffOptions = {
        ...options, project: prepared.project, previousOperationId: prepared.previousOperationId,
        operation: 'update', attemptId: randomUUID(), operationId: randomUUID(), token: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await assert.rejects(openWindowsStoppedHistoryHandoffPreparation({
        ...handoffOptions, admission: { ...admission },
      }));
      const cancelled = new AbortController();
      cancelled.abort(new Error('Preparation fixture cancelled'));
      await assert.rejects(openWindowsStoppedHistoryHandoffPreparation({
        ...handoffOptions, signal: cancelled.signal,
      }), /Preparation fixture cancelled/);
      const scope = await openWindowsStoppedHistoryHandoffPreparation(handoffOptions);
      let retainedBytes;
      let retainedDescriptor;
      let retainedFile;
      let retainedFileIdentity;
      try {
        assert.deepEqual(await scope.check(), {
          status: 'stopped-history-handoff-ready', attemptId: handoffOptions.attemptId,
          previousOperationId: prepared.previousOperationId, project: prepared.project, prepared: null,
        });
        assert.equal(scope.identity.processIdentity, await processIdentity(scope.identity.pid));
        retainedDescriptor = await scope.publish();
        assert.deepEqual(Object.keys(retainedDescriptor).sort(), ['path', 'dev', 'ino', 'bytes', 'sha256'].sort());
        assert.equal(retainedDescriptor.path, `inactive-handoff-${handoffOptions.attemptId}-prepared.json`);
        retainedFile = path.join(control, retainedDescriptor.path);
        retainedBytes = await readFile(retainedFile);
        retainedFileIdentity = await lstat(retainedFile, { bigint: true });
        assert.equal(retainedDescriptor.bytes, retainedBytes.length);
        assert.equal(retainedDescriptor.sha256, createHash('sha256').update(retainedBytes).digest('hex'));
        assert.equal(retainedDescriptor.dev, retainedFileIdentity.dev.toString());
        assert.equal(retainedDescriptor.ino, retainedFileIdentity.ino.toString());
        const captured = captureWindowsStoppedHistoryHandoffPrepared(JSON.parse(retainedBytes));
        assert.equal(captured.oldState, state.toString('utf8'));
        assert.equal(captured.newOwner.pid, process.pid);
        assert.equal(captured.newOwner.processIdentity, await processIdentity(process.pid));
        assert.equal(captured.newOwner.operationId, handoffOptions.operationId);
        assert.equal(captured.newOwner.token, handoffOptions.token);
        assert.equal(captured.newOwner.createdAt, handoffOptions.createdAt);
        assert.deepEqual(await scope.check(), {
          ...scope.observation, status: 'stopped-history-handoff-prepared', prepared: retainedDescriptor,
        });
        await assert.rejects(scope.publish(), error => error.code === 'DEPLOYMENT_WINDOWS_HANDOFF_PREPARATION_REFUSED');
        assert.deepEqual((await scope.check()).prepared, retainedDescriptor);
      } finally { await scope.close(); }
      await assert.rejects(openWindowsStoppedHistoryHandoffPreparation(handoffOptions));
      const reopenOptions = { ...handoffOptions, prepared: retainedDescriptor };
      await assert.rejects(reopenWindowsStoppedHistoryHandoffPreparation({
        ...reopenOptions, token: randomUUID(),
      }), error => error.code === 'DEPLOYMENT_WINDOWS_HANDOFF_PREPARATION_REFUSED'
        && error.diagnostic?.includes('Prepared handoff JSON binding differs:'));
      const wrongIno = retainedDescriptor.ino === '1' ? '2' : '1';
      await assert.rejects(reopenWindowsStoppedHistoryHandoffPreparation({
        ...reopenOptions, prepared: { ...retainedDescriptor, ino: wrongIno },
      }), error => error.code === 'DEPLOYMENT_WINDOWS_HANDOFF_PREPARATION_REFUSED'
        && error.diagnostic?.includes('Original retirement evidence was replaced.'));
      const reopened = await reopenWindowsStoppedHistoryHandoffPreparation(reopenOptions);
      try {
        assert.deepEqual(reopened.observation, {
          status: 'stopped-history-handoff-prepared', attemptId: handoffOptions.attemptId,
          previousOperationId: prepared.previousOperationId, project: prepared.project,
          prepared: retainedDescriptor,
        });
        assert.deepEqual(await reopened.check(), reopened.observation);
        await assert.rejects(reopened.publish(), error => error.code === 'DEPLOYMENT_WINDOWS_HANDOFF_PREPARATION_REFUSED');
        assert.deepEqual((await reopened.check()).prepared, retainedDescriptor);
      } finally { await reopened.close(); }
      const commitArgs = [
        '-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./deployment-windows-history-handoff-commit.ps1', import.meta.url)),
        '-Source', source, '-Control', control,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', await processIdentity(process.pid),
        '-AttemptId', handoffOptions.attemptId, '-OperationId', handoffOptions.operationId,
        '-CreatedAt', handoffOptions.createdAt, '-PreparedDev', retainedDescriptor.dev,
        '-PreparedIno', retainedDescriptor.ino, '-PreparedBytes', String(retainedDescriptor.bytes),
        '-PreparedSha256', retainedDescriptor.sha256,
      ];
      await assert.rejects(promisify(execFile)(pwsh, [...commitArgs, '-Token', randomUUID()],
        { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
      error => error.message.includes('Handoff lock commit failed; retain evidence.'));
      assert.equal((await readdir(control)).includes('lock'), false);
      const committedPublication = await promisify(execFile)(pwsh,
        [...commitArgs, '-Token', handoffOptions.token],
        { timeout: 45000, maxBuffer: 131072, windowsHide: true });
      assert.equal(committedPublication.stderr, '');
      const committedDescriptor = JSON.parse(committedPublication.stdout);
      assert.equal(committedDescriptor.path, `inactive-handoff-${handoffOptions.attemptId}-committed.json`);
      const committedFile = path.join(control, committedDescriptor.path);
      const committedBytes = await readFile(committedFile);
      const committedIdentity = await lstat(committedFile, { bigint: true });
      assert.equal(committedDescriptor.bytes, committedBytes.length);
      assert.equal(committedDescriptor.sha256, createHash('sha256').update(committedBytes).digest('hex'));
      assert.equal(committedDescriptor.dev, committedIdentity.dev.toString());
      assert.equal(committedDescriptor.ino, committedIdentity.ino.toString());
      const committed = JSON.parse(committedBytes);
      const retainedRecord = captureWindowsStoppedHistoryHandoffPrepared(JSON.parse(retainedBytes));
      assert.deepEqual(Object.keys(committed).sort(), [
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'newOwner', 'lockIdentity', 'lock', 'creator', 'committedAt',
      ].sort());
      assert.equal(committed.version, 1);
      assert.equal(committed.phase, 'stopped-history-handoff-committed');
      assert.equal(committed.attemptId, handoffOptions.attemptId);
      assert.equal(committed.control, control);
      assert.equal(committed.project, retainedRecord.project);
      assert.deepEqual(committed.controlIdentity, retainedRecord.controlIdentity);
      assert.equal(committed.previousOperationId, retainedRecord.previousOperationId);
      assert.deepEqual(committed.prepared, retainedDescriptor);
      assert.deepEqual(committed.newOwner, retainedRecord.newOwner);
      assert.deepEqual(Object.keys(committed.creator).sort(),
        ['pid', 'processIdentity', 'bridgePid', 'bridgeIdentity'].sort());
      assert.equal(committed.creator.pid, process.pid);
      assert.equal(committed.creator.processIdentity, await processIdentity(process.pid));
      assert.notEqual(committed.creator.bridgePid, process.pid);
      assert.match(committed.creator.bridgeIdentity, new RegExp(`^${committed.creator.bridgePid}:[1-9][0-9]*$`));
      assert.match(committed.committedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.ok(Date.parse(committed.committedAt) >= Date.parse(retainedRecord.newOwner.createdAt));
      const lockDirectory = path.join(control, 'lock');
      const lockFile = path.join(lockDirectory, 'owner.json');
      const lockBytes = await readFile(lockFile);
      const lockIdentity = await lstat(lockDirectory, { bigint: true });
      const ownerIdentity = await lstat(lockFile, { bigint: true });
      assert.deepEqual(committed.lockIdentity, { dev: lockIdentity.dev.toString(), ino: lockIdentity.ino.toString() });
      assert.deepEqual(committed.lock, {
        path: 'lock\\owner.json', dev: ownerIdentity.dev.toString(), ino: ownerIdentity.ino.toString(),
        bytes: lockBytes.length, sha256: createHash('sha256').update(lockBytes).digest('hex'),
      });
      const actualOwner = JSON.parse(lockBytes);
      assert.deepEqual(actualOwner, retainedRecord.newOwner);
      await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
      const { releaseLock } = await load('state.mjs');
      await assert.rejects(releaseLock(control, actualOwner, { pwsh, admission }));
      await assert.rejects(promisify(execFile)(pwsh, [...commitArgs, '-Token', handoffOptions.token],
        { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
      error => error.message.includes('Private configuration digest differs.'));
      assert.deepEqual(await readFile(committedFile), committedBytes);
      const committedAfter = await lstat(committedFile, { bigint: true });
      assert.equal(committedAfter.dev, committedIdentity.dev);
      assert.equal(committedAfter.ino, committedIdentity.ino);
      assert.deepEqual(await readFile(lockFile), lockBytes);
      const ownerAfter = await lstat(lockFile, { bigint: true });
      assert.equal(ownerAfter.dev, ownerIdentity.dev);
      assert.equal(ownerAfter.ino, ownerIdentity.ino);
      const directoryAfter = await lstat(lockDirectory, { bigint: true });
      assert.equal(directoryAfter.dev, lockIdentity.dev);
      assert.equal(directoryAfter.ino, lockIdentity.ino);
      assert.deepEqual(await readFile(retainedFile), retainedBytes);
      const preparedAfterCommit = await lstat(retainedFile, { bigint: true });
      assert.equal(preparedAfterCommit.dev, retainedFileIdentity.dev);
      assert.equal(preparedAfterCommit.ino, retainedFileIdentity.ino);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      await unlink(committedFile);
      await unlink(lockFile);
      await rmdir(lockDirectory);
      console.log('PASS: native handoff commit publishes exact new owner lock and immutable receipt while preserving old state and ordinary refusal gates');
      assert.deepEqual(await readFile(retainedFile), retainedBytes);
      const afterClose = await lstat(retainedFile, { bigint: true });
      assert.equal(afterClose.dev, retainedFileIdentity.dev);
      assert.equal(afterClose.ino, retainedFileIdentity.ino);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      assert.equal((await readdir(control)).includes('lock'), false);
      await unlink(retainedFile);
      console.log('PASS: production retained native preparation bridge publishes descriptor-only evidence under original admission without lock authority');
      console.log('PASS: controlled preparation reopen retains exact evidence for its original live owner and rejects a fresh actor');
    }
    if (retainedCompletion) {
      assert.deepEqual(completionBytes, retainedCompletion.bytes);
      const current = await lstat(completionFile, { bigint: true });
      assert.equal(current.dev, retainedCompletion.identity.dev);
      assert.equal(current.ino, retainedCompletion.identity.ino);
    }
    const completion = JSON.parse(completionBytes);
    assert.equal(completion.phase, 'stopped-history-archive-complete');
    assert.equal(completion.operationId, intent.operationId);
    assert.equal(completion.intentSha256, createHash('sha256').update(originalIntent).digest('hex'));
    const changedCompletion = Buffer.from(JSON.stringify({ ...completion, stateSha256: '0'.repeat(64) }));
    await writeFile(completionFile, changedCompletion);
    try {
      await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
      assert.deepEqual(await readFile(completionFile), changedCompletion);
    } finally { await writeFile(completionFile, completionBytes); }
    if (restartStateWrittenResume || restartStateDeadResume) {
      // The actual write replaced the original state inode; only its bytes were restored in place, so
      // identity-pinned generic archive readers must refuse without the explicit ninth-record transition.
      await assert.rejects(api.openWindowsInactiveRollbackHistoryArchive(options));
    } else {
      const proof = await api.openWindowsInactiveRollbackHistoryArchive(options);
      try {
        assert.equal((await proof.check()).status, 'retired');
        assert.equal(proof.completeHistory, undefined);
      }
      finally { await proof.close(); }
    }
    await assert.rejects(api.openWindowsInactiveRollbackHistoryRetirement(options));
    const { requireNoServiceMaintenance } = await load('state.mjs');
    await assert.rejects(requireNoServiceMaintenance(control));
    assert.deepEqual(await readFile(completionFile), completionBytes);
    await unlink(completionFile);
    const restoredIntent = await promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./deployment-windows-history-archive-entry.ps1', import.meta.url)),
      '-Source', source, '-Control', control, '-Name', 'inactive-rollback-history-intent.json',
      '-Intent', '-OperationId', intent.operationId, '-Restore'],
    { timeout: 60000, maxBuffer: 8192 });
    assert.equal(restoredIntent.stderr, '');
    assert.deepEqual(await readFile(intentFile), originalIntent);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
    for (const entry of [...intent.entries].reverse()) {
      const restored = await promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('./deployment-windows-history-archive-entry.ps1', import.meta.url)),
        '-Source', source, '-Control', control, '-Name', entry.path, '-Restore'],
      { timeout: 60000, maxBuffer: 8192 });
      assert.equal(restored.stderr, '');
    }
    await restoreOriginalRuntimePaths();
    return;
  }
  if (mode === 'resume-workers' || mode === 'resume-worker-publication') {
    await finishWorkers(options);
    return;
  }
  if (mode === 'resume-retirement') {
    const marker = await readFile(path.join(control, 'inactive-rollback-retirement.json'));
    const record = JSON.parse(marker);
    const receipt = await readFile(path.join(control, 'inactive-rollback-complete.json'));
    assert.equal(createHash('sha256').update(state).digest('hex'), record.stateSha256);
    assert.equal(createHash('sha256').update(receipt).digest('hex'), record.completionSha256);
    assert.deepEqual((await readdir(path.join(control, 'task-maintenance'))).sort(),
      record.entries.slice(1).map(entry => path.basename(entry.path)));
    const history = path.join(control, 'task-maintenance');
    const foreign = path.join(history, 'foreign-retirement-fixture.json');
    await writeFile(foreign, '{}', { flag: 'wx' });
    try { await assert.rejects(api.openWindowsInactiveRollbackRetirement(options)); }
    finally { await unlink(foreign); }
    const target = path.join(control, record.entries[2].path);
    const held = path.join(control, 'fixture-retirement-original.json');
    const bytes = await readFile(target);
    await rename(target, held);
    try {
      await assert.rejects(api.openWindowsInactiveRollbackRetirement(options));
      await writeFile(target, bytes, { flag: 'wx' });
      try { await assert.rejects(api.openWindowsInactiveRollbackRetirement(options)); }
      finally { await unlink(target); }
    } finally { await rename(held, target); }
    await drainRetirement(options, record.entries, state, receipt, marker);
    return;
  }
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
      assert.equal(retirement.version, 2);
      assert.equal(retirement.phase, 'task-retirement-prepared');
      assert.equal(retirement.operationId, reopened.observation.operationId);
      assert.equal(retirement.completionSha256, createHash('sha256').update(receiptBefore).digest('hex'));
      assert.equal(retirement.stateSha256, createHash('sha256').update(expectedFinalState).digest('hex'));
      assert.deepEqual(retirement.entries, entries);
      const admissionEntry = entries.find(entry => entry.path === path.join('task-maintenance', 'admission.json'));
      assert.equal(createHash('sha256').update(retirement.checkpoint.admission).digest('hex'), admissionEntry.sha256);
      assert.equal(retirement.checkpoint.state.sha256, retirement.stateSha256);
      assert.equal(retirement.checkpoint.completion.sha256, retirement.completionSha256);
      assert.equal(retirement.checkpoint.taskReceipt.sha256, retirement.taskReceiptSha256);
      assert.deepEqual(Object.keys(retirement.checkpoint.runtime),
        ['pid', 'identity', 'generation', 'instanceGuid', 'sessionId', 'configurationSha256', 'launcherPid', 'readySha256']);
      assert.deepEqual(Object.keys(retirement.checkpoint.retiredRuntime),
        ['pid', 'identity', 'generation', 'sessionId', 'configurationSha256', 'launcherPid', 'readySha256']);
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
      console.log(`INACTIVE_ROLLBACK_RETIREMENT_HELD ${JSON.stringify({ ...nextCleanup.identity, prefix: 1 })}`);
      const timer = setInterval(() => {}, 1000);
      try { await new Promise(() => {}); } finally { clearInterval(timer); }
    } finally { await nextCleanup.close(); }
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
  progress('opening-original-authority');
  const scope = await api.openWindowsInactiveLostRuntimeAuthority(options);
  const original = JSON.parse(state);
  let restoredBundle;
  let preparedHandoff;
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
    progress('snapshot-inspected');
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
    progress('intent-prepared');
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
      assert.equal(typeof api.prepareWindowsInactiveRollbackRuntimeHandoff, 'function',
        'Missing durable preparation of co-located runtime evidence');
      const handoffOptions = { ...options, scope, acceptDataLoss: true };
      await assert.rejects(api.prepareWindowsInactiveRollbackRuntimeHandoff({
        ...handoffOptions, acceptDataLoss: false,
      }));
      await assert.rejects(api.prepareWindowsInactiveRollbackRuntimeHandoff({
        ...handoffOptions, scope: { ...scope },
      }));
      const handoff = await api.prepareWindowsInactiveRollbackRuntimeHandoff(handoffOptions);
      progress('runtime-evidence-prepared');
      assert.equal(handoff.file, path.join(control, 'inactive-rollback-runtime-handoff.json'));
      const handoffBytes = await readFile(handoff.file);
      assert.equal(handoff.sha256, createHash('sha256').update(handoffBytes).digest('hex'));
      const checkpoint = JSON.parse(handoffBytes);
      preparedHandoff = { handoff, checkpoint, bytes: handoffBytes };
      assert.equal(checkpoint.version, 1);
      assert.equal(checkpoint.phase, 'runtime-evidence-prepared');
      assert.equal(checkpoint.operationId, original.operationId);
      assert.equal(checkpoint.stateSha256, scope.observation.stateSha256);
      assert.equal(checkpoint.completionSha256, scope.observation.completionSha256);
      assert.equal(checkpoint.configuration, binding.runtime.task.configuration);
      assert.equal(checkpoint.configurationSha256, binding.runtime.task.configurationSha256);
      const evidence = path.join(control, 'inactive-rollback-runtime-evidence');
      assert.deepEqual((await readdir(evidence)).sort(),
        checkpoint.entries.map(entry => path.basename(entry.path)).sort());
      for (const entry of checkpoint.entries) {
        const archived = path.join(control, entry.path);
        assert.equal(createHash('sha256').update(await readFile(archived)).digest('hex'), entry.sha256);
        const name = path.basename(entry.path);
        const member = binding.runtime.files.find(file => file.name === name);
        let expected = member?.file;
        if (!member) {
          assert.equal(name, `runtime-${checkpoint.runtimeIdentity.replaceAll(':', '-')}.json`);
          const relative = path.relative(original.project, path.join(path.dirname(checkpoint.configuration), name));
          assert.ok(binding.snapshot.entries.some(entry => entry.path === relative.split(path.sep).join('/')
            && entry.sha256 === checkpoint.readySha256));
          expected = path.join(control, 'backup', 'files', relative);
        }
        assert.deepEqual(await readFile(archived), await readFile(expected));
        const info = await lstat(archived, { bigint: true });
        assert.equal(String(info.dev), entry.dev);
        assert.equal(String(info.ino), entry.ino);
      }
      assert.deepEqual(await api.prepareWindowsInactiveRollbackRuntimeHandoff(handoffOptions), handoff);
      assert.deepEqual(await readFile(handoff.file), handoffBytes);
      assert.deepEqual(await scope.check(), scope.observation);
      const names = (await readdir(original.project, { recursive: true })).sort();
      const files = await Promise.all((await readdir(original.project, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile()).map(async entry => {
          const file = path.join(entry.parentPath, entry.name);
          return [file, await readFile(file)];
        }));
      await assert.rejects(api.restoreWindowsInactiveRollbackProject({ ...options, scope, acceptDataLoss: false }));
      assert.deepEqual((await readdir(original.project, { recursive: true })).sort(), names);
      for (const [file, bytes] of files) {
        assert.deepEqual(await readFile(file), bytes);
      }
    }
    if (!preparedHandoff) {
      await api.releaseWindowsInactiveRollbackRuntimeHandoff({ ...options, scope, acceptDataLoss: true });
    }
    let restored;
    let copyCrash;
    if (mode === 'crash-project') {
      assert.ok(preparedHandoff, 'Copy crash must exercise the original co-located runtime');
      const { armWindowsInactiveCopyCrash } = await import('./deployment-windows-inactive-copy-crash.mjs');
      copyCrash = armWindowsInactiveCopyCrash({
        project: original.project, control, snapshot: binding.snapshot, scope,
        actorIdentity: await processIdentity(process.pid),
      });
    }
    try {
      progress('restoring-project');
      restored = await api.restoreWindowsInactiveRollbackProject({ ...options, scope, acceptDataLoss: true });
    } finally { copyCrash?.close(); }
    assert.notEqual(mode, 'crash-project', 'Original co-located copy actor returned without actually dying');
    assert.equal(restored.status, 'project-restored');
    progress('project-restored');
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
    progress('runtime-restored');
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
    assert.deepEqual(await readFile(intent.file), intentBytes);
    assert.deepEqual(await scope.check(), scope.observation);
  } finally { await scope.close(); }
  assert.notEqual(await processIdentity(scope.identity.pid), scope.identity.processIdentity);
  await assert.rejects(scope.check());
  if (preparedHandoff) {
    progress('checking-handoff-reentry');
    const { handoff, checkpoint, bytes } = preparedHandoff;
    const changed = await api.openWindowsInactiveLostRuntimeAuthority(options);
    const foreign = path.join(control, 'inactive-rollback-runtime-evidence', 'foreign-handoff-fixture');
    try {
      await writeFile(foreign, 'foreign evidence', { flag: 'wx' });
      await assert.rejects(changed.check(), { code: 'DEPLOYMENT_WINDOWS_COMPLETION_RECOVERY_REFUSED' });
      await assert.rejects(api.openWindowsInactiveLostRuntimeAuthority(options),
        { code: 'DEPLOYMENT_WINDOWS_COMPLETION_RECOVERY_REFUSED' });
      assert.deepEqual(await readFile(handoff.file), bytes);
    } finally {
      await changed.close();
      await unlink(foreign);
    }
    const target = path.join(control, checkpoint.entries[0].path);
    const originalEntry = path.join(control, 'runtime-handoff-inode-fixture');
    const originalBytes = await readFile(target);
    await rename(target, originalEntry);
    try {
      await writeFile(target, originalBytes, { flag: 'wx' });
      await assert.rejects(api.openWindowsInactiveLostRuntimeAuthority(options),
        { code: 'DEPLOYMENT_WINDOWS_COMPLETION_RECOVERY_REFUSED' });
      assert.deepEqual(await readFile(handoff.file), bytes);
    } finally {
      await unlink(target);
      await rename(originalEntry, target);
    }
    const next = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      assert.deepEqual(await api.prepareWindowsInactiveRollbackRuntimeHandoff({
        ...options, scope: next, acceptDataLoss: true,
      }), handoff);
      assert.deepEqual(await readFile(handoff.file), bytes);
      assert.deepEqual(await next.check(), next.observation);
      assert.equal(typeof api.releaseWindowsInactiveRollbackRuntimeHandoff, 'function',
        'Missing retained runtime handoff before original configuration removal');
      await assert.rejects(api.releaseWindowsInactiveRollbackRuntimeHandoff({
        ...options, scope: next, acceptDataLoss: false,
      }));
      await assert.rejects(api.releaseWindowsInactiveRollbackRuntimeHandoff({
        ...options, scope: { ...next }, acceptDataLoss: true,
      }));
      const released = await api.releaseWindowsInactiveRollbackRuntimeHandoff({
        ...options, scope: next, acceptDataLoss: true,
      });
      progress('release-reentry-verified');
      assert.equal(released.file, path.join(control, 'inactive-rollback-runtime-released.json'));
      const releasedBytes = await readFile(released.file);
      assert.equal(released.sha256, createHash('sha256').update(releasedBytes).digest('hex'));
      const releaseRecord = JSON.parse(releasedBytes);
      assert.equal(releaseRecord.phase, 'runtime-evidence-released');
      assert.equal(releaseRecord.preparedSha256, handoff.sha256);
      assert.equal(releaseRecord.operationId, original.operationId);
      const missing = path.join(control, 'original-runtime-configuration-fixture');
      const readiness = path.join(path.dirname(checkpoint.configuration),
        `runtime-${checkpoint.runtimeIdentity.replaceAll(':', '-')}.json`);
      const missingReadiness = path.join(control, 'original-runtime-readiness-fixture');
      await rename(checkpoint.configuration, missing);
      let readinessMoved = false;
      try {
        await rename(readiness, missingReadiness);
        readinessMoved = true;
        await assert.rejects(readFile(checkpoint.configuration), { code: 'ENOENT' });
        await assert.rejects(readFile(readiness), { code: 'ENOENT' });
        assert.deepEqual(await next.check(), next.observation);
        assert.equal(await processIdentity(next.identity.pid), next.identity.processIdentity);
        assert.equal(process.kill(next.identity.pid, 'SIGKILL'), true);
        progress('source-absent-bridge-killed');
        await assert.rejects(next.check(), { code: 'DEPLOYMENT_WINDOWS_COMPLETION_RECOVERY_REFUSED' });
        progress('source-absent-dead-check-refused');
        assert.notEqual(await processIdentity(next.identity.pid), next.identity.processIdentity);
        progress('source-absent-bridge-absence-verified');
        const fresh = await api.openWindowsInactiveLostRuntimeAuthority(options);
        progress('source-absent-fresh-authority');
        try {
          assert.deepEqual(await api.prepareWindowsInactiveRollbackRuntimeHandoff({
            ...options, scope: fresh, acceptDataLoss: true,
          }), handoff);
          assert.deepEqual(await api.releaseWindowsInactiveRollbackRuntimeHandoff({
            ...options, scope: fresh, acceptDataLoss: true,
          }), released);
          assert.deepEqual(await readFile(handoff.file), bytes);
          assert.deepEqual(await readFile(released.file), releasedBytes);
          assert.deepEqual(await fresh.check(), fresh.observation);
        } finally { await fresh.close(); }
      } finally {
        try { if (readinessMoved) await rename(missingReadiness, readiness); }
        finally { await rename(missing, checkpoint.configuration); }
      }
    } finally { await next.close(); }
  }
  if (restoredBundle) {
    progress('checking-runtime-reentry');
    const next = await api.openWindowsInactiveLostRuntimeAuthority(options);
    try {
      const foreign = path.join(restoredBundle.directory, 'foreign-reentry-test.txt');
      await writeFile(foreign, 'untrusted publication', { flag: 'wx' });
      try {
        await assert.rejects(api.restoreWindowsInactiveRollbackExternal({
          ...options, scope: next, acceptDataLoss: true,
        }), { code: 'DEPLOYMENT_WINDOWS_RUNTIME_PUBLICATION_REFUSED' });
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
      progress('restoring-task');
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
      progress('task-restored-boundary');
      await holdTask(next, 'task-restored');
      const task = await api.restoreWindowsInactiveRollbackTask(taskOptions);
      progress('task-restored');
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
      progress('task-replay-verified');
    } finally { await next.close(); }
    assert.notEqual(await processIdentity(next.identity.pid), next.identity.processIdentity);
  }
});
if (!deferredHandoffCloseout) {
  assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedFinalState);
  console.log('PASS: owned lost-runtime rollback rejects foreign authority and preserves only its authorized state outcome');
}
