import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokePublicWindowsRestore } from './deployment-windows-public-restore.mjs';
import { assertWindowsRestoredProjectBytes } from './deployment-windows-restore-evidence.mjs';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

export async function verifyWindowsColdPublicStartup({
  directory, project, control, taskName, pwsh, chatId, interruptedStartup = false, unacknowledgedStartup = false,
}) {
  assert.ok(!unacknowledgedStartup || interruptedStartup);
  const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)));
  const { verifyRecoveryEngine } = await captured('saved-recovery-engine.mjs');
  const { inspectWindowsManagedTask } = await captured('windows-managed-task.mjs');
  const { processIdentity } = await captured('process-identity.mjs');
  const backupPath = path.join(control, 'backup/manifest.json');
  const before = { bytes: await readFile(backupPath), info: await lstat(backupPath, { bigint: true }) };
  const snapshot = JSON.parse(before.bytes);
  const originalState = JSON.parse(await readFile(path.join(control, 'state.json')));
  const proof = JSON.parse(await readFile(path.join(control, 'restore-crash-fixture.json')));
  assert.equal(proof.scenario, 'copy-crashed');
  assert.equal(originalState.operationId, proof.lock.operationId);
  assert.equal(originalState.runtimeIdentity, proof.runtime.generation);
  let interruptedRuntime;
  let journalIdentity;
  let journalFiles;
  let launchFile;
  const priorArchives = (await readdir(control)).filter(name => name.startsWith('cold-policy-')).sort();
  if (interruptedStartup) {
    assert.notEqual(await processIdentity(proof.runtime.pid), proof.runtime.identity);
    const journal = path.join(control, 'recovery-lock');
    if (unacknowledgedStartup) {
      await assert.rejects(lstat(path.join(journal, 'activation-running.json')), { code: 'ENOENT' });
      const requested = JSON.parse(await readFile(path.join(journal, 'activation-start-requested.json')));
      assert.equal(requested.runtime, null);
      const bundle = path.dirname(requested.configuration);
      const launchNames = (await readdir(bundle)).filter(name => /^launch-.*\.json$/i.test(name));
      assert.equal(launchNames.length, 1);
      const file = path.join(bundle, launchNames[0]);
      launchFile = { file, bytes: await readFile(file), info: await lstat(file, { bigint: true }) };
      interruptedRuntime = JSON.parse(launchFile.bytes);
      assert.equal(interruptedRuntime.controllerPid, requested.controllerPid);
      assert.equal(interruptedRuntime.controllerIdentity, requested.controllerIdentity);
      assert.equal(interruptedRuntime.configurationSha256, requested.configurationSha256);
      assert.equal(interruptedRuntime.instanceGuid, undefined);
    } else {
      interruptedRuntime = JSON.parse(await readFile(path.join(journal, 'activation-running.json'))).runtime;
    }
    assert.notEqual(await processIdentity(interruptedRuntime.pid), interruptedRuntime.identity);
    journalIdentity = await lstat(journal, { bigint: true });
    journalFiles = await Promise.all((await readdir(journal)).map(async name => ({
      name, bytes: await readFile(path.join(journal, name)), info: await lstat(path.join(journal, name), { bigint: true }),
    })));
    assert.equal(journalFiles.some(file => file.name.startsWith('completion-')), false);
  } else {
    assert.equal(await processIdentity(proof.runtime.pid), proof.runtime.identity);
    await assert.rejects(lstat(path.join(project, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(control, 'recovery-lock')), { code: 'ENOENT' });
  }
  for (const name of ['cold-restore-terminal.json', 'worker-retirement.json']) {
    await assert.rejects(lstat(path.join(control, name)), { code: 'ENOENT' });
  }
  const engine = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
  const started = Date.now();
  process.stderr.write(`${new Date().toISOString()} Actual public cold restore: ${interruptedStartup ? 'interrupted guarded startup' : 'original interrupted copy'} through independent closeout\n`);
  const output = await invokePublicWindowsRestore({ project, taskName, pwsh, timeoutMs: 3500000 });
  assert.equal(output.code, 0, JSON.stringify(output.result));
  const result = output.result;
  assert.equal(result.status, 'restored');
  assert.equal(result.operationId, originalState.operationId);
  assert.equal(result.backupId, snapshot.id);
  assert.equal(result.recoveryEngine, snapshot.recoveryEngine);
  assert.equal(result.closeoutRequired, false);
  assert.equal(result.closeoutStatus, 'completed');
  assert.equal(result.runtimeRelocated, true);
  const state = JSON.parse(await readFile(path.join(control, 'state.json')));
  assert.deepEqual(state, {
    version: 1, operationId: originalState.operationId, project, operation: 'restore',
    phase: 'restored', previousPhase: 'restore-activating', sourceCommit: originalState.sourceCommit,
    targetCommit: snapshot.source.commit, backupId: snapshot.id, priorRuntime: 'running',
    runtimeIdentity: originalState.runtimeIdentity, startedAt: state.startedAt, updatedAt: state.updatedAt, errorCode: null,
  });
  for (const time of [state.startedAt, state.updatedAt]) assert.equal(new Date(time).toISOString(), time);
  assert.ok(Date.parse(state.startedAt) >= started);
  assert.ok(Date.parse(state.updatedAt) >= Date.parse(state.startedAt) && Date.parse(state.updatedAt) <= Date.now());
  const receipt = JSON.parse(await readFile(path.join(control, 'deployment.json')));
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.project, project);
  assert.equal(receipt.operationId, state.operationId);
  assert.equal(receipt.acceptedAt, state.updatedAt);
  assert.equal(receipt.identity.source, snapshot.source.commit);
  for (const key of ['build', 'dependencies', 'config', 'service']) assert.match(receipt.identity[key], /^[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(backupPath), before.bytes);
  const after = await lstat(backupPath, { bigint: true });
  for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(after[key], before.info[key]);
  assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine }), engine);
  await assertWindowsRestoredProjectBytes(project, path.join(control, 'backup'));
  await verifyWindowsApplicationApi('restored', chatId);
  const names = await readdir(control);
  if (interruptedStartup) {
    const archives = names.filter(name => name.startsWith('cold-policy-') && !priorArchives.includes(name));
    assert.equal(archives.length, 1);
    const archive = path.join(control, archives[0]);
    const identity = await lstat(archive, { bigint: true });
    for (const key of ['dev', 'ino']) assert.equal(identity[key], journalIdentity[key]);
    const archivedNames = await readdir(archive);
    assert.ok(archivedNames.some(name => /^policy-[0-9]{6}\.json$/.test(name)));
    for (const file of journalFiles) {
      assert.deepEqual(await readFile(path.join(archive, file.name)), file.bytes);
      const info = await lstat(path.join(archive, file.name), { bigint: true });
      for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(info[key], file.info[key]);
    }
    assert.deepEqual(names.filter(name => name.startsWith('cold-policy-') && !archives.includes(name)).sort(), priorArchives);
    if (launchFile) {
      assert.equal(archivedNames.includes('activation-running.json'), false);
      assert.deepEqual(await readFile(launchFile.file), launchFile.bytes);
      const info = await lstat(launchFile.file, { bigint: true });
      for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(info[key], launchFile.info[key]);
    }
  }
  for (const name of ['task-maintenance', 'recovery-lock', 'worker-engine', 'worker-operation.ndjson',
    'cold-restore-terminal.json', 'lock', 'worker-retirement.json', '.deployment.json.staging', 'state.json.lock']) {
    assert.equal(names.includes(name), false, name);
  }
  assert.notEqual(await processIdentity(proof.runtime.pid), proof.runtime.identity);
  const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
  try {
    const { runtime, lease, securityDescriptor, enabled } = scope.observation;
    assert.equal(lease, 'released');
    assert.equal(enabled, true);
    assert.equal(securityDescriptor, snapshot.runtime.task.securityDescriptor);
    assert.notEqual(runtime.generation, proof.runtime.generation);
    assert.notEqual(runtime.instanceGuid, proof.runtime.instanceGuid);
    if (interruptedStartup) {
      assert.notEqual(runtime.generation, interruptedRuntime.generation);
      if (!unacknowledgedStartup) assert.notEqual(runtime.instanceGuid, interruptedRuntime.instanceGuid);
      assert.notEqual(await processIdentity(interruptedRuntime.pid), interruptedRuntime.identity);
    }
    assert.equal(await processIdentity(runtime.pid), runtime.identity);
    await scope.listener({ port: 3010 });
    await scope.check();
    return {
      ...result, status: unacknowledgedStartup ? 'cold-launch-closeout-completed'
        : interruptedStartup ? 'cold-startup-closeout-completed' : 'cold-start-closeout-completed',
      boundary: 'complete', runtime, lease, retiredRuntime: proof.runtime,
      ...(interruptedStartup ? { interruptedRuntime } : {}),
    };
  } finally { await scope.close(); }
}
