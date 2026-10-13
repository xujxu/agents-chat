import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokePublicWindowsRestore } from './deployment-windows-public-restore.mjs';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

export async function verifyWindowsColdPublicCloseout({ directory, project, control, taskName, pwsh, chatId, boundary }) {
  assert.ok(['completion', 'state', 'receipt'].includes(boundary));
  const completion = boundary === 'completion';
  const terminalPath = path.join(control, 'cold-restore-terminal.json');
  const terminal = completion ? null : JSON.parse(await readFile(terminalPath));
  const activation = completion
    ? JSON.parse(await readFile(path.join(control, 'recovery-lock/activation-intent.json'))).state : null;
  const runtime = completion
    ? JSON.parse(await readFile(path.join(control, 'recovery-lock/activation-running.json'))).runtime : terminal.runtime;
  const state = completion ? { ...activation, phase: 'restored', previousPhase: 'restore-activating' }
    : JSON.parse(terminal.nextState);
  const stateBytes = await readFile(path.join(control, 'state.json'));
  const originalState = JSON.parse(stateBytes);
  if (completion) {
    assert.equal(originalState.operation, 'restore');
    assert.equal(originalState.operationId, state.operationId);
    assert.ok(['restoring', 'recovery-required'].includes(originalState.phase));
    assert.equal(JSON.parse(await readFile(path.join(control, 'recovery-lock/completion-release-requested.json'))).phase,
      'release-requested');
    for (const name of ['cold-restore-terminal.json', 'state.json.lock', '.deployment.json.staging',
      'recovery-lock/completion-released.json']) {
      await assert.rejects(lstat(path.join(control, name)), { code: 'ENOENT' });
    }
  } else {
    assert.equal(stateBytes.toString('utf8'), boundary === 'state' ? terminal.oldState : terminal.nextState);
  }
  const preservedNames = boundary === 'receipt' ? ['state.json', 'backup/manifest.json'] : ['backup/manifest.json'];
  const preserved = new Map(await Promise.all(preservedNames.map(async name => {
    const file = path.join(control, name);
    return [name, { bytes: await readFile(file), info: await lstat(file, { bigint: true }) }];
  })));
  const backup = JSON.parse(preserved.get('backup/manifest.json').bytes);
  const stage = path.join(control, boundary === 'state' ? 'state.json.lock' : '.deployment.json.staging');
  const staged = completion ? null : { bytes: await readFile(stage), info: await lstat(stage, { bigint: true }) };
  if (boundary === 'receipt') {
    const receipt = JSON.parse(staged.bytes);
    assert.equal(receipt.operationId, state.operationId);
    assert.equal(receipt.acceptedAt, state.updatedAt);
  } else if (boundary === 'state') {
    assert.equal(staged.bytes.toString('utf8'), terminal.nextState);
    await assert.rejects(lstat(path.join(control, '.deployment.json.staging')), { code: 'ENOENT' });
  }
  assert.notEqual(JSON.parse(await readFile(path.join(control, 'deployment.json'))).operationId, state.operationId);
  await assert.rejects(lstat(path.join(control, 'worker-retirement.json')), { code: 'ENOENT' });
  const { verifyRecoveryEngine } = await import(pathToFileURL(
    path.join(directory, 'scripts/deployment/saved-recovery-engine.mjs')));
  const saved = await verifyRecoveryEngine({ control, manifestSha256: backup.recoveryEngine });
  await verifyWindowsApplicationApi('restored', chatId);
  process.stderr.write(`${new Date().toISOString()} Actual public cold restore: recovering ${boundary} through final closeout\n`);
  const output = await invokePublicWindowsRestore({ project, taskName, pwsh });
  assert.equal(output.code, 0, JSON.stringify(output.result));
  const result = output.result;
  assert.equal(result.status, 'restored');
  assert.equal(result.operationId, state.operationId);
  assert.equal(result.backupId, backup.id);
  assert.equal(result.recoveryEngine, backup.recoveryEngine);
  assert.equal(result.closeoutRequired, false);
  assert.equal(result.closeoutStatus, 'completed');
  assert.equal(result.runtimeRelocated, true);
  if (!completion) {
    const publication = path.join(control, boundary === 'state' ? 'state.json' : 'deployment.json');
    assert.deepEqual(await readFile(publication), staged.bytes);
    const published = await lstat(publication, { bigint: true });
    for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(published[key], staged.info[key], `${boundary}: ${key}`);
    assert.equal((await readFile(path.join(control, 'state.json'))).toString('utf8'), terminal.nextState);
  }
  const finalState = JSON.parse(await readFile(path.join(control, 'state.json')));
  if (completion) {
    assert.deepEqual(finalState, { ...state, updatedAt: finalState.updatedAt });
    assert.equal(new Date(finalState.updatedAt).toISOString(), finalState.updatedAt);
    assert.ok(Date.parse(finalState.updatedAt) >= Math.max(Date.parse(originalState.updatedAt), Date.parse(activation.updatedAt)));
    assert.ok(Date.parse(finalState.updatedAt) <= Date.now());
  }
  const receipt = JSON.parse(await readFile(path.join(control, 'deployment.json')));
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.project, project);
  assert.equal(receipt.operationId, state.operationId);
  assert.equal(receipt.acceptedAt, finalState.updatedAt);
  assert.equal(receipt.identity.source, state.targetCommit);
  for (const key of ['build', 'dependencies', 'config', 'service']) assert.match(receipt.identity[key], /^[a-f0-9]{64}$/);
  for (const [name, before] of preserved) {
    const file = path.join(control, name);
    assert.deepEqual(await readFile(file), before.bytes);
    const after = await lstat(file, { bigint: true });
    for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(after[key], before.info[key], `${name}: ${key}`);
  }
  const names = await readdir(control);
  for (const name of ['task-maintenance', 'recovery-lock', 'worker-engine', 'worker-operation.ndjson',
    'cold-restore-terminal.json', 'lock', 'worker-retirement.json', '.deployment.json.staging', 'state.json.lock']) {
    assert.equal(names.includes(name), false, name);
  }
  assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: backup.recoveryEngine }), saved);
  await verifyWindowsApplicationApi('restored', chatId);
  return { ...result, status: `cold-${boundary}-closeout-completed`, boundary: 'complete', runtime, lease: 'released' };
}
