import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWindowsLiveRestore({ mode, directory, project, control, taskName, pwsh }) {
  const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)));
  const { verifyRecoveryEngine } = await captured('saved-recovery-engine.mjs');
  const { verifySnapshot } = await captured('snapshot.mjs');
  const { loadState, acquireLock } = await captured('state.mjs');
  const backup = path.join(control, 'backup');
  const snapshot = await verifySnapshot(backup);
  const recovery = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
  const saved = name => import(pathToFileURL(path.join(recovery.directory, name)));
  if (mode === 'restore-closed') {
    const { closeCompletedWindowsDeployment } = await saved('windows-completed-closeout.mjs');
    const state = await loadState(control);
    assert.equal(state.phase, 'restored');
    const result = await closeCompletedWindowsDeployment({
      control, project, operationId: state.operationId, pwsh,
    });
    assert.deepEqual(result, { status: 'completed', operationId: state.operationId, phase: 'restored' });
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
    assert.deepEqual(await verifySnapshot(backup), snapshot);
    return result;
  }
  const { runWindowsLiveRestore } = await saved('windows-restore.mjs');
  const { inspectWindowsManagedTask } = await saved('windows-managed-task.mjs');
  const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
  const errors = [];
  let result;
  try {
    const stateBytes = await readFile(path.join(control, 'state.json'));
    const options = { scope, control, backup, node: process.execPath, pwsh,
      profile: 'agents-chat-auth-638c553', port: 3010, waitSeconds: 120, timeoutSeconds: 900,
      onProgress: ({ phase }) => process.stderr.write(`${new Date().toISOString()} Windows restore phase: ${phase}\n`) };
    await assert.rejects(runWindowsLiveRestore({ ...options, acceptDataLoss: false }), /acknowledgement/i);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
    const lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    result = await runWindowsLiveRestore({ ...options, lock, acceptDataLoss: true });
    assert.equal(result.status, 'restored');
    assert.equal(result.backupId, snapshot.id);
    assert.equal(result.closeoutRequired, true);
    assert.equal(result.runtimeRelocated, true);
    assert.equal(result.recoveryEngine, snapshot.recoveryEngine);
    const state = await loadState(control);
    assert.equal(state.phase, 'restored');
    assert.equal(state.previousPhase, 'restore-activating');
    assert.equal(state.operationId, lock.operationId);
    assert.equal(state.targetCommit, snapshot.source.commit);
    assert.equal(state.backupId, snapshot.id);
    assert.equal(JSON.parse(await readFile(path.join(control, 'deployment.json'))).operationId, lock.operationId);
    await assert.rejects(lstat(path.join(project, 'deployment-live-target.txt')), { code: 'ENOENT' });
    for (const name of ['.env.local', '.next/BUILD_ID', 'package-lock.json',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node']) {
      assert.deepEqual(await readFile(path.join(project, name)), await readFile(path.join(backup, 'files', name)));
    }
    assert.deepEqual(await verifySnapshot(backup), snapshot);
  } catch (error) { errors.push(error); }
  try { await scope.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Actual Windows restore or original scope cleanup failed.');
  return result;
}
