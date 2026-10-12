import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { restoreWindowsColdFiles } from '../scripts/deployment/windows-cold-restore-files.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { verifyWindowsColdConfiguration } from './deployment-windows-cold-configuration.mjs';

const [control, pwsh] = process.argv.slice(2);
const stateBytes = await readFile(path.join(control, 'state.json'));
const state = JSON.parse(stateBytes);
const lockBytes = await readFile(path.join(control, 'lock/owner.json'));
const admission = JSON.parse(await readFile(path.join(control, 'task-maintenance/admission.json')));
assert.equal(await processIdentity(admission.ownerPid), admission.ownerIdentity);
const backup = path.join(control, 'backup');
const snapshot = await verifySnapshot(backup);
const lease = await claimWindowsColdRestore({
  control, project: state.project, backup, node: process.execPath, pwsh,
  profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
});
let configuration;
try {
  assert.equal(typeof lease.inspectRestoredConfiguration, 'function', 'Cold activation requires retained restored configuration.');
  await assert.rejects(lease.inspectRestoredConfiguration(), /requires completed file restoration/);
  assert.equal(typeof lease.retireRuntime, 'function', 'Cold lease must retire only its authenticated original runtime.');
  await assert.rejects(lease.retireRuntime(), /requires completed file restoration/);
  assert.equal(await processIdentity(admission.ownerPid), admission.ownerIdentity);
  await lease.checkStopped();
  await restoreWindowsColdFiles({ control, lease, acceptDataLoss: true });
  configuration = await verifyWindowsColdConfiguration({ lease, project: state.project, pwsh });
  const receiptFile = path.join(control, 'recovery-lock/files-restored.json');
  const receiptBytes = await readFile(receiptFile);
  const ownerBytes = await readFile(path.join(control, 'recovery-lock/owner.json'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lease.retireRuntime({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await processIdentity(admission.ownerPid), admission.ownerIdentity);
  assert.equal(await processIdentity(lease.admissionIdentity.pid), lease.admissionIdentity.processIdentity);
  await lease.checkStopped();
  const expected = { retired: true, inhibited: true, operationId: lease.owner.operationId };
  assert.deepEqual(await lease.retireRuntime(), expected);
  await configuration.checkFiles();
  assert.notEqual(await processIdentity(admission.ownerPid), admission.ownerIdentity);
  await lease.checkStopped();
  assert.deepEqual(await lease.retireRuntime(), expected);
  await assert.rejects(writeFile(receiptFile, 'changed'));
  assert.deepEqual(await readFile(receiptFile), receiptBytes);
  assert.deepEqual(await readFile(path.join(control, 'recovery-lock/owner.json')), ownerBytes);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
  assert.deepEqual(await verifySnapshot(backup), snapshot);
} finally {
  const results = await Promise.allSettled([configuration?.close(), lease.close()]);
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Cold configuration and lease cleanup failed.');
}
await assert.rejects(configuration.checkFiles(), /closed/);
await assert.rejects(lease.retireRuntime(), /closed/);
console.log('PASS: completed cold file owner retains exact restored configuration across original runtime retirement and preserves all original evidence');
