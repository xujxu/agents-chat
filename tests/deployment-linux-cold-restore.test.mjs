import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { cp, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { restoreCandidate } from './deployment-linux-restore-fixture.mjs';
import { interrupted } from './deployment-linux-service-recovery-fixture.mjs';
import { releaseLock } from '../scripts/deployment/state.mjs';
import { admitLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-admission.mjs';
import { claimLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-lease.mjs';
import { restoreLinuxColdFiles } from '../scripts/deployment/linux-cold-restore-files.mjs';
import { systemctl } from './deployment-linux-service-fixture.mjs';
import { activateLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-activation.mjs';
import { inspectLinuxColdActivation } from '../scripts/deployment/linux-cold-activation-recovery.mjs';

async function candidate(t, phase = 'stopped', valid = true) {
  const f = await restoreCandidate(t, valid);
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
    if (pause === 'staged') {
      const file = path.join(f.control, 'cold-restore-staging', 'owner.json');
      const complete = await readFile(file);
      await writeFile(file, '{"partial":');
      await assert.rejects(claimLinuxColdRestore({ ...f, acceptDataLoss: true }));
      assert.equal(await readFile(file, 'utf8'), '{"partial":');
      await writeFile(file, complete);
    }
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

test('cold file restoration resumes after controller death during project removal without unlocking or starting the service', async t => {
  const f = await candidate(t);
  await f.kill();
  const originalLock = await readFile(path.join(f.control, 'lock', 'owner.json'));
  const originalState = await readFile(path.join(f.control, 'state.json'));
  const child = fork(new URL('./deployment-cold-files-child.mjs', import.meta.url),
    [f.control, f.project, f.backup], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Cold file restore did not pause: ${diagnostic}`)), 90000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Cold file restore exited ${code}: ${diagnostic}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  child.kill('SIGKILL');
  await exited;
  await assert.rejects(readFile(path.join(f.project, 'saved-data')), { code: 'ENOENT' });
  const restored = await restoreLinuxColdFiles({ ...f, acceptDataLoss: true, timeoutSeconds: 90 });
  t.after(() => restored.close());
  assert.equal(restored.status, 'files-restored');
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'backup data');
  assert.deepEqual(await readFile(path.join(f.project, 'server.cjs')), await readFile(path.join(f.backup, 'files', 'server.cjs')));
  assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
  assert.deepEqual(await readFile(path.join(f.control, 'lock', 'owner.json')), originalLock);
  assert.deepEqual(await readFile(path.join(f.control, 'state.json')), originalState);
  await restored.check();
  const receipt = JSON.parse(await readFile(path.join(f.control, 'recovery-lock', 'files-restored.json'), 'utf8'));
  assert.equal(receipt.phase, 'files-restored');
  assert.equal(receipt.backupId, 'live-restore');
  assert.equal(receipt.token, f.lock.token);
});

for (const valid of [true, false]) {
  test(`cold activation verifies restored artifacts and retains recovery evidence (healthy=${valid})`, async t => {
    const f = await candidate(t, 'stopped', valid);
    await f.kill();
    const originalState = await readFile(path.join(f.control, 'state.json'));
    const originalLock = await readFile(path.join(f.control, 'lock', 'owner.json'));
    const restored = await restoreLinuxColdFiles({ ...f, acceptDataLoss: true, timeoutSeconds: 90 });
    t.after(() => restored.close());
    if (valid) {
      const active = await activateLinuxColdRestore({ restored, port: f.port, waitSeconds: 10, timeoutSeconds: 90 });
      t.after(() => active.close());
      assert.equal(active.status, 'ready-to-commit');
      await active.check();
      assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
      await assert.rejects(restored.checkStopped());
      const readyFile = path.join(f.control, 'recovery-lock', 'activation-ready.json');
      const readyBytes = await readFile(readyFile);
      const ready = JSON.parse(readyBytes);
      assert.equal(ready.phase, 'ready-to-commit');
      assert.equal(ready.backupId, 'live-restore');
      assert.deepEqual(ready.runtime, active.identity);
      assert.equal(ready.port, f.port);
      assert.deepEqual(ready.providers, ['credentials']);
      assert.deepEqual(ready.lock, f.lock);
      await rename(readyFile, `${readyFile}.old`);
      await writeFile(readyFile, readyBytes, { mode: 0o600 });
      await assert.rejects(active.check(), /evidence|authority|receipt|changed|replaced/i);
    } else {
      await assert.rejects(activateLinuxColdRestore({ restored, port: f.port, waitSeconds: 10, timeoutSeconds: 90 }),
        /providers do not match/i);
      assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
      const journal = (await readFile(path.join(f.control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(journal.at(-1).phase, 'activation-stopped');
      await assert.rejects(readFile(path.join(f.control, 'recovery-lock', 'activation-ready.json')), { code: 'ENOENT' });
    }
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), originalState);
    assert.deepEqual(await readFile(path.join(f.control, 'lock', 'owner.json')), originalLock);
    const intent = JSON.parse(await readFile(path.join(f.control, 'recovery-lock', 'activation-intent.json'), 'utf8'));
    assert.equal(intent.state.operation, 'restore');
    assert.equal(intent.state.phase, 'restore-activating');
    assert.equal(intent.state.backupId, 'live-restore');
  });
}

test('cold activation refuses post-copy configuration drift before uninhibiting', async t => {
  const f = await candidate(t);
  await f.kill();
  const restored = await restoreLinuxColdFiles({ ...f, acceptDataLoss: true, timeoutSeconds: 90 });
  t.after(() => restored.close());
  await writeFile(path.join(f.project, '.env'), 'IGNORED_SETTING=changed\n');
  await assert.rejects(activateLinuxColdRestore({ restored, port: f.port, waitSeconds: 10, timeoutSeconds: 90 }),
    /configuration|snapshot/i);
  assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
  await assert.rejects(readFile(path.join(f.control, 'service-activation.ndjson')), { code: 'ENOENT' });
});

test('cold activation readiness survives controller death but never substitutes for fresh owned admission', async t => {
  const f = await candidate(t);
  await f.kill();
  const child = fork(new URL('./deployment-cold-activation-child.mjs', import.meta.url),
    [f.control, f.project, f.backup, String(f.port)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Cold activation did not pause: ${diagnostic}`)), 90000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Cold activation exited ${code}: ${diagnostic}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const options = { ...f, waitSeconds: 10, timeoutSeconds: 90 };
  await assert.rejects(inspectLinuxColdActivation(options), /admission|locking|alive/i);
  child.kill('SIGKILL');
  await exited;
  const paths = ['state.json', 'lock/owner.json', 'recovery-lock/owner.json',
    'recovery-lock/activation-intent.json', 'recovery-lock/activation-ready.json',
    'service-stop.ndjson', 'service-activation.ndjson'];
  const evidence = await Promise.all(paths.map(file => readFile(path.join(f.control, file))));
  const admitted = await inspectLinuxColdActivation(options);
  t.after(() => admitted.close());
  assert.equal(admitted.status, 'ready-to-commit');
  assert.deepEqual(admitted.identity, ready.identity);
  await admitted.check();
  await assert.rejects(inspectLinuxColdActivation(options), /admission|locking/i);
  assert.deepEqual(await Promise.all(paths.map(file => readFile(path.join(f.control, file)))), evidence);
  await admitted.close();
  const readyPath = path.join(f.control, 'recovery-lock/activation-ready.json');
  const receipt = JSON.parse(evidence[4]);
  await writeFile(readyPath, JSON.stringify({ ...receipt, activationSha256: '0'.repeat(64) }));
  await assert.rejects(inspectLinuxColdActivation(options), /receipt|intent|evidence/i);
  await writeFile(readyPath, evidence[4]);
  await assert.rejects(readFile(path.join(f.project, '.env')), { code: 'ENOENT' });
  await writeFile(path.join(f.project, '.env'), 'IGNORED_SETTING=drift\n');
  await assert.rejects(inspectLinuxColdActivation(options), /configuration|snapshot/i);
  await unlink(path.join(f.project, '.env'));
  const reentered = await inspectLinuxColdActivation(options);
  t.after(() => reentered.close());
  await systemctl('restart', f.unit);
  await assert.rejects(reentered.check(), /generation|runtime|identity|changed/i);
  await reentered.close();
  await assert.rejects(inspectLinuxColdActivation(options), /generation|runtime|identity|changed/i);
  assert.deepEqual(await Promise.all(paths.map(file => readFile(path.join(f.control, file)))), evidence);
});
