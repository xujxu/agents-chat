import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, unlink, lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [source, control, pwsh, mode = 'complete', crashStep = 'task-restored', terminalCrashStep = ''] = process.argv.slice(2);
const load = name => import(pathToFileURL(path.join(source, name)).href);
const api = await load('windows-task-completion-recovery.mjs');
const { withWindowsAdmission } = await load('windows-admission.mjs');
const { processIdentity } = await load('process-identity.mjs');
assert.equal(typeof api.openWindowsInactiveLostRuntimeAuthority, 'function',
  'Missing owned inactive lost-runtime transport');
const state = await readFile(path.join(control, 'state.json'));
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
    const movedIntent = await promisify(execFile)(pwsh, intentArgs, { timeout: 60000, maxBuffer: 8192 });
    assert.equal(movedIntent.stderr, '');
    try {
      const { requireNoServiceMaintenance } = await load('state.mjs');
      await assert.rejects(requireNoServiceMaintenance(control));
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
await withWindowsAdmission(control, { pwsh }, async admission => {
  const options = { control, pwsh, admission };
  if (mode === 'crash-history' || mode === 'resume-history') {
    await retainOriginalRuntimeAbsence();
    const intentFile = path.join(control, 'inactive-rollback-history-intent.json');
    const originalIntent = await readFile(intentFile);
    const intent = JSON.parse(originalIntent);
    if (mode === 'resume-history') {
      const previous = JSON.parse(crashStep);
      assert.notEqual(await processIdentity(process.pid), previous.actorIdentity);
      assert.notEqual(await processIdentity(previous.pid), previous.processIdentity);
    }
    const writer = await api.openWindowsInactiveRollbackHistoryRetirement(options);
    try {
      assert.equal(writer.observation.archivedEntries, mode === 'crash-history' ? 0 : 1);
      if (mode === 'crash-history') {
        assert.equal((await writer.advance()).archivedEntries, 1);
        console.log(`INACTIVE_HISTORY_ARCHIVE_HELD ${JSON.stringify({
          ...writer.identity, actorIdentity: await processIdentity(process.pid),
        })}`);
        const timer = setInterval(() => {}, 1000);
        try { await new Promise(() => {}); } finally { clearInterval(timer); }
      }
      for (let prefix = 2; prefix <= intent.entries.length; prefix++) {
        const advanced = await writer.advance();
        assert.equal(advanced.archivedEntries, prefix);
        assert.deepEqual(await writer.check(), advanced);
      }
      assert.equal(writer.observation.status, 'archived');
    } finally { await writer.close(); }
    const proof = await api.openWindowsInactiveRollbackHistoryArchive(options);
    try { assert.equal((await proof.check()).status, 'retired'); }
    finally { await proof.close(); }
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
assert.deepEqual(await readFile(path.join(control, 'state.json')), expectedFinalState);
console.log('PASS: owned lost-runtime rollback rejects foreign authority and preserves only its authorized state outcome');
