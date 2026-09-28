import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from '../scripts/deployment/linux-configuration.mjs';
import { inspectLinuxNodeVersion } from '../scripts/deployment/linux-node-version.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { fixture, ready, systemctl } from './deployment-linux-service-fixture.mjs';

const profile = 'agents-chat-auth-638c553';
const settings = `Environment=NODE_ENV=production
Environment=NEXTAUTH_SECRET=private-fixture-secret
Environment=NEXTAUTH_URL=http://localhost:3010
Environment=ADMIN_USERNAME=fixture
Environment=ADMIN_PASSWORD=private-fixture-password`;

async function retained(t, options = {}) {
  const f = await fixture(t, { settings, ...options });
  await ready(f);
  const service = await inspectLinuxService(f);
  t.after(() => service.close());
  return { ...f, service };
}

test('inspect actual installed configuration without stopping the original service', async t => {
  const f = await retained(t);
  const before = (await systemctl('show', f.unit, '--property=MainPID,InvocationID')).stdout;
  const result = await inspectLinuxConfiguration({ service: f.service, profile });
  assert.equal(result.status, 'configuration-supported');
  assert.deepEqual(result.providers, ['credentials']);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
  await result.check();
  assert.equal((await systemctl('show', f.unit, '--property=MainPID,InvocationID')).stdout, before);
});

test('actual EnvironmentFile overrides are observed and later mutations invalidate admission', async t => {
  const f = await retained(t);
  const file = path.join(f.project, 'runtime.env');
  await writeFile(file, 'NEXTAUTH_URL=https://override.example\n');
  await writeFile(f.fragment, `${f.bytes}\nEnvironmentFile=${file.replaceAll('%', '%%')}\n`);
  await systemctl('daemon-reload');
  await systemctl('restart', f.unit);
  const service = await inspectLinuxService(f);
  try {
    const result = await inspectLinuxConfiguration({ service, profile });
    assert.ok(result.files.some(source => source.path === file && source.kind === 'systemd'));
    await writeFile(file, 'NEXTAUTH_URL=https://changed.example\n');
    await assert.rejects(result.check(), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
    await assert.rejects(inspectLinuxConfiguration({ service, profile }), { check: 'runtime-environment-changed' });
  } finally { await service.close(); }
});

test('Next dotenv-only credentials need not be present in the initial npm process', async t => {
  const f = await retained(t, { settings: 'Environment=NODE_ENV=production' });
  await writeFile(path.join(f.project, '.env.production.local'), [
    'NEXTAUTH_SECRET=private-fixture-secret', 'NEXTAUTH_URL=http://localhost:3010',
    'ADMIN_USERNAME=fixture', 'ADMIN_PASSWORD=private-fixture-password',
  ].join('\n'));
  const result = await inspectLinuxConfiguration({ service: f.service, profile });
  assert.deepEqual(result.providers, ['credentials']);
});

test('optional absent EnvironmentFile remains observed through admission', async t => {
  const f = await retained(t, { settings: `${settings}\nEnvironmentFile=-/run/agents-absent-%n.env` });
  const result = await inspectLinuxConfiguration({ service: f.service, profile });
  const source = result.files.find(source => source.kind === 'systemd');
  assert.equal(source.present, false);
  assert.equal(source.path, `/run/agents-absent-${f.unit}.env`);
});

for (const policy of ['PassEnvironment=HOME', 'UnsetEnvironment=HOME']) {
  test(`unreviewed environment policy is refused: ${policy}`, async t => {
    const f = await retained(t, { settings: `${settings}\n${policy}` });
    await assert.rejects(inspectLinuxConfiguration({ service: f.service, profile }),
      { check: 'runtime-environment-policy' });
  });
}

test('the original service invocation must remain stable during configuration admission', async t => {
  const f = await retained(t);
  const result = await inspectLinuxConfiguration({ service: f.service, profile });
  await systemctl('restart', f.unit);
  await assert.rejects(result.check(), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
});

test('actual runtime Node is observed through a settled non-root owned worker before downtime', async t => {
  const f = await retained(t, { nonroot: true });
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)),
    control, project: f.project, operationId: lock.operationId,
  });
  const operation = await createWorkerOperation({ control, lock, saved });
  try {
    const result = await inspectLinuxNodeVersion({ service: f.service, operation });
    assert.equal(result.nodeVersion, process.versions.node);
    assert.equal(result.status, 'runtime-observed');
    await operation.seal();
    assert.equal((await f.service.check()).populated, true);
  } finally { await operation.close(); }
});
