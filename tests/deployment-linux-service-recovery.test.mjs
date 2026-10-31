import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { systemctl } from './deployment-linux-service-fixture.mjs';
import { interrupted } from './deployment-linux-service-recovery-fixture.mjs';
import { acquireLock, releaseLock, reconcileInterruptedOperation } from '../scripts/deployment/state.mjs';
import { recoverLinuxServiceRetirement } from '../scripts/deployment/linux-service-recovery.mjs';

for (const phase of ['retirement-intent', 'retirement-unlink-0', 'retirement-unlink-1', 'retirement-unlink-2']) {
  test(`saved cold service retirement accepts only the missing deletion prefix: ${phase}`, async t => {
    const f = await interrupted(t, phase);
    await f.kill();
    const state = await readFile(path.join(f.control, 'state.json'));
    const intent = JSON.parse(await readFile(path.join(f.control, 'service-retirement.json'), 'utf8'));
    await rename(f.source, `${f.source}.displaced`);
    assert.deepEqual(JSON.parse((await f.recover()).stdout), {
      status: 'service-retired', operationId: f.lock.operationId, restored: false,
    });
    assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-complete.json', 'recovery-engine', 'state.json']);
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
    assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(),
      intent.runtime.runtime.invocationId);
    const next = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
    await releaseLock(f.control, next);
  });
}

test('cold service cleanup preserves the failed-update outcome after verified prior-runtime restart', async t => {
  const f = await interrupted(t, 'retirement-unlink-0', 'prior-runtime-restored');
  await f.kill();
  const state = await readFile(path.join(f.control, 'state.json'));
  assert.equal(JSON.parse(state).errorCode, 'BACKUP_FAILED');
  await f.recover();
  assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
  assert.equal((await reconcileInterruptedOperation(f.control)).status, 'prior-runtime-restored');
});

for (const phase of ['retirement-unlink-0', 'retirement-live-lock-owner']) {
  test(`cold cleanup preserves restored acceptance after interruption: ${phase}`, async t => {
    const f = await interrupted(t, phase, 'restored');
    await f.kill();
    const before = await readFile(path.join(f.control, 'state.json'));
    assert.equal(JSON.parse(before).operation, 'restore');
    assert.equal(JSON.parse(before).phase, 'restored');
    await rename(f.source, `${f.source}.displaced`);
    await f.recover();
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), before);
    await assert.rejects(readFile(path.join(f.control, 'lock', 'owner.json')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
    await f.recover();
    const next = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
    await releaseLock(f.control, next);
  });
}

for (const [phase, outcome, workerMode] of [
  ['retirement-intent', 'accepted', 'settled'],
  ['retirement-unlink-0', 'accepted', 'empty'],
  ['retirement-unlink-2', 'prior-runtime-restored', 'settled'],
]) {
  test(`cold combined service/worker cleanup uses one pinned inventory: ${phase}/${workerMode}`, async t => {
    const f = await interrupted(t, phase, outcome, workerMode);
    await f.kill();
    const state = await readFile(path.join(f.control, 'state.json'));
    const intent = JSON.parse(await readFile(path.join(f.control, 'service-retirement.json'), 'utf8'));
    assert.equal(intent.version, 3);
    assert.ok(intent.workers.files.some(entry => path.basename(entry.file) === 'worker-operation.ndjson'));
    assert.match(intent.workers.manifestSha256, /^[a-f0-9]{64}$/);
    if (workerMode === 'settled') assert.equal(await readFile(path.join(f.project, 'worker-finished'), 'utf8'), 'yes');
    await rename(f.source, `${f.source}.displaced`);
    assert.deepEqual(JSON.parse((await f.recover()).stdout), {
      status: 'service-retired', operationId: f.lock.operationId, restored: false,
    });
    assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-complete.json', 'recovery-engine', 'state.json']);
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
    assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(),
      intent.runtime.runtime.invocationId);
    const next = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
    await releaseLock(f.control, next);
  });
}

