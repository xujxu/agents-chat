import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { openWindowsFirstCompletionProof } from '../scripts/deployment/windows-first-completion-proof.mjs';
import { openWindowsFirstReceiptPublication } from '../scripts/deployment/windows-first-receipt-publication.mjs';
import { inspectWindowsManagedTask } from '../scripts/deployment/windows-managed-task.mjs';
import { windowsServiceIdentityRecord } from '../scripts/deployment/windows-deployment-acceptance.mjs';

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
        for (const name of ['deployment.json.pending-fixture', '.deployment.json.staging']) {
          const pending = path.join(fixture.control, name);
          await writeFile(pending, 'incomplete fixture receipt\n', { flag: 'wx', mode: 0o600 });
          try {
            await assert.rejects(recoverWindowsFirstDeploymentReceipt(options), refused);
            assert.equal(await readFile(pending, 'utf8'), 'incomplete fixture receipt\n');
            await assert.rejects(readFile(receiptFile), { code: 'ENOENT' });
          } finally { await rm(pending); }
        }
        for (const name of ['.next/BUILD_ID', 'node_modules/next/dist/bin/next', '.env']) {
          const file = path.join(fixture.project, name);
          const bytes = await readFile(file);
          try {
            await writeFile(file, name === '.next/BUILD_ID' ? 'foreign-first-build\n' : Buffer.concat([bytes, Buffer.from('\n')]));
            await assert.rejects(recoverWindowsFirstDeploymentReceipt(options), error =>
              refused(error) && /differs from its original prepared identity/.test(error.cause?.message));
            await assert.rejects(readFile(receiptFile), { code: 'ENOENT' });
            assert.deepEqual(await readFile(stateFile), state);
            assert.deepEqual(await readFile(lockFile), lock);
            assert.deepEqual((await readdir(fixture.control)).sort(), names);
          } finally { await writeFile(file, bytes); }
        }
        const observed = await inspectWindowsManagedTask({
          project: fixture.project, taskName: fixture.taskName, pwsh: fixture.pwsh,
        });
        let service;
        try { service = windowsServiceIdentityRecord(observed.observation); }
        finally { await observed.close(); }
        const publisher = await openWindowsFirstReceiptPublication(options);
        try {
          await assert.rejects(openWindowsFirstReceiptPublication(options),
            { code: 'DEPLOYMENT_WINDOWS_FIRST_RECEIPT_PUBLICATION_REFUSED' });
          await publisher.check();
          await assert.rejects(publisher.publish({ service: { ...service, enabled: false } }), error =>
            error.code === 'DEPLOYMENT_WINDOWS_FIRST_RECEIPT_PUBLICATION_REFUSED'
            && /service identity differs/.test(error.diagnostic));
          await assert.rejects(readFile(receiptFile), { code: 'ENOENT' });
        } finally { await publisher.close(); }
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
