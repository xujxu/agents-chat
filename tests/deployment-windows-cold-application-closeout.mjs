import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokePublicWindowsRestore } from './deployment-windows-public-restore.mjs';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

export async function verifyWindowsColdReceiptCloseout({ directory, project, control, taskName, pwsh, chatId }) {
  const preserved = new Map(await Promise.all(['state.json', 'backup/manifest.json'].map(async name => {
    const file = path.join(control, name);
    return [name, { bytes: await readFile(file), info: await lstat(file, { bigint: true }) }];
  })));
  const state = JSON.parse(preserved.get('state.json').bytes);
  const backup = JSON.parse(preserved.get('backup/manifest.json').bytes);
  const terminal = JSON.parse(await readFile(path.join(control, 'cold-restore-terminal.json')));
  const stage = path.join(control, '.deployment.json.staging');
  const staged = { bytes: await readFile(stage), info: await lstat(stage, { bigint: true }) };
  const receipt = JSON.parse(staged.bytes);
  assert.equal(receipt.operationId, state.operationId);
  assert.equal(receipt.acceptedAt, state.updatedAt);
  assert.notEqual(JSON.parse(await readFile(path.join(control, 'deployment.json'))).operationId, state.operationId);
  await assert.rejects(lstat(path.join(control, 'worker-retirement.json')), { code: 'ENOENT' });
  const { verifyRecoveryEngine } = await import(pathToFileURL(
    path.join(directory, 'scripts/deployment/saved-recovery-engine.mjs')));
  const saved = await verifyRecoveryEngine({ control, manifestSha256: backup.recoveryEngine });
  await verifyWindowsApplicationApi('restored', chatId);
  process.stderr.write(`${new Date().toISOString()} Actual public cold restore: recovering staged receipt through final closeout\n`);
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
  assert.deepEqual(await readFile(path.join(control, 'deployment.json')), staged.bytes);
  const published = await lstat(path.join(control, 'deployment.json'), { bigint: true });
  for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(published[key], staged.info[key], `receipt: ${key}`);
  for (const [name, before] of preserved) {
    const file = path.join(control, name);
    assert.deepEqual(await readFile(file), before.bytes);
    const after = await lstat(file, { bigint: true });
    for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(after[key], before.info[key], `${name}: ${key}`);
  }
  const names = await readdir(control);
  for (const name of ['task-maintenance', 'recovery-lock', 'worker-engine', 'worker-operation.ndjson',
    'cold-restore-terminal.json', 'lock', 'worker-retirement.json', '.deployment.json.staging']) {
    assert.equal(names.includes(name), false, name);
  }
  assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: backup.recoveryEngine }), saved);
  await verifyWindowsApplicationApi('restored', chatId);
  return { ...result, status: 'cold-receipt-closeout-completed', boundary: 'complete', runtime: terminal.runtime, lease: 'released' };
}
