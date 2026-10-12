import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertWindowsRestoredProjectBytes } from './deployment-windows-restore-evidence.mjs';
import { invokePublicWindowsRestore } from './deployment-windows-public-restore.mjs';

export async function verifyWindowsLiveRestore({ mode, directory, project, control, taskName, pwsh, chatId }) {
  if (mode === 'restore-cold-observed') {
    const { verifyWindowsColdApplicationCompletion } = await import('./deployment-windows-cold-application-files.mjs');
    return verifyWindowsColdApplicationCompletion({ directory, control, pwsh, chatId });
  }
  const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)));
  const { verifyRecoveryEngine } = await captured('saved-recovery-engine.mjs');
  const { verifySnapshot } = await captured('snapshot.mjs');
  const { loadState } = await captured('state.mjs');
  const backup = path.join(control, 'backup');
  const snapshot = await verifySnapshot(backup);
  assert.ok(snapshot.entries.some(entry => entry.path === '.env.local' && entry.kind === 'file'),
    'Actual restore must include the original fixture environment file.');
  const recovery = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
  if (mode === 'restore-closed') {
    const state = await loadState(control);
    assert.equal(state.phase, 'restored');
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(path.join(control, 'deployment.json'))).operationId, state.operationId);
    assert.deepEqual(await verifySnapshot(backup), snapshot);
    return { status: 'completed', operationId: state.operationId, phase: 'restored' };
  }
  if (mode === 'restore-crash-verified') {
    const { verifyWindowsCrashedRestore } = await import('./deployment-windows-crashed-restore.mjs');
    return verifyWindowsCrashedRestore({ project, control, backup, snapshot, recovery });
  }
  if (mode === 'restore-cold-files') {
    const { verifyWindowsColdApplicationFiles } = await import('./deployment-windows-cold-application-files.mjs');
    return verifyWindowsColdApplicationFiles({ directory, project, control, backup, snapshot, pwsh, chatId });
  }
  if (['restore-cancelled', 'restore-failed', 'restore-crashed', 'restore-copy-crashed'].includes(mode)) {
    const { verifyWindowsInterruptedRestore } = await import('./deployment-windows-interrupted-restore.mjs');
    return verifyWindowsInterruptedRestore({
      scenario: mode.slice('restore-'.length), project, control, backup, snapshot, recovery, taskName, pwsh,
    });
  }
  const stateBytes = await readFile(path.join(control, 'state.json'));
  const refused = await invokePublicWindowsRestore({ project, taskName, pwsh, acknowledge: false });
  assert.equal(refused.code, 1);
  assert.equal(refused.result.code, 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED');
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  const output = await invokePublicWindowsRestore({ project, taskName, pwsh });
  assert.equal(output.code, 0, JSON.stringify(output.result));
  const result = output.result;
  process.stderr.write(`${new Date().toISOString()} Public Windows restore and independent closeout completed; verifying restored state and bytes\n`);
  assert.equal(result.status, 'restored');
  assert.equal(result.backupId, snapshot.id);
  assert.equal(result.closeoutRequired, false);
  assert.equal(result.closeoutStatus, 'completed');
  assert.equal(result.runtimeRelocated, true);
  assert.equal(result.recoveryEngine, snapshot.recoveryEngine);
  const state = await loadState(control);
  assert.equal(state.phase, 'restored');
  assert.equal(state.previousPhase, 'restore-activating');
  assert.equal(state.operationId, result.operationId);
  assert.equal(state.targetCommit, snapshot.source.commit);
  assert.equal(state.backupId, snapshot.id);
  assert.equal(JSON.parse(await readFile(path.join(control, 'deployment.json'))).operationId, result.operationId);
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.join(path.dirname(project), `.${path.basename(project)}.deployment-controllers`)), []);
  await assertWindowsRestoredProjectBytes(project, backup);
  assert.deepEqual(await verifySnapshot(backup), snapshot);
  process.stderr.write(`${new Date().toISOString()} Windows restore assertions and unchanged backup verified\n`);
  return result;
}
