import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { openWindowsFirstConfigurationFiles } from '../scripts/deployment/windows-configuration-files.mjs';
import { inspectWindowsSnapshotSecurity } from '../scripts/deployment/windows-snapshot-security.mjs';

test('configuration and snapshot observers agree on inherited project file security', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'control');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const pwsh = process.env.DEPLOYMENT_TEST_PWSH;
  const configuration = await openWindowsFirstConfigurationFiles({ project, pwsh });
  let snapshot;
  try {
    snapshot = await inspectWindowsSnapshotSecurity({ project, destinationParent: control, entries: [], pwsh });
    assert.equal(configuration.observation.projectSecurityDescriptor,
      snapshot.metadata.descriptors[snapshot.metadata.root.security]);
    await configuration.check();
    await snapshot.check();
  } finally {
    await Promise.all([snapshot?.close(), configuration.close()]);
  }
});