for (const change of ['worker-file', 'helper', 'foreign', 'missing-worker', 'worker-path', 'downgrade']) {
  test(`combined recovery rejects worker inventory drift before service deletion: ${change}`, async t => {
    const f = await interrupted(t, 'retirement-intent', 'accepted', 'settled');
    await f.kill();
    const markerPath = path.join(f.control, 'service-retirement.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    const journal = (await readdir(f.control)).find(name => /^worker-[a-f0-9-]{36}\.ndjson$/.test(name));
    if (change === 'worker-file') await writeFile(path.join(f.control, journal), '{"partial":');
    if (change === 'helper') await writeFile(path.join(f.control, 'worker-engine', 'state.mjs'), 'changed');
    if (change === 'foreign') await writeFile(path.join(f.control, 'worker-foreign'), 'unowned');
    if (change === 'missing-worker') await unlink(path.join(f.control, journal));
    if (change === 'worker-path') {
      assert.ok(marker.workers);
      marker.workers.files[0].file = path.join(f.control, 'backup', 'sentinel');
      await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
    }
    if (change === 'downgrade') {
      marker.version = 2;
      delete marker.workers;
      await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
    }
    const before = (await readdir(f.control)).sort();
    const held = await readFile(marker.files[0].file);
    await assert.rejects(f.recover());
    assert.deepEqual((await readdir(f.control)).sort(), before);
    assert.deepEqual(await readFile(marker.files[0].file), held);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
  });
}

test('v2 service-only retirement remains recoverable without adopting worker files', async t => {
  const f = await interrupted(t);
  await f.kill();
  const file = path.join(f.control, 'service-retirement.json');
  const marker = JSON.parse(await readFile(file, 'utf8'));
  marker.version = 2;
  delete marker.workers;
  await writeFile(file, JSON.stringify(marker), { mode: 0o600 });
  assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired');
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-complete.json', 'recovery-engine', 'state.json']);
});

test('cold service cleanup refuses live owner and preserves evidence without creating a guard', async t => {
  const f = await interrupted(t);
  const marker = await readFile(path.join(f.control, 'service-retirement.json'));
  await assert.rejects(f.recover());
  assert.deepEqual(await readFile(path.join(f.control, 'service-retirement.json')), marker);
  assert.ok(!(await readdir(f.control)).includes('recovery-lock'));
});

for (const change of ['restart', 'source', 'state', 'path', 'gap', 'worker', 'guard', 'journal-replacement', 'boot', 'legacy']) {
  test(`cold service cleanup refuses changed or unowned evidence before deletion: ${change}`, async t => {
    const f = await interrupted(t);
    await f.kill();
    const markerPath = path.join(f.control, 'service-retirement.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (change === 'restart') await systemctl('restart', f.unit);
    if (change === 'source') await writeFile(f.fragment, `${f.bytes}\n# changed source\n`);
    if (change === 'state') await writeFile(path.join(f.control, 'state.json'), '{}');
    if (change === 'path') {
      marker.files[1].file = path.join(f.control, 'backup', 'sentinel');
      await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
    }
    if (change === 'boot') {
      marker.runtime.bootId = randomUUID();
      await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
    }
    if (change === 'legacy') {
      marker.version = 1;
      await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
    }
    if (change === 'gap') await unlink(path.join(f.control, 'service-stop.ndjson'));
    if (change === 'worker') await writeFile(path.join(f.control, 'worker-operation.ndjson'), '{"partial":');
    if (change === 'guard') await mkdir(path.join(f.control, 'recovery-lock'), { mode: 0o700 });
    if (change === 'journal-replacement') {
      const file = path.join(f.control, 'service-activation.ndjson');
      await rename(file, `${file}.old`);
      await writeFile(file, await readFile(`${file}.old`), { mode: 0o600 });
      await unlink(`${file}.old`);
    }
    const before = (await readdir(f.control)).sort();
    await assert.rejects(f.recover());
    assert.deepEqual((await readdir(f.control)).sort(), before);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
  });
}

for (const fault of ['delete', 'state-drift', 'close', 'lock-delete', 'worker-delete', 'engine-rmdir']) {
  test(`cold service cleanup retains blocking authority on recovery fault: ${fault}`, async t => {
    const combined = ['worker-delete', 'engine-rmdir'].includes(fault);
    const f = await interrupted(t, 'retirement-unlink-0', 'accepted', combined ? 'settled' : 'none');
    await f.kill();
    let injected = false;
    const originalUnlink = fs.unlink;
    const originalOpen = fs.open;
    const originalRmdir = fs.rmdir;
    t.mock.method(fs, 'unlink', async file => {
      if (fault === 'delete' && file === path.join(f.control, 'service-stop.ndjson')
        || fault === 'lock-delete' && file === path.join(f.control, 'lock', 'owner.json')
        || fault === 'worker-delete' && file === path.join(f.control, 'worker-engine', 'state.mjs')) {
        injected = true;
        throw new Error('injected exact recovery deletion failure');
      }
      await originalUnlink(file);
      if (fault === 'state-drift' && file === path.join(f.control, 'service-activation.ndjson')) {
        injected = true;
        await writeFile(path.join(f.control, 'state.json'), '{}');
      }
    });
    t.mock.method(fs, 'rmdir', async file => {
      if (fault === 'engine-rmdir' && file === path.join(f.control, 'worker-engine')) {
        injected = true;
        throw new Error('injected helper directory retirement failure');
      }
      return originalRmdir(file);
    });
    t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (fault === 'close' && file === path.join(f.control, 'service-retirement.json')) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          if (!injected && (await readdir(f.control)).includes('recovery-lock')
            && (await readdir(f.control)).includes('recovery-complete.json')) {
            injected = true;
            throw new Error('injected recovery retained descriptor close failure');
          }
          return close();
        };
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(recoverLinuxServiceRetirement({
        control: f.control, project: f.project, operationId: f.lock.operationId,
      }), { recoveryAllowed: false });
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.ok((await readdir(f.control)).includes('lock'));
    assert.ok((await readdir(f.control)).includes('recovery-lock'));
    await assert.rejects(f.recover());
    await assert.rejects(acquireLock(f.control, { project: f.project, operationId: randomUUID() }));
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
  });
}
