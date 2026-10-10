import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { openWindowsFirstCompletionProof } from '../scripts/deployment/windows-first-completion-proof.mjs';

const implementation = new URL('../scripts/deployment/windows-first-receipt-recovery.mjs', import.meta.url);
const refused = error => error.code === 'DEPLOYMENT_WINDOWS_FIRST_RECEIPT_RECOVERY_REFUSED';

export async function prepareWindowsFirstReceiptRecoveryCase({ fixture, state }) {
  assert.ok(existsSync(implementation), 'Missing first Windows cold receipt publication');
  const { recoverWindowsFirstDeploymentReceipt } = await import(implementation);
  const admission = await acquireWindowsAdmission({ control: fixture.control, pwsh: fixture.pwsh });
  const options = {
    control: fixture.control, project: fixture.project, operationId: fixture.operationId,
    pwsh: fixture.pwsh, admission,
  };
  const receiptFile = path.join(fixture.control, 'deployment.json');
  const stateFile = path.join(fixture.control, 'state.json');
  const lockFile = path.join(fixture.control, 'lock/owner.json');
  const preparedFile = path.join(fixture.control, `first-task-${fixture.operationId}`, 'completion-prepared.json');
  try {
    await assert.rejects(recoverWindowsFirstDeploymentReceipt(options), refused);
    return {
      async verify() {
        await assert.rejects(readFile(receiptFile), { code: 'ENOENT' });
        const lock = await readFile(lockFile);
        const names = (await readdir(fixture.control)).sort();
        const buildFile = path.join(fixture.project, '.next/BUILD_ID');
        const build = await readFile(buildFile);
        try {
          await writeFile(buildFile, 'foreign-first-build\n');
          await assert.rejects(recoverWindowsFirstDeploymentReceipt(options), refused);
          await assert.rejects(readFile(receiptFile), { code: 'ENOENT' });
          assert.deepEqual(await readFile(stateFile), state);
          assert.deepEqual(await readFile(lockFile), lock);
          assert.deepEqual((await readdir(fixture.control)).sort(), names);
        } finally { await writeFile(buildFile, build); }
        const receipt = await recoverWindowsFirstDeploymentReceipt(options);
        const expected = JSON.parse(await readFile(preparedFile)).deploymentIdentity;
        assert.deepEqual(receipt, {
          version: 1, project: fixture.project, operationId: fixture.operationId, status: 'accepted',
          acceptedAt: JSON.parse(state).updatedAt, identity: { ...expected, service: receipt.identity.service },
        });
        assert.match(receipt.identity.service, /^[a-f0-9]{64}$/);
        const bytes = await readFile(receiptFile);
        assert.deepEqual(JSON.parse(bytes), receipt);
        assert.deepEqual(await recoverWindowsFirstDeploymentReceipt(options), receipt);
        assert.deepEqual(await readFile(receiptFile), bytes);
        assert.deepEqual(await readFile(stateFile), state);
        assert.deepEqual(await readFile(lockFile), lock);
        assert.deepEqual((await readdir(fixture.control)).sort(), [...names, 'deployment.json'].sort());
        const proof = await openWindowsFirstCompletionProof(options);
        try {
          assert.equal(proof.observation.phase, 'complete');
          assert.deepEqual(proof.deploymentIdentity, expected);
          await assert.rejects(writeFile(receiptFile, bytes));
        } finally { await proof.close(); }
      },
      close: () => admission.close(),
    };
  } catch (error) {
    try { await admission.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold receipt fixture admission cleanup failed.'); }
    throw error;
  }
}
