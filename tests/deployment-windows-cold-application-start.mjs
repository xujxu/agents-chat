import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokePublicWindowsRestore } from './deployment-windows-public-restore.mjs';
import { assertWindowsRestoredProjectBytes } from './deployment-windows-restore-evidence.mjs';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

export async function verifyWindowsColdPublicStartup({ directory, project, control, taskName, pwsh, chatId }) {
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
  assert.equal(await processIdentity(proof.runtime.pid), proof.runtime.identity);
  await assert.rejects(lstat(path.join(project, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')), { code: 'ENOENT' });
  for (const name of ['recovery-lock', 'cold-restore-terminal.json', 'worker-retirement.json']) {
    await assert.rejects(lstat(path.join(control, name)), { code: 'ENOENT' });
  }
  const engine = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
  const started = Date.now();
  process.stderr.write(`${new Date().toISOString()} Actual public cold restore: original interrupted copy through startup and independent closeout\n`);
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
    assert.equal(await processIdentity(runtime.pid), runtime.identity);
    await scope.listener({ port: 3010 });
    await scope.check();
    return { ...result, status: 'cold-start-closeout-completed', boundary: 'complete', runtime, lease, retiredRuntime: proof.runtime };
  } finally { await scope.close(); }
}
