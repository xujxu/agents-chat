import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { quiescentFixture, quote, ready, systemctl } from './deployment-linux-service-fixture.mjs';
import { inspectInstalledLinuxService, inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';

const native = { skip: process.platform !== 'linux' || process.getuid() !== 0 };

async function configured(t, state = 'inactive') {
  const f = await quiescentFixture(t, state, { settings: 'Environment=SGX_AESM_ADDR=' });
  await writeFile(path.join(f.project, '.env.production.local'), [
    'NODE_ENV=production', 'NEXTAUTH_SECRET=private-discovery-fixture-secret',
    'NEXTAUTH_URL=http://localhost:3010', 'ADMIN_USERNAME=fixture', 'ADMIN_PASSWORD=private-discovery-fixture-password',
  ].join('\n'));
  return f;
}

for (const state of ['inactive', 'failed']) {
  test(`installed ${state} executable discovery uses configured PATH without starting the service`, native, async t => {
    const f = await configured(t, state);
    const before = await linuxSystemdProperties(f.unit, ['ActiveState', 'MainPID', 'ExecMainStatus']);
    const service = await inspectInstalledLinuxService({ unit: f.unit, project: f.project });
    try {
      assert.equal(service.kind, 'inactive');
      assert.match(service.runtimeIdentity, /^stopped:[a-f0-9]{64}$/);
      assert.equal(service.identity.executables[0].file, f.npm);
      assert.equal(service.identity.executables[1].file, f.node);
      await service.check();
      assert.deepEqual(await linuxSystemdProperties(f.unit, ['ActiveState', 'MainPID', 'ExecMainStatus']), before);
    } finally { await service.close(); }
  });
}

test('inactive discovery refuses a project-local first Node candidate instead of falling through PATH', native, async t => {
  const f = await configured(t);
  await symlink(f.node, path.join(f.project, 'node'));
  await writeFile(f.fragment, `${f.bytes}\nEnvironment=${quote(`PATH=${f.project}:${path.dirname(f.node)}:/usr/bin:/bin`)}\n`);
  await systemctl('daemon-reload');
  await assert.rejects(inspectInstalledLinuxService({ unit: f.unit, project: f.project }), /external|project|runtime/i);
  assert.equal((await linuxSystemdProperties(f.unit, ['MainPID'])).MainPID, '0');
});

test('inactive discovery rechecks higher-priority executable appearance before granting policy authority', native, async t => {
  const f = await configured(t);
  const priority = path.join(path.dirname(f.project), 'priority-bin');
  await mkdir(priority, { mode: 0o755 });
  await writeFile(f.fragment, `${f.bytes}\nEnvironment=${quote(`PATH=${priority}:${path.dirname(f.node)}:/usr/bin:/bin`)}\n`);
  await systemctl('daemon-reload');
  const service = await inspectInstalledLinuxService({ unit: f.unit, project: f.project });
  try {
    await service.check();
    await symlink('/usr/bin/false', path.join(priority, 'node'));
    await assert.rejects(service.check(), /changed|runtime|executable/i);
    await assert.rejects(service.checkPolicy(), /changed|runtime|executable/i);
  } finally { await service.close(); }
});

test('inactive discovery refuses an unreviewed npm interpreter before executing it', native, async t => {
  const f = await configured(t);
  const npm = path.join(path.dirname(f.project), 'npm-cli.js');
  await writeFile(npm, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  await writeFile(f.fragment, `${f.bytes}\nExecStart=\nExecStart=${quote(npm)} start\n`);
  await systemctl('daemon-reload');
  await assert.rejects(inspectInstalledLinuxService({ unit: f.unit, project: f.project }), /npm|interpreter|executable/i);
  assert.equal((await linuxSystemdProperties(f.unit, ['MainPID'])).MainPID, '0');
});

test('running observation cannot claim an external executable other than the real main process image', native, async t => {
  const f = await configured(t);
  await systemctl('start', f.unit);
  await ready(f);
  await assert.rejects((async () => {
    const service = await inspectLinuxService({ ...f, node: '/usr/bin/false' });
    try { await service.check(); }
    finally { await service.close(); }
  })(), /executable|image|Node|runtime/i);
});
