import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { inspectLinuxInactiveService } from '../scripts/deployment/linux-inactive-service.mjs';
import { inspectLinuxColdService } from '../scripts/deployment/linux-cold-service.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';
import { linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';
import { acquireLock, loadState, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { quiescentFixture, ready } from './deployment-linux-service-fixture.mjs';

const native = { skip: process.platform !== 'linux' || process.getuid() !== 0 };

async function maintenanceFixture(t, runtimeState, { wrongIdentity = false } = {}) {
  const f = await quiescentFixture(t, runtimeState);
  const observation = await inspectLinuxInactiveService(f);
  t.after(() => observation.close());
  assert.match(observation.runtimeIdentity, /^stopped:[a-f0-9]{64}$/);
  let runtimeIdentity = observation.runtimeIdentity;
  if (wrongIdentity) runtimeIdentity = `${runtimeIdentity.slice(0, -1)}${runtimeIdentity.at(-1) === '0' ? '1' : '0'}`;
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  const state = {
    version: 1, operationId: lock.operationId, project: f.project, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
    backupId: null, priorRuntime: 'stopped', runtimeIdentity,
    startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
  };
  await writeState(control, state);
  await writeState(control, { ...state, phase: 'stopped', previousPhase: 'preflight' });
  return { ...f, control, lock, observation };
}

test('inactive maintenance refuses a different observation identity before creating inhibition', native, async t => {
  const f = await maintenanceFixture(t, 'inactive', { wrongIdentity: true });
  await assert.rejects(stopLinuxService(f), error => {
    assert.equal(error.code, 'DEPLOYMENT_WORKER_UNSETTLED');
    assert.equal(error.recoveryAllowed, false);
    assert.match(error.cause?.message, /observation identity/i);
    return true;
  });
  await f.observation.check();
  await assert.rejects(lstat(`${f.fragment}.d/90-agents-chat-deployment.conf`), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.control)).sort(), ['lock', 'state.json']);
});

for (const state of ['inactive', 'failed']) {
  test(`native initially ${state} maintenance retains truthful stopped evidence and cold inspection`, native, async t => {
    const f = await maintenanceFixture(t, state);
    const stopped = await stopLinuxService(f);
    t.after(() => stopped.close());
    assert.deepEqual(await stopped.checkStopped(), { stopped: true, inhibited: true });
    assert.equal((await linuxSystemdProperties(f.unit, ['ActiveState'])).ActiveState, state);
    const records = (await readFile(path.join(f.control, 'service-stop.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(record => record.phase), ['intent', 'inhibited', 'stopped']);
    assert.ok(records.every(record => record.version === 2));
    assert.deepEqual(records[0].service, f.observation.identity);
    assert.equal((await loadState(f.control)).priorRuntime, 'stopped');
    await assert.rejects(lstat(path.join(f.control, 'backup')), { code: 'ENOENT' });
    await assert.rejects(stopped.activate({ purpose: 'prior-runtime' }), /previously running|originally stopped/i);
    assert.deepEqual(await stopped.checkStopped(), { stopped: true, inhibited: true });
    await stopped.close();
    await f.observation.close();
    const cold = await inspectLinuxColdService({ original: records[0].service });
    try {
      assert.deepEqual(await cold.check(), { stopped: true, inhibited: true });
      assert.deepEqual(cold.identity, records[0].service);
      assert.equal(cold.runtimeIdentity, f.observation.runtimeIdentity);
      const wrongHierarchy = structuredClone(records[0].service);
      wrongHierarchy.domain.base.ino++;
      await assert.rejects(inspectLinuxColdService({ original: wrongHierarchy }), /hierarchy/i);
      const fictionalProcess = structuredClone(records[0].service);
      fictionalProcess.runtime.processIdentity = 'fictional-running-process';
      await assert.rejects(inspectLinuxColdService({ original: fictionalProcess }), /inactive.*identity/i);
      await writeFile(records[0].inhibition, `${await readFile(records[0].inhibition, 'utf8')}\n`);
      await assert.rejects(cold.check(), /inhibit|changed/i);
    } finally { await cold.close(); }
  });
}

test('native initially stopped maintenance activates only the new deployment and retires its own evidence', native, async t => {
  const f = await maintenanceFixture(t, 'inactive');
  const stopped = await stopLinuxService(f);
  t.after(() => stopped.close());
  for (const phase of ['copying', 'rotating', 'backup-ready', 'source-selected',
    'dependencies', 'building', 'configuring', 'activating']) {
    const state = await loadState(f.control);
    await writeState(f.control, { ...state, phase, previousPhase: state.phase });
  }
  const active = await stopped.activate({ purpose: 'deployment' });
  assert.equal(active.status, 'active-unverified');
  assert.ok(active.identity.runtime.mainPid > 0);
  assert.equal(active.identity.runtime.uid, 65534);
  await ready(f);
  const state = await loadState(f.control);
  await writeState(f.control, { ...state, phase: 'accepted', previousPhase: 'activating' });
  await stopped.retire();
  await releaseLock(f.control, f.lock);
  assert.equal((await linuxSystemdProperties(f.unit, ['ActiveState'])).ActiveState, 'active');
  assert.equal((await loadState(f.control)).priorRuntime, 'stopped');
  assert.equal((await loadState(f.control)).runtimeIdentity, f.observation.runtimeIdentity);
  assert.deepEqual((await readdir(f.control)).sort(), ['state.json']);
});
