import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { createSnapshot } from '../scripts/deployment/snapshot.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { inspectSnapshotConfiguration } from '../scripts/deployment/snapshot-configuration.mjs';

const profile = 'agents-chat-auth-638c553';
const values = 'NEXTAUTH_SECRET=saved-private-secret\nNEXTAUTH_URL=http://localhost:3010\nADMIN_USERNAME=fixture\nADMIN_PASSWORD=saved-private-password\n';

async function candidate(t, { content = values, external = false } = {}) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'project');
  const backup = path.join(root, 'backup');
  await mkdir(project);
  await writeFile(path.join(project, '.env'), content);
  const file = path.join(root, 'service.env');
  const absent = path.join(root, 'optional.env');
  if (external) await writeFile(file, 'ADMIN_PASSWORD=\n');
  const snapshot = await createSnapshot({
    project, destination: backup, id: 'configuration', ...(await inspectSnapshotScope({ project })),
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
    externalFiles: external ? [{ path: file, optional: false }, { path: absent, optional: true }] : [],
  });
  return { project, backup, snapshot, file, absent, profile, environment: { NODE_ENV: 'production' } };
}

test('saved effective configuration uses backup dotenv rather than current installation or controller values', async t => {
  const f = await candidate(t);
  await writeFile(path.join(f.project, '.env'), 'NEXTAUTH_URL=invalid\n');
  const before = await readFile(path.join(f.project, '.env'));
  const result = await inspectSnapshotConfiguration(f);
  assert.deepEqual(result.providers, ['credentials']);
  assert.doesNotMatch(JSON.stringify(result), /saved-private/);
  await result.check();
  assert.deepEqual(await readFile(path.join(f.project, '.env')), before);
});

test('a complete checksum-valid backup with incompatible saved settings is refused', async t => {
  const f = await candidate(t, { content: values.replace('NEXTAUTH_SECRET=saved-private-secret', 'NEXTAUTH_SECRET=') });
  await writeFile(path.join(f.project, '.env'), values);
  await assert.rejects(inspectSnapshotConfiguration(f), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check: 'NEXTAUTH_SECRET' });
});

test('saved environment file overrides and saved optional absence are independent of live files', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await candidate(t, { external: true });
  await writeFile(f.file, 'ADMIN_PASSWORD=current-private-password\n');
  await writeFile(f.absent, 'ADMIN_PASSWORD=current-optional-private-password\n');
  await assert.rejects(inspectSnapshotConfiguration({
    ...f, systemdFiles: [{ path: f.file, optional: false }, { path: f.absent, optional: true }],
  }), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check: 'ADMIN_USERNAME/ADMIN_PASSWORD' });
  const result = await inspectSnapshotConfiguration({
    ...f, systemdFiles: [{ path: f.absent, optional: true }],
  });
  assert.deepEqual(result.providers, ['credentials']);
});

test('uncaptured external sources and excluded project paths cannot become assumed optional absence', async t => {
  const f = await candidate(t);
  for (const file of [f.file, path.join(f.project, '.git', 'config'), path.join(f.project, '.next', 'cache', 'env')]) {
    await assert.rejects(inspectSnapshotConfiguration({
      ...f, systemdFiles: [{ path: file, optional: true }],
    }), /captur|exclud/i);
  }
});

test('saved configuration rechecks the admitted snapshot with the current stage signal', async t => {
  const f = await candidate(t);
  const old = new AbortController();
  const result = await inspectSnapshotConfiguration({ ...f, signal: old.signal });
  old.abort();
  await result.check({ signal: new AbortController().signal });
  await writeFile(path.join(f.backup, 'files', '.env'), values + '# changed\n');
  await assert.rejects(result.check({ signal: new AbortController().signal }), /integrity|checksum|changed/i);
});
