import assert from 'node:assert/strict';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fixture, ready, systemctl } from './deployment-linux-service-fixture.mjs';
import { inspectLinuxInactiveService } from '../scripts/deployment/linux-inactive-service.mjs';
import { linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';

const native = { skip: process.platform !== 'linux' || process.getuid() !== 0 };

for (const state of ['inactive', 'failed']) {
  test(`native ${state} service observation preserves configured identity without activation`, native, async t => {
    const f = await fixture(t, { nonroot: true, start: false, settings: 'Restart=no',
      ...(state === 'failed' ? { server: 'process.exit(42);' } : {}) });
    if (state === 'failed') {
      try { await systemctl('start', f.unit); }
      catch (error) { assert.equal(error.code, 1); }
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await linuxSystemdProperties(f.unit, ['ActiveState'])).ActiveState === 'failed') break;
        await delay(100);
      }
    }
    assert.equal((await linuxSystemdProperties(f.unit, ['ActiveState'])).ActiveState, state);
    const before = (await readdir(f.project)).sort();
    const control = path.join(path.dirname(f.project), `.${path.basename(f.project)}.deployment`);
    const observed = await inspectLinuxInactiveService(f);
    try {
      assert.equal(observed.kind, 'inactive');
      assert.equal(observed.identity.runtime.activeState, state);
      assert.equal(observed.identity.runtime.mainPid, 0);
      assert.equal(observed.identity.runtime.processIdentity, null);
      assert.equal(observed.identity.runtime.uid, 65534);
      assert.equal(observed.identity.configuration.state.MainPID, '0');
      assert.deepEqual(observed.identity.sources.map(source => source.path), [f.fragment]);
      assert.equal(Object.isFrozen(observed.identity), true);
      assert.equal(Object.isFrozen(observed.identity.runtime), true);
      await observed.check();
      assert.equal((await linuxSystemdProperties(f.unit, ['ActiveState'])).ActiveState, state);
      assert.deepEqual((await readdir(f.project)).sort(), before);
      await assert.rejects(lstat(control), { code: 'ENOENT' });
    } finally { await observed.close(); }
    await observed.close();
    await assert.rejects(observed.check(), /closed/i);
  });
}

test('inactive observation rejects a running service rather than treating it as absent', native, async t => {
  const f = await fixture(t, { nonroot: true });
  await ready(f);
  await assert.rejects(inspectLinuxInactiveService(f), /inactive|quiescent/i);
  assert.equal((await linuxSystemdProperties(f.unit, ['ActiveState'])).ActiveState, 'active');
});

for (const change of ['activation', 'source']) {
  test(`inactive service observation refuses later ${change}`, native, async t => {
    const f = await fixture(t, { nonroot: true, start: false });
    const observed = await inspectLinuxInactiveService(f);
    try {
      if (change === 'activation') {
        await systemctl('start', f.unit);
        await ready(f);
      } else await writeFile(f.fragment, `${f.bytes}\n# changed source\n`);
      await assert.rejects(observed.check(), /changed|inactive|quiescent|stale/i);
    } finally { await observed.close(); }
  });
}
