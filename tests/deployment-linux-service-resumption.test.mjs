import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { systemctl } from './deployment-linux-service-fixture.mjs';
import { interrupted, pausedRecovery } from './deployment-linux-service-recovery-fixture.mjs';
import { acquireLock, releaseLock, reconcileInterruptedOperation } from '../scripts/deployment/state.mjs';

for (const pause of ['lease', 'service', 'worker', 'pending', 'completion', 'marker', 'lock-owner', 'lock-directory', 'guard-owner', 'guard-directory']) {
test(`killed recovery resumes safely through cleanup and unlock: ${pause}`, async t => {
  const f = await interrupted(t, 'retirement-unlink-0', 'accepted', pause === 'worker' ? 'settled' : 'none');
  await f.kill();
  const kill = await pausedRecovery(t, f, pause);
  await assert.rejects(f.recover());
  await kill();
  if (pause === 'worker') {
    assert.ok((await readdir(f.control)).includes('worker-engine'));
    assert.ok(!(await readdir(f.control)).includes('service-stop.ndjson'));
  }

  if (pause !== 'guard-directory') assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
  assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired');
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-complete.json', 'recovery-engine', 'state.json']);
  assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
  assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired');
  const next = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
  await assert.rejects(f.recover());
  await releaseLock(f.control, next);
});
}

test('a later original operation can recover without replaying the previous completion receipt', async t => {
  const first = await interrupted(t);
  await first.kill();
  await first.recover();
  const previous = await readFile(path.join(first.control, 'recovery-complete.json'));
  const next = await interrupted(t, 'retirement-unlink-0', 'accepted', 'none', first);
  await next.kill();
  await assert.rejects(first.recover());
  assert.equal(JSON.parse((await next.recover()).stdout).status, 'service-retired');
  const current = await readFile(path.join(first.control, 'recovery-complete.json'));
  assert.notDeepEqual(current, previous);
  assert.equal(JSON.parse(JSON.parse(current).intent).lock.operationId, next.lock.operationId);
});

for (const [phase, mode] of [
  ['retirement-live-published', 'none'],
  ['retirement-live-published', 'settled'],
  ['retirement-live-workers-done', 'settled'],
  ['retirement-live-lock-owner', 'settled'],
  ['retirement-live-lock-directory', 'none'],
  ['retirement-live-lock-directory', 'settled'],
]) {
  test(`normal live retirement interruption preserves authority through unlock: ${phase}/${mode}`, async t => {
    const f = await interrupted(t, phase, 'accepted', mode);
    const state = await readFile(path.join(f.control, 'state.json'));
    const receipt = JSON.parse(await readFile(path.join(f.control, 'live-retirement.json')));
    await assert.rejects(f.recover());
    await f.kill();
    assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
    await assert.rejects(acquireLock(f.control, { project: f.project, operationId: randomUUID() }));
    assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired');
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
    assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(),
      receipt.runtime.runtime.invocationId);
    assert.ok(!(await readdir(f.control)).includes('live-retirement.json'));
    assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired');
    const next = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
    await assert.rejects(f.recover());
    await releaseLock(f.control, next);
  });
}

test('cold live-unlock recovery refuses a substituted old lock directory after owner unlink', async t => {
  const f = await interrupted(t, 'retirement-live-lock-owner', 'accepted', 'none');
  await f.kill();
  const lock = path.join(f.control, 'lock');
  await rename(lock, `${lock}.displaced`);
  await mkdir(lock, { mode: 0o700 });
  const receipt = await readFile(path.join(f.control, 'live-retirement.json'));
  await assert.rejects(f.recover());
  assert.deepEqual(await readFile(path.join(f.control, 'live-retirement.json')), receipt);
  assert.ok(!(await readdir(f.control)).includes('recovery-lock'));
});

test('recovery may die twice without replacing its immutable lease or losing the cleanup inventory', async t => {
  const f = await interrupted(t, 'retirement-unlink-0', 'accepted', 'settled');
  await f.kill();
  const first = await pausedRecovery(t, f, 'service');
  const lease = await readFile(path.join(f.control, 'recovery-lock', 'owner.json'));
  await first();
  const second = await pausedRecovery(t, f, 'worker');
  assert.deepEqual(await readFile(path.join(f.control, 'recovery-lock', 'owner.json')), lease);
  await assert.rejects(f.recover());
  await second();
  assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired');
  assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
});

for (const fault of ['lease', 'guard-replacement', 'completion-digest', 'completion-gap', 'restart']) {
  test(`resumed recovery refuses altered authority without further deletion: ${fault}`, async t => {
    const f = await interrupted(t);
    await f.kill();
    const kill = await pausedRecovery(t, f, fault === 'lease' || fault === 'guard-replacement' ? 'service' : 'completion');
    await kill();
    const guard = path.join(f.control, 'recovery-lock');
    if (fault === 'lease') {
      const file = path.join(guard, 'owner.json');
      const lease = JSON.parse(await readFile(file));
      lease.intentSha256 = '0'.repeat(64);
      await writeFile(file, JSON.stringify(lease), { mode: 0o600 });
    }
    if (fault === 'guard-replacement') {
      await rename(guard, `${guard}.old`);
      await mkdir(guard, { mode: 0o700 });
      await rename(path.join(`${guard}.old`, 'owner.json'), path.join(guard, 'owner.json'));
      await fs.rmdir(`${guard}.old`);
    }
    if (fault === 'completion-digest') {
      const file = path.join(f.control, 'recovery-complete.json');
      const receipt = JSON.parse(await readFile(file));
      receipt.intentSha256 = '0'.repeat(64);
      await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
    }
    if (fault === 'completion-gap') await unlink(path.join(guard, 'owner.json'));
    if (fault === 'restart') await systemctl('restart', f.unit);
    const before = (await readdir(f.control)).sort();
    await assert.rejects(f.recover());
    assert.deepEqual((await readdir(f.control)).sort(), before);
    assert.ok(before.includes('lock'));
    assert.ok(before.includes('recovery-lock'));
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
  });
}
