import assert from 'node:assert/strict';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import {
  assertWindowsStoppedRestoreProof, openWindowsStoppedRestoreProof,
} from '../scripts/deployment/windows-stopped-restore-proof.mjs';
import { verifyStoppedRestoreSnapshot } from './deployment-windows-stopped-restore-snapshot.mjs';
import { verifyWindowsColdRestoreLease } from './deployment-windows-cold-restore-lease.mjs';

const [control, pwsh, taskName, operationId] = process.argv.slice(2);
const admission = await acquireWindowsAdmission({ control, pwsh });
let proof;
try {
  await assert.rejects(openWindowsStoppedRestoreProof({ control, pwsh, admission: {} }));
  proof = await openWindowsStoppedRestoreProof({ control, pwsh, admission });
  assert.equal(proof.observation.mutationAuthority, false);
  assert.equal(proof.observation.taskName, taskName);
  assert.equal(proof.observation.operationId, operationId);
  assert.equal(proof.observation.stopped, true);
  assert.equal(proof.observation.inhibited, true);
  assert.ok(Object.isFrozen(proof));
  assert.ok(Object.isFrozen(proof.observation));
  assert.deepEqual(await assertWindowsStoppedRestoreProof(control, proof, admission), proof.observation);
  await assert.rejects(acquireWindowsAdmission({ control, pwsh }), { code: 'DEPLOYMENT_WINDOWS_ADMISSION_REFUSED' });
  await assert.rejects(assertWindowsStoppedRestoreProof(control, { ...proof }, admission));
  await assert.rejects(assertWindowsStoppedRestoreProof(control, proof, {}));
  await assert.rejects(assertWindowsStoppedRestoreProof(`${control}-foreign`, proof, admission));
  await verifyStoppedRestoreSnapshot({ control, pwsh, admission, proof });
  await proof.close();
  await proof.close();
  await assert.rejects(proof.check(), { code: 'DEPLOYMENT_WINDOWS_STOPPED_RESTORE_PROOF_REFUSED' });
  await admission.check();
} finally {
  try { await proof?.close(); }
  finally { await admission.close(); }
}
const again = await acquireWindowsAdmission({ control, pwsh });
try {
  const observed = await openWindowsStoppedRestoreProof({ control, pwsh, admission: again });
  try { assert.equal((await observed.check()).operationId, operationId); }
  finally { await observed.close(); }
} finally { await again.close(); }
await verifyWindowsColdRestoreLease({ control, pwsh });
console.log('PASS: stopped restore bridge binds native admission, refuses forged contexts and releases its own handles');
