import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { cp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { restoreCandidate } from './deployment-linux-restore-fixture.mjs';
import { interrupted } from './deployment-linux-service-recovery-fixture.mjs';
import { releaseLock } from '../scripts/deployment/state.mjs';
import { admitLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-admission.mjs';
import { claimLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-lease.mjs';

async function candidate(t, phase = 'stopped') {
  const f = await restoreCandidate(t);
  await releaseLock(f.control, f.lock);
  await cp(fileURLToPath(new URL('../scripts/deployment/', import.meta.url)),
    path.join(f.project, 'scripts', 'deployment'), { recursive: true });
  return interrupted(t, phase, 'accepted', 'none', f);
}

test('cold restore admission rejects a live controller and binds dead-owner evidence without replacing its lock', async t => {
  const f = await candidate(t);
  const lockFile = path.join(f.control, 'lock', 'owner.json');
  const originalLock = await readFile(lockFile);
  const originalState = await readFile(path.join(f.control, 'state.json'));
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: false }), /acknowledg|data.loss/i);
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }), /alive|live|owner/i);
  await f.kill();
  const admitted = await admitLinuxColdRestore({ ...f, acceptDataLoss: true });
  t.after(() => admitted.close());
  assert.equal(admitted.snapshot.id, 'live-restore');
  assert.deepEqual(admitted.lock, f.lock);
  assert.deepEqual(admitted.providers, ['credentials']);
  await admitted.check();
  assert.deepEqual(await readFile(lockFile), originalLock);
  assert.deepEqual(await readFile(path.join(f.control, 'state.json')), originalState);
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }), /admission|locking/i);
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
  await rename(lockFile, `${lockFile}.old`);
  await writeFile(lockFile, originalLock, { mode: 0o600 });
  await assert.rejects(admitted.check(), /evidence|changed/i);
});

test('cold restore admission refuses incomplete service evidence and unclassified workers without repairing either', async t => {
  const f = await candidate(t);
  await f.kill();
  const journal = path.join(f.control, 'service-stop.ndjson');
  const original = await readFile(journal);
  await writeFile(journal, original.subarray(0, original.length - 1));
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }));
  assert.deepEqual(await readFile(journal), original.subarray(0, original.length - 1));
  await writeFile(journal, original);
  const worker = path.join(f.control, 'worker-unclassified.ndjson');
  await writeFile(worker, '{"partial":', { mode: 0o600 });
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }));
  assert.equal(await readFile(worker, 'utf8'), '{"partial":');
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
});

test('cold restore admission rechecks the selected complete backup before permitting later restoration', async t => {
  const f = await candidate(t);
  await f.kill();
  const admitted = await admitLinuxColdRestore({ ...f, acceptDataLoss: true });
  t.after(() => admitted.close());
  await writeFile(path.join(f.backup, 'files', 'saved-data'), 'changed');
  await assert.rejects(admitted.check(), /checksum|integrity|changed/i);
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
});

test('cold restore admission recognizes only the recorded stopped activation and its two inhibitor links', async t => {
  const f = await candidate(t, 'activation-stop:activation-stopped');
  await f.kill();
  const records = (await readFile(path.join(f.control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const admitted = await admitLinuxColdRestore({ ...f, acceptDataLoss: true });
  t.after(() => admitted.close());
  assert.deepEqual(admitted.service.identity, records.at(-1).started);
  await admitted.check();
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
});

for (const pause of ['staged', 'published']) {
  test(`cold restore lease survives controller death after durable ${pause} publication without replacing the old lock`, async t => {
    const f = await candidate(t);
    await f.kill();
    const originalLock = await readFile(path.join(f.control, 'lock', 'owner.json'));
    const originalState = await readFile(path.join(f.control, 'state.json'));
    const child = fork(new URL('./deployment-cold-lease-child.mjs', import.meta.url),
      [f.control, f.project, f.backup, pause], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Cold lease did not pause: ${diagnostic}`)), 60000);
      child.once('message', message => { clearTimeout(timer); resolve(message); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Cold lease exited ${code}: ${diagnostic}`)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await assert.rejects(claimLinuxColdRestore({ ...f, acceptDataLoss: true }), /admission|locking|alive/i);
    child.kill('SIGKILL');
    await exited;
    const claimed = await claimLinuxColdRestore({ ...f, acceptDataLoss: true });
    t.after(() => claimed.close());
    await claimed.check();
    assert.equal(claimed.owner.pid, process.pid);
    assert.equal(claimed.snapshot.id, 'live-restore');
    assert.deepEqual(await readFile(path.join(f.control, 'lock', 'owner.json')), originalLock);
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), originalState);
    assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
    const lease = JSON.parse(await readFile(path.join(f.control, 'recovery-lock', 'owner.json'), 'utf8'));
    assert.deepEqual(lease.owner, claimed.owner);
    await claimed.close();
    await assert.rejects(claimLinuxColdRestore({ ...f, acceptDataLoss: true }), /alive|owner/i);
  });
}
