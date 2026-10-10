import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectWindowsManagedTask } from '../scripts/deployment/windows-managed-task.mjs';
import { inspectWindowsConfiguration } from '../scripts/deployment/windows-configuration.mjs';
import { captureWindowsDeploymentAcceptance } from '../scripts/deployment/windows-deployment-acceptance.mjs';
import { publishDeploymentReceipt, readDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';
import { captureWindowsFirstDeploymentIdentity } from '../scripts/deployment/windows-first-deployment-identity.mjs';

export async function verifyWindowsFirstDeploymentReceipt({ fixture, built, active, port }) {
  const { project, taskName, pwsh, control, lock } = fixture;
  const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
  let configuration;
  try {
    assert.deepEqual(scope.observation.runtime, active.runtime);
    assert.equal(scope.observation.enabled, true);
    assert.equal(scope.observation.lease, 'released');
    configuration = await inspectWindowsConfiguration({
      scope, pwsh, profile: fixture.configuration.profile,
    });
    assert.deepEqual(configuration.providers, fixture.configuration.providers);
    const acceptance = await captureWindowsDeploymentAcceptance({
      scope, configuration, source: built.source, artifacts: built.artifacts, port, waitSeconds: 30,
    });
    assert.equal(acceptance.identity.source, built.sourceCommit);
    assert.equal(acceptance.identity.build, built.artifacts.identity.build);
    assert.equal(acceptance.identity.dependencies, built.artifacts.identity.dependencies);
    const { service, ...preparedIdentity } = acceptance.identity;
    assert.deepEqual(captureWindowsFirstDeploymentIdentity(preparedIdentity), preparedIdentity);
    assert.equal(Object.isFrozen(captureWindowsFirstDeploymentIdentity(preparedIdentity)), true);
    for (const changed of [
      null, { ...preparedIdentity, service },
      ...Object.keys(preparedIdentity).flatMap(name => [
        { ...preparedIdentity, [name]: undefined }, { ...preparedIdentity, [name]: 1 },
        { ...preparedIdentity, [name]: 'A'.repeat(name === 'source' ? 40 : 64) },
      ]),
    ]) assert.throws(() => captureWindowsFirstDeploymentIdentity(changed));
    const stateFile = path.join(control, 'state.json');
    const state = await readFile(stateFile);
    const receipt = await publishDeploymentReceipt({ control, lock, ...acceptance });
    assert.deepEqual(receipt, {
      version: 1, project, operationId: lock.operationId, status: 'accepted',
      acceptedAt: JSON.parse(state).updatedAt, identity: acceptance.identity,
    });
    assert.deepEqual(await readDeploymentReceipt(control, project), receipt);
    const receiptFile = path.join(control, 'deployment.json');
    const bytes = await readFile(receiptFile);
    assert.deepEqual(await publishDeploymentReceipt({ control, lock, ...acceptance }), receipt);
    await assert.rejects(publishDeploymentReceipt({
      control, lock, identity: { ...acceptance.identity, source: '0'.repeat(40) },
      checkAccepted: acceptance.checkAccepted,
    }), /matching accepted state and source/);
    assert.deepEqual(await readFile(receiptFile), bytes);
    assert.deepEqual(await readFile(stateFile), state);
    assert.equal(JSON.parse(state).priorRuntime, 'absent');
    assert.equal(JSON.parse(state).backupId, null);
    await assert.rejects(readFile(path.join(control, '.deployment.json.staging')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(control, 'backup/manifest.json')), { code: 'ENOENT' });
    assert.deepEqual((await scope.check()).runtime, active.runtime);
  } finally {
    try { if (configuration) await configuration.close(); }
    finally { await scope.close(); }
  }
}
