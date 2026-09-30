import assert from 'node:assert/strict';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { restoreCandidate } from './deployment-linux-restore-fixture.mjs';
import { inspectGitMetadata } from '../scripts/deployment/git-metadata.mjs';
import { inspectBuildArtifacts } from '../scripts/deployment/build-artifacts.mjs';
import { captureLinuxDeploymentAcceptance } from '../scripts/deployment/linux-deployment-acceptance.mjs';
import { loadState, writeState } from '../scripts/deployment/state.mjs';
import { publishDeploymentReceipt, readDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';
import { inspectCurrentLinuxDeployment } from '../scripts/deployment/linux-current-deployment.mjs';

for (const healthy of [true, false]) {
test(`native acceptance binds source, artifacts and owned HTTP generation (healthy=${healthy})`, async t => {
  const f = await restoreCandidate(t, healthy, { gitSource: true });
  await mkdir(path.join(f.project, '.next'));
  await mkdir(path.join(f.project, 'node_modules'));
  await writeFile(path.join(f.project, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(path.join(f.project, '.next/BUILD_ID'), 'acceptance-fixture');
  const source = await inspectGitMetadata({ project: f.project, commit: await f.git('rev-parse', 'HEAD') });
  const artifacts = await inspectBuildArtifacts({ project: f.project });
  const options = {
    service: f.service, configuration: f.configuration, source, artifacts, port: f.port, waitSeconds: 10,
  };
  if (!healthy) {
    await assert.rejects(captureLinuxDeploymentAcceptance(options), /providers do not match/i);
    assert.equal(await readDeploymentReceipt(f.control, f.project), null);
    return;
  }
  const accepted = await captureLinuxDeploymentAcceptance(options);
  assert.equal(accepted.identity.source, source.record.commit);
  assert.equal(accepted.identity.build, artifacts.identity.build);
  assert.equal(accepted.identity.dependencies, artifacts.identity.dependencies);
  assert.match(accepted.identity.config, /^[a-f0-9]{64}$/);
  assert.match(accepted.identity.service, /^[a-f0-9]{64}$/);
  assert.deepEqual(await accepted.checkAccepted(), accepted.identity);
  let previousPhase = null;
  for (const phase of ['preflight', 'stopped', 'copying', 'rotating', 'backup-ready',
    'source-selected', 'dependencies', 'building', 'configuring', 'activating', 'accepted']) {
    await writeState(f.control, {
      version: 1, operationId: f.lock.operationId, project: f.project, operation: 'update', phase, previousPhase,
      sourceCommit: f.savedCommit, targetCommit: source.record.commit, backupId: 'live-restore', priorRuntime: 'running',
      runtimeIdentity: f.service.identity.runtime.invocationId, startedAt: f.lock.createdAt,
      updatedAt: new Date().toISOString(), errorCode: null,
    });
    previousPhase = phase;
  }
  const receipt = await publishDeploymentReceipt({ control: f.control, lock: f.lock, ...accepted });
  assert.deepEqual((await readDeploymentReceipt(f.control, f.project)).identity, accepted.identity);
  const currentOptions = { ...options, control: f.control, state: await loadState(f.control), commit: source.record.commit };
  const current = await inspectCurrentLinuxDeployment(currentOptions);
  assert.deepEqual(current.current.receipt, receipt);
  await current.check();
  for (const phase of ['restored', 'preflight-refused', 'activation-unverified', 'blocked']) {
    assert.equal(await inspectCurrentLinuxDeployment({
      ...currentOptions, state: { ...currentOptions.state, phase },
    }), null);
  }
  await writeFile(path.join(f.project, '.next/BUILD_ID'), 'replaced-build');
  assert.equal(await inspectCurrentLinuxDeployment(currentOptions), null);
  await assert.rejects(accepted.checkAccepted(), /artifact|changed/i);
  await assert.rejects(publishDeploymentReceipt({ control: f.control, lock: f.lock, ...accepted }), /artifact|changed/i);
  assert.deepEqual(await readDeploymentReceipt(f.control, f.project), receipt);
  await unlink(path.join(f.project, '.next/BUILD_ID'));
  assert.equal(await inspectCurrentLinuxDeployment(currentOptions), null);
});
}
