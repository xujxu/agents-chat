import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { interrupted } from './deployment-linux-service-recovery-fixture.mjs';
import { systemctl } from './deployment-linux-service-fixture.mjs';
import { inspectLinuxColdService } from '../scripts/deployment/linux-cold-service.mjs';

async function stopped(t) {
  const f = await interrupted(t, 'stopped');
  await f.kill();
  const records = (await readFile(path.join(f.control, 'service-stop.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { ...f, original: records.at(-1).service, inhibition: records.at(-1).inhibition };
}

test('cold inspection re-establishes an inhibited empty service after losing all original handles', async t => {
  const f = await stopped(t);
  const service = await inspectLinuxColdService({ original: f.original });
  t.after(() => service.close());
  assert.deepEqual(service.identity, f.original);
  assert.deepEqual(await service.check(), { stopped: true, inhibited: true });
  assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
  const changed = structuredClone(f.original);
  changed.bootId = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(inspectLinuxColdService({ original: changed }), /boot|identity/i);
  assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
});

test('cold inspection refuses missing inhibition and never stops a replacement generation', async t => {
  const f = await stopped(t);
  await unlink(f.inhibition);
  await systemctl('daemon-reload');
  await assert.rejects(inspectLinuxColdService({ original: f.original }), /inhibit|policy|configuration/i);
  await systemctl('start', f.unit);
  const before = (await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim();
  await assert.rejects(inspectLinuxColdService({ original: f.original }));
  assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(), before);
  assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
});

test('cold inspection binds both inhibitor links after death during activated-generation stop', async t => {
  const f = await interrupted(t, 'activation-stop:activation-stopped');
  await f.kill();
  const records = (await readFile(path.join(f.control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const last = records.at(-1);
  assert.equal(last.phase, 'activation-stopped');
  const service = await inspectLinuxColdService({ original: last.started, held: last.held });
  t.after(() => service.close());
  assert.deepEqual(await service.check(), { stopped: true, inhibited: true });
  await assert.rejects(inspectLinuxColdService({ original: last.started }), /inhibit/i);
  await unlink(last.held);
  await assert.rejects(service.check(), /inhibit|ENOENT/i);
});

test('retained cold inspection detects changed source, inhibitor bytes and account evidence', async t => {
  const f = await stopped(t);
  const service = await inspectLinuxColdService({ original: f.original });
  t.after(() => service.close());
  const bytes = await readFile(f.inhibition);
  await writeFile(f.inhibition, `${bytes}\n`);
  await assert.rejects(service.check(), /inhibit|changed/i);
  await writeFile(f.inhibition, bytes);
  await systemctl('daemon-reload');
  const wrongAccount = structuredClone(f.original);
  wrongAccount.runtime.uid = 12345;
  await assert.rejects(inspectLinuxColdService({ original: wrongAccount }), /account|identity/i);
  await writeFile(f.fragment, `${await readFile(f.fragment, 'utf8')}\n`);
  await systemctl('daemon-reload');
  await assert.rejects(inspectLinuxColdService({ original: f.original }), /source|changed/i);
});
