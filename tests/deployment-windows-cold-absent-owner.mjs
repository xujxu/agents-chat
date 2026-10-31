import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const [control, pwsh] = process.argv.slice(2);
const stateBytes = await readFile(path.join(control, 'state.json'));
const state = JSON.parse(stateBytes);
const lockBytes = await readFile(path.join(control, 'lock/owner.json'));
const admission = JSON.parse(await readFile(path.join(control, 'task-maintenance/admission.json')));
assert.notEqual(await processIdentity(admission.ownerPid), admission.ownerIdentity);
const backup = path.join(control, 'backup');
const snapshot = await verifySnapshot(backup);
const intentFile = path.join(control, 'recovery-lock/activation-intent.json');
const priorIntent = JSON.parse(await readFile(intentFile));
assert.equal(priorIntent.phase, 'activation-intent');
const lease = await claimWindowsColdRestore({
  control, project: state.project, backup, node: process.execPath, pwsh,
  profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
});
try {
  await assert.rejects(lstat(intentFile), { code: 'ENOENT' });
  assert.deepEqual(await lease.checkStopped(), {
    stopped: true, inhibited: true, operationId: lease.owner.operationId,
  });
  assert.deepEqual(await verifySnapshot(backup), snapshot);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
} finally { await lease.close(); }
