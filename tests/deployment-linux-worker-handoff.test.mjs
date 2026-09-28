import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { systemctl } from './deployment-linux-service-fixture.mjs';
import { interrupted, pausedRecovery } from './deployment-linux-service-recovery-fixture.mjs';
import { acquireLock, releaseLock, reconcileInterruptedOperation } from '../scripts/deployment/state.mjs';
import { recoverLinuxServiceRetirement } from '../scripts/deployment/linux-service-recovery.mjs';
import { recoverRetirement } from '../scripts/deployment/retirement-recovery.mjs';

for (const [boundary, mode, outcome] of [
  ['intent', 'empty', 'accepted'],
  ['intent', 'settled', 'accepted'],
  ['journal', 'settled', 'accepted'],
  ['helper', 'settled', 'prior-runtime-restored'],
  ['last-helper', 'settled', 'accepted'],
  ['directory', 'settled', 'accepted'],
  ['operation', 'settled', 'accepted'],
  ['marker', 'settled', 'accepted'],
]) {
  test(`combined handoff continues actual live worker retirement: ${boundary}/${mode}`, async t => {
    const f = await interrupted(t, `retirement-live-worker-${boundary}`, outcome, mode);
    await assert.rejects(f.recover());
    await f.kill();
    const state = await readFile(path.join(f.control, 'state.json'));
    const live = JSON.parse(await readFile(path.join(f.control, 'live-retirement.json')));
    assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
    await assert.rejects(acquireLock(f.control, { project: f.project, operationId: randomUUID() }));
    await assert.rejects(recoverRetirement({ control: f.control, project: f.project, operationId: f.lock.operationId }));
    assert.ok(!(await readdir(f.control)).includes('recovery-lock'));
    await rename(f.source, `${f.source}.displaced`);
    assert.deepEqual(JSON.parse((await f.recover()).stdout), {
      status: 'service-retired', operationId: f.lock.operationId, restored: false,
    });
    assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-complete.json', 'recovery-engine', 'state.json']);
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
    assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(),
      live.runtime.runtime.invocationId);
    assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired');
    const next = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
    await assert.rejects(f.recover());
    await releaseLock(f.control, next);
  });
}

for (const change of ['partial', 'lock', 'state', 'manifest', 'directory', 'files', 'gap', 'missing-owner']) {
  test(`combined handoff rejects mismatched worker retirement before deletion: ${change}`, async t => {
    const f = await interrupted(t, 'retirement-live-worker-intent', 'accepted', 'settled');
    await f.kill();
    const file = path.join(f.control, 'worker-retirement.json');
    const marker = JSON.parse(await readFile(file));
    if (change === 'partial') await writeFile(file, '{"version":');
    else if (change === 'gap') await unlink(path.join(f.control, 'worker-operation.ndjson'));
    else if (change === 'missing-owner') await unlink(path.join(f.control, 'lock', 'owner.json'));
    else {
      if (change === 'lock') marker.lock.token = randomUUID();
      if (change === 'state') marker.state.sha256 = '0'.repeat(64);
      if (change === 'manifest') marker.manifestSha256 = '0'.repeat(64);
      if (change === 'directory') marker.engineIdentity.ino = '0';
      if (change === 'files') marker.files[0].path = path.join('backup', 'sentinel');
      await writeFile(file, JSON.stringify(marker));
    }
    const bytes = await readFile(file);
    const before = (await readdir(f.control)).sort();
    const helpers = (await readdir(path.join(f.control, 'worker-engine'))).sort();
    await assert.rejects(f.recover());
    assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual((await readdir(f.control)).sort(), before);
    assert.deepEqual((await readdir(path.join(f.control, 'worker-engine'))).sort(), helpers);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
  });
}

for (const pause of ['lease', 'worker-marker', 'worker']) {
  test(`combined handoff survives recovery controller death: ${pause}`, async t => {
    const f = await interrupted(t, 'retirement-live-worker-helper', 'accepted', 'settled');
    await f.kill();
    const kill = await pausedRecovery(t, f, pause);
    await assert.rejects(f.recover());
    await kill();
    assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired');
    assert.ok(!(await readdir(f.control)).includes('worker-retirement.json'));
  });
}

test('worker marker unlink failure retains both handoffs and the exclusive recovery lease', async t => {
  const f = await interrupted(t, 'retirement-live-worker-helper', 'accepted', 'settled');
  await f.kill();
  const marker = path.join(f.control, 'worker-retirement.json');
  const bytes = await readFile(marker);
  const helpers = (await readdir(path.join(f.control, 'worker-engine'))).sort();
  const original = fs.unlink;
  let injected = false;
  t.mock.method(fs, 'unlink', async file => {
    if (file === marker) { injected = true; throw new Error('injected handoff unlink failure'); }
    return original(file);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(recoverLinuxServiceRetirement({
      control: f.control, project: f.project, operationId: f.lock.operationId,
    }), { recoveryAllowed: false });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.deepEqual(await readFile(marker), bytes);
  assert.deepEqual((await readdir(path.join(f.control, 'worker-engine'))).sort(), helpers);
  assert.ok((await readdir(f.control)).includes('lock'));
  // The lease records this still-live controller; the child retry must refuse it.
  await assert.rejects(f.recover());
});
