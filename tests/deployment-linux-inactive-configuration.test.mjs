import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { quiescentFixture, systemctl } from './deployment-linux-service-fixture.mjs';
import { inspectLinuxInactiveService } from '../scripts/deployment/linux-inactive-service.mjs';
import { inspectLinuxConfiguration } from '../scripts/deployment/linux-configuration.mjs';
import { linuxSystemdBus, linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';

const native = { skip: process.platform !== 'linux' || process.getuid() !== 0 };
const profile = 'agents-chat-auth-638c553';
const credentials = [
  'NODE_ENV=production', 'NEXTAUTH_SECRET=private-inactive-fixture-secret',
  'NEXTAUTH_URL=http://localhost:3010', 'ADMIN_USERNAME=fixture', 'ADMIN_PASSWORD=private-inactive-fixture-password',
].join('\n') + '\n';

async function configured(t, state = 'inactive') {
  const f = await quiescentFixture(t, state);
  await writeFile(path.join(f.project, '.env.production.local'), credentials);
  return f;
}

async function managerUrl(t, value) {
  const environment = await linuxSystemdBus(['get-property', 'org.freedesktop.systemd1',
    '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'Environment'], 'as');
  const previous = environment.find(entry => entry.startsWith('NEXTAUTH_URL='));
  t.after(() => previous === undefined
    ? systemctl('unset-environment', 'NEXTAUTH_URL')
    : systemctl('set-environment', previous));
  await systemctl('set-environment', `NEXTAUTH_URL=${value}`);
}

for (const state of ['inactive', 'failed']) {
  test(`configured ${state} credentials are admitted without a fictitious startup process`, native, async t => {
    const f = await configured(t, state);
    const service = await inspectLinuxInactiveService(f);
    t.after(() => service.close());
    const properties = ['ActiveState', 'MainPID', 'InvocationID', 'ExecMainStatus'];
    const before = await linuxSystemdProperties(f.unit, properties);
    const result = await inspectLinuxConfiguration({ service, profile });
    assert.equal(result.status, 'configuration-supported');
    assert.deepEqual(result.providers, ['admin-login']);
    assert.equal(result.buildEnvironment({}).ADMIN_PASSWORD, 'private-inactive-fixture-password');
    assert.equal(result.startupEnvironment().ADMIN_PASSWORD, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-inactive-fixture/);
    assert.ok(result.runtimePath().includes(path.dirname(f.node)));
    await result.check();
    assert.deepEqual(await linuxSystemdProperties(f.unit, properties), before);
    await writeFile(path.join(f.project, '.env.production.local'), credentials + 'NEXT_PUBLIC_CHANGED=1\n');
    await assert.rejects(result.checkFiles(), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
  });
}

test('inactive admission refuses unretained global authentication overrides instead of trusting dotenv', native, async t => {
  const f = await configured(t);
  await managerUrl(t, 'https://manager.example');
  const service = await inspectLinuxInactiveService(f);
  t.after(() => service.close());
  await assert.rejects(inspectLinuxConfiguration({ service, profile }), {
    code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check: 'inactive-manager-environment',
  });
  assert.equal((await linuxSystemdProperties(f.unit, ['MainPID'])).MainPID, '0');
});

test('explicit inactive EnvironmentFile masks global defaults and retains its own PATH', native, async t => {
  const f = await configured(t);
  await managerUrl(t, 'https://manager.example');
  const source = path.join(f.project, 'runtime.env');
  const runtimePath = `${path.dirname(f.node)}:/usr/bin:/bin`;
  await writeFile(source, `NEXTAUTH_URL=https://installed.example\nPATH=${runtimePath}\n`);
  await writeFile(f.fragment, `${f.bytes}\nEnvironmentFile=${source.replaceAll('%', '%%')}\n`);
  await systemctl('daemon-reload');
  const service = await inspectLinuxInactiveService(f);
  t.after(() => service.close());
  const result = await inspectLinuxConfiguration({ service, profile });
  assert.equal(result.buildEnvironment({}).NEXTAUTH_URL, 'https://installed.example');
  assert.equal(result.startupEnvironment().NEXTAUTH_URL, 'https://installed.example');
  assert.deepEqual(result.runtimePath(), runtimePath.split(':'));
  await result.check();
  const before = await readFile(source);
  await systemctl('set-environment', 'NEXTAUTH_URL=https://changed.example');
  await assert.rejects(result.check(), { check: 'inactive-environment-changed' });
  assert.deepEqual(await readFile(source), before);
  assert.equal((await linuxSystemdProperties(f.unit, ['MainPID'])).MainPID, '0');
});

test('inactive admission retains strict unsupported environment policy and cancellation refusal', native, async t => {
  const f = await configured(t);
  await writeFile(f.fragment, `${f.bytes}\nPassEnvironment=HOME\n`);
  await systemctl('daemon-reload');
  const service = await inspectLinuxInactiveService(f);
  t.after(() => service.close());
  await assert.rejects(inspectLinuxConfiguration({ service, profile }), { check: 'runtime-environment-policy' });
  const cancelled = new AbortController();
  cancelled.abort(new Error('inactive configuration cancelled'));
  await assert.rejects(inspectLinuxConfiguration({ service, profile, signal: cancelled.signal }), /cancelled/);
});
