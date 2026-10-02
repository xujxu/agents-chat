import assert from 'node:assert/strict';
import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';
import {
  openWindowsTaskCompletionProof, assertWindowsTaskCompletionProof,
} from '../scripts/deployment/windows-task-completion-proof.mjs';

const [control, pwsh] = process.argv.slice(2);
await withWindowsAdmission(control, { pwsh }, async admission => {
  await assert.rejects(openWindowsTaskCompletionProof({
    control, pwsh, admission: Object.freeze({ check: async () => {} }),
  }), /Original retained Windows admission/);
  const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
  try {
    assert.equal(proof.observation.status, 'observed');
    assert.equal(proof.observation.mutationAuthority, false);
    assert.equal(proof.observation.lease, 'released');
    assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.observation)
      && Object.isFrozen(proof.observation.runtime) && Object.isFrozen(proof.observation.providers));
    assert.deepEqual(await assertWindowsTaskCompletionProof(control, proof, admission), proof.observation);
    await assert.rejects(assertWindowsTaskCompletionProof(control, { ...proof }, admission),
      /Original retained completed-task proof/);
    await assert.rejects(assertWindowsTaskCompletionProof(`${control}-foreign`, proof, admission),
      /Original retained completed-task proof/);
    await assert.rejects(acquireLock(control, { pwsh }),
      error => /acquire\/busy/.test(error.diagnostic ?? ''));
  } finally { await proof.close(); }
  await assert.rejects(proof.check(), /Completed-task proof unavailable/);
  await proof.close();
  await admission.check();
});
console.log('PASS: completed-task proof retains native evidence inside original shared admission without mutation');
