import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { restoreWindowsColdFiles } from '../scripts/deployment/windows-cold-restore-files.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';

const [control, pwsh] = process.argv.slice(2);
const guard = path.join(control, 'recovery-lock');
const receiptFile = path.join(guard, 'files-restored.json');
const originalBytes = await readFile(receiptFile);
const original = JSON.parse(originalBytes);
const ownerBytes = await readFile(path.join(guard, 'owner.json'));
const record = JSON.parse(ownerBytes);
assert.notEqual(await processIdentity(record.owner.pid), record.owner.processIdentity);
const stateBytes = await readFile(path.join(control, 'state.json'));
const lockBytes = await readFile(path.join(control, 'lock/owner.json'));
const options = {
  control, project: record.project, backup: record.backup, node: process.execPath, pwsh,
  profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
};
for (const change of [
  { ownerSha256: '0'.repeat(64) }, { stateSha256: '0'.repeat(64) },
  { runtimeBundle: { ...original.runtimeBundle, directory: control } },
]) {
  try {
    await writeFile(receiptFile, JSON.stringify({ ...original, ...change }));
    await assert.rejects(claimWindowsColdRestore(options), /completion receipt/);
    assert.deepEqual(await readFile(path.join(guard, 'owner.json')), ownerBytes);
  } finally { await writeFile(receiptFile, originalBytes); }
}
const snapshot = await verifySnapshot(record.backup);
const lease = await claimWindowsColdRestore(options);
try {
  assert.notEqual(lease.owner.operationId, record.owner.operationId);
  await assert.rejects(lstat(receiptFile), { code: 'ENOENT' });
  const result = await restoreWindowsColdFiles({ control, lease, acceptDataLoss: true });
  assert.notEqual(result.runtimeBundle.directory, original.runtimeBundle.directory);
  const receipt = JSON.parse(await readFile(receiptFile));
  assert.deepEqual(receipt.runtimeBundle, result.runtimeBundle);
  assert.notEqual(receipt.ownerSha256, original.ownerSha256);
  assert.deepEqual(await verifySnapshot(record.backup), snapshot);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
  await lease.checkStopped();
} finally { await lease.close(); }
console.log('PASS: cold completed-file receipt binds original owner, archive and runtime; reentry replaces only its stale receipt before a fresh complete copy');
