import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { interruptWindowsColdApplication } from './deployment-windows-cold-application-recovery.mjs';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

export async function verifyWindowsColdApplicationReceipt({ mode, directory, control, pwsh, chatId }) {
  const target = {
    'restore-cold-receipt-staged': 'receipt-staged',
    'restore-cold-receipt-published': 'receipt-published',
    'restore-cold-receipt-completed': 'complete',
  }[mode];
  assert.ok(target);
  const { recoverWindowsColdRestoredDeploymentReceipt } = await import(pathToFileURL(
    path.join(directory, 'scripts/deployment/windows-cold-receipt-recovery.mjs')));
  const journal = path.join(control, 'recovery-lock');
  const transactionPath = path.join(control, 'task-maintenance/transaction.json');
  const transactionBytes = await readFile(transactionPath);
  const journalNames = (await readdir(journal)).sort();
  const names = ['state.json', 'cold-restore-terminal.json', 'lock/owner.json', 'backup/manifest.json',
    ...journalNames.map(name => `recovery-lock/${name}`)];
  const before = await Promise.all(names.map(name => readFile(path.join(control, name))));
  const marker = JSON.parse(before[1]);
  const state = JSON.parse(marker.nextState);
  const receiptPath = path.join(control, 'deployment.json');
  const stagePath = path.join(control, '.deployment.json.staging');
  const beforeReceipt = await readFile(receiptPath);
  const original = await lstat(receiptPath, { bigint: true });
  const unchanged = async ({ authorityHeld = false } = {}) => {
    assert.deepEqual(await Promise.all(names.map(name => readFile(path.join(control, name)))), before);
    assert.deepEqual((await readdir(journal)).sort(), journalNames);
    if (authorityHeld) await assert.rejects(readFile(transactionPath), { code: 'EBUSY' });
    else assert.deepEqual(await readFile(transactionPath), transactionBytes);
    await verifyWindowsApplicationApi('restored', chatId);
  };
  const verifyReceipt = receipt => {
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.project, state.project);
    assert.equal(receipt.operationId, marker.operationId);
    assert.equal(receipt.acceptedAt, state.updatedAt);
    assert.equal(receipt.identity.source, state.targetCommit);
    for (const key of ['build', 'dependencies', 'config', 'service']) {
      assert.match(receipt.identity[key], /^[a-f0-9]{64}$/);
    }
  };
  process.stderr.write(`${new Date().toISOString()} Actual cold receipt: ${target}\n`);
  await unchanged();
  const result = await recoverWindowsColdRestoredDeploymentReceipt({
    control, pwsh, acceptDataLoss: true,
    onProgress: async progress => {
      assert.ok(Object.isFrozen(progress) && Object.isFrozen(progress.runtime));
      if (progress.step !== target) return;
      assert.equal(progress.operationId, marker.operationId);
      assert.deepEqual(progress.runtime, marker.runtime);
      assert.equal(progress.lease, 'released');
      if (target === 'receipt-staged') {
        verifyReceipt(JSON.parse(await readFile(stagePath)));
        assert.deepEqual(await readFile(receiptPath), beforeReceipt);
        assert.notEqual(JSON.parse(beforeReceipt).operationId, marker.operationId);
      } else {
        await assert.rejects(lstat(stagePath), { code: 'ENOENT' });
        verifyReceipt(JSON.parse(await readFile(receiptPath)));
      }
      await unchanged({ authorityHeld: true });
      await interruptWindowsColdApplication({ ...progress, status: 'cold-restored-receipt-interrupted' });
      assert.fail('Interrupted actual receipt actor unexpectedly returned.');
    },
  });
  assert.equal(target, 'complete', 'Actual receipt interruption boundary was skipped.');
  assert.equal(result.status, 'cold-restored-receipt-published');
  assert.equal(result.operationId, marker.operationId);
  assert.deepEqual(result.runtime, marker.runtime);
  assert.equal(result.lease, 'released');
  verifyReceipt(result.receipt);
  assert.deepEqual(JSON.parse(await readFile(receiptPath)), result.receipt);
  assert.deepEqual(await readFile(receiptPath), beforeReceipt);
  const current = await lstat(receiptPath, { bigint: true });
  for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(current[key], original[key]);
  await assert.rejects(lstat(stagePath), { code: 'ENOENT' });
  await unchanged();
  return { ...result, status: 'cold-restored-receipt-recovered', step: 'complete' };
}
