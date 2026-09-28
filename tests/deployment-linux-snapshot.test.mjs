import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, chown, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture, ready } from './deployment-linux-service-fixture.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from '../scripts/deployment/linux-configuration.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';
import { createLinuxServiceSnapshot } from '../scripts/deployment/linux-snapshot.mjs';
import { acquireLock, writeState } from '../scripts/deployment/state.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { restoreProjectSnapshot } from '../scripts/deployment/restore-project.mjs';

async function retained(t) {
  const f = await fixture(t, { nonroot: true, settings: `Environment=NODE_ENV=production
Environment=NEXTAUTH_SECRET=fixture-private-secret
Environment=NEXTAUTH_URL=http://localhost:3010
Environment=ADMIN_USERNAME=fixture
Environment=ADMIN_PASSWORD=fixture-private-password` });
  await ready(f);
  const service = await inspectLinuxService(f);
  const configuration = await inspectLinuxConfiguration({ service, profile: 'agents-chat-auth-638c553' });
  t.after(() => service.close());
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  const state = {
    version: 1, operationId: lock.operationId, project: f.project, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
    backupId: null, priorRuntime: 'running', runtimeIdentity: service.identity.runtime.invocationId,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), errorCode: null,
  };
  await writeState(control, state);
  await writeState(control, { ...state, phase: 'stopped', previousPhase: 'preflight' });
  const stopped = await stopLinuxService({ ...f, control, lock });
  t.after(() => stopped.close());
  await writeState(control, { ...state, phase: 'copying', previousPhase: 'stopped' });
  return { ...f, control, lock, service, configuration, stopped };
}

test('actual stopped service snapshot captures source, runtime and original unit rather than temporary inhibition', async t => {
  const f = await retained(t);
  await mkdir(path.join(f.project, '.data', 'models'), { recursive: true });
  await writeFile(path.join(f.project, '.data', 'models', 'asset'), 'model');
  const destination = path.join(f.control, 'staging');
  const result = await createLinuxServiceSnapshot({
    ...f, destination, id: 'native-snapshot', source: { commit: 'a'.repeat(40), provenance: 'observed' },
  });
  assert.ok(result.entries.some(entry => entry.path === '.data/models/asset'));
  assert.equal(result.externalFiles.some(entry => entry.path.includes('90-agents-chat-deployment.conf')), false);
  const index = result.externalFiles.findIndex(entry => entry.path === f.fragment);
  assert.ok(index >= 0);
  assert.equal(await readFile(path.join(destination, 'external', String(index)), 'utf8'), f.bytes);
  assert.equal((await verifySnapshot(destination)).id, 'native-snapshot');
  assert.deepEqual(await f.stopped.checkStopped(), { stopped: true, inhibited: true });
});

test('environment changed after admission cannot be silently backed up as the accepted configuration', async t => {
  const f = await retained(t);
  await writeFile(path.join(f.project, '.env.local'), 'NEW_SETTING=private-change');
  await assert.rejects(createLinuxServiceSnapshot({
    ...f, destination: path.join(f.control, 'staging'), id: 'changed',
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
  }), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
  await assert.rejects(readFile(path.join(f.control, 'staging', 'complete.json')), { code: 'ENOENT' });
});

test('stopped native service project can recover saved data and ownership without install or build', async t => {
  const f = await retained(t);
  const data = path.join(f.project, '.data');
  await mkdir(data);
  await chown(data, 65534, 65534);
  const file = path.join(data, 'saved');
  await writeFile(file, 'saved data');
  await chown(file, 65534, 65534);
  await chmod(file, 0o640);
  const backup = path.join(f.control, 'staging');
  await createLinuxServiceSnapshot({
    ...f, destination: backup, id: 'restore-native', source: { commit: 'a'.repeat(40), provenance: 'observed' },
  });
  await writeFile(file, 'changed data');
  await chown(file, 0, 0);
  await chmod(file, 0o600);
  await writeFile(path.join(f.project, 'nodes.json'), 'post-backup configuration');
  await restoreProjectSnapshot({
    project: f.project, backup, acceptDataLoss: true, checkStopped: () => f.stopped.checkStopped(),
  });
  assert.equal(await readFile(file, 'utf8'), 'saved data');
  const info = await lstat(file);
  assert.equal(info.uid, 65534);
  assert.equal(info.gid, 65534);
  assert.equal(info.mode & 0o777, 0o640);
  assert.equal((await lstat(f.project)).uid, 65534);
  await assert.rejects(lstat(path.join(f.project, 'nodes.json')), { code: 'ENOENT' });
  assert.equal((await verifySnapshot(backup)).id, 'restore-native');
  assert.deepEqual(await f.stopped.checkStopped(), { stopped: true, inhibited: true });
});
