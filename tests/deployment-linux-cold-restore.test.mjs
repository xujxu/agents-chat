import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { cp, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { restoreCandidate } from './deployment-linux-restore-fixture.mjs';
import { interrupted } from './deployment-linux-service-recovery-fixture.mjs';
import { acquireLock, loadState, releaseLock } from '../scripts/deployment/state.mjs';
import { admitLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-admission.mjs';
import { claimLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-lease.mjs';
import { restoreLinuxColdFiles } from '../scripts/deployment/linux-cold-restore-files.mjs';
import { systemctl } from './deployment-linux-service-fixture.mjs';
import { activateLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-activation.mjs';
import { inspectLinuxColdActivation } from '../scripts/deployment/linux-cold-activation-recovery.mjs';
import { completeLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-completion.mjs';

async function candidate(t, phase = 'stopped', valid = true, options) {
  const f = await restoreCandidate(t, valid, options);
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
  assert.deepEqual(admitted.providers, ['admin-login']);
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

for (const pause of ['project-removal', 'git-index']) {
test(`cold file restoration resumes after controller death during ${pause} without unlocking or starting the service`, async t => {
  const f = await candidate(t, 'stopped', true, { gitSource: true });
  await f.kill();
  const originalLock = await readFile(path.join(f.control, 'lock', 'owner.json'));
  const originalState = await readFile(path.join(f.control, 'state.json'));
  const child = fork(new URL('./deployment-cold-files-child.mjs', import.meta.url),
    [f.control, f.project, f.backup, pause], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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
  if (pause === 'project-removal') await assert.rejects(readFile(path.join(f.project, 'saved-data')), { code: 'ENOENT' });
  else {
    assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
    await readFile(path.join(f.project, '.git', 'agents-chat-restore', 'intent.json'));
  }
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
  assert.equal(await f.git('rev-parse', 'HEAD'), f.savedCommit);
  assert.deepEqual(await readFile(path.join(f.project, '.git', 'index')), f.savedIndex);
  assert.equal(await readFile(path.join(f.project, 'source.txt'), 'utf8'), 'saved source\n');
});
}

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
      assert.deepEqual(ready.providers, ['admin-login']);
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

test('cold restore terminal completion preserves the owned runtime and backup while releasing recovery evidence', async t => {
  const f = await candidate(t);
  await f.kill();
  const backup = await readFile(path.join(f.backup, 'manifest.json'));
  const restored = await restoreLinuxColdFiles({ ...f, acceptDataLoss: true, timeoutSeconds: 90 });
  t.after(() => restored.close());
  const active = await activateLinuxColdRestore({ restored, port: f.port, waitSeconds: 10, timeoutSeconds: 90 });
  t.after(() => active.close());
  const result = await completeLinuxColdRestore({ ...f, restored, active, waitSeconds: 10, timeoutSeconds: 90 });
  assert.equal(result.status, 'restored');
  assert.equal(result.backupId, 'live-restore');
  const state = await loadState(f.control);
  assert.equal(state.phase, 'restored');
  assert.equal(state.operation, 'restore');
  assert.equal(state.backupId, 'live-restore');
  assert.equal(state.targetCommit, 'a'.repeat(40));
  assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(),
    active.identity.runtime.invocationId);
  for (const name of ['lock', 'recovery-lock', 'service-stop.ndjson', 'service-activation.ndjson',
    'service-cold-retirement.json', '.cold-restore-state.json']) {
    await assert.rejects(lstat(path.join(f.control, name)), { code: 'ENOENT' });
  }
  await assert.rejects(lstat(`/etc/systemd/system/${f.unit}.d/90-agents-chat-deployment.conf.${f.lock.token}.held`),
    { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(f.backup, 'manifest.json')), backup);
  assert.deepEqual(await completeLinuxColdRestore({ ...f, waitSeconds: 10, timeoutSeconds: 90 }), result);
  const completionPath = path.join(f.control, 'cold-restore-complete.json');
  const completion = await readFile(completionPath);
  const proof = JSON.parse(completion);
  await writeFile(completionPath, JSON.stringify({ ...proof, state: { ...proof.state, backupId: 'foreign-backup' } }));
  await assert.rejects(acquireLock(f.control, { project: f.project, operationId: 'refuse-corrupt-receipt' }),
    /proof|restoration/i);
  await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
  await writeFile(completionPath, completion);
  const next = await acquireLock(f.control, { project: f.project, operationId: 'next-after-cold-restore' });
  await assert.rejects(lstat(path.join(f.control, 'cold-restore-complete.json')), { code: 'ENOENT' });
  assert.equal((await loadState(f.control)).phase, 'restored');
  await releaseLock(f.control, next);
});

for (const phase of ['state-published', 'lock-owner-removed', 'guard-removed']) {
  test(`cold terminal cleanup resumes after controller death at ${phase} without restarting or losing the backup`, async t => {
    const f = await candidate(t);
    await f.kill();
    const child = fork(new URL('./deployment-cold-completion-child.mjs', import.meta.url),
      [f.control, f.project, f.backup, String(f.port), phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    const paused = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Cold completion did not pause: ${diagnostic}`)), 90000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Cold completion exited ${code}: ${diagnostic}`)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await assert.rejects(completeLinuxColdRestore({ ...f, waitSeconds: 10, timeoutSeconds: 90 }), /admission|locking|alive/i);
    child.kill('SIGKILL');
    await exited;
    if (phase === 'state-published') {
      const ownerPath = path.join(f.control, 'lock/owner.json');
      const bytes = await readFile(ownerPath);
      await rename(ownerPath, `${ownerPath}.retained`);
      await writeFile(ownerPath, bytes, { mode: 0o600 });
      await assert.rejects(completeLinuxColdRestore({ ...f, waitSeconds: 10, timeoutSeconds: 90 }), /identity|changed|inventory/i);
      await unlink(ownerPath);
      await rename(`${ownerPath}.retained`, ownerPath);
    }

    const result = await completeLinuxColdRestore({ ...f, waitSeconds: 10, timeoutSeconds: 90 });
    assert.equal(result.status, 'restored');
    assert.equal((await loadState(f.control)).phase, 'restored');
    assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(),
      paused.identity.runtime.invocationId);
    assert.equal(await readFile(path.join(f.backup, 'files/saved-data'), 'utf8'), 'backup data');
    for (const name of ['lock', 'recovery-lock', 'service-cold-retirement.json']) {
      await assert.rejects(lstat(path.join(f.control, name)), { code: 'ENOENT' });
    }
    assert.deepEqual(await completeLinuxColdRestore({ ...f, waitSeconds: 10, timeoutSeconds: 90 }), result);
  });
}

test('saved restore entry completes dead-controller cold restoration without checkout helpers', async t => {
  const f = await candidate(t, 'stopped', true, { gitSource: true });
  await f.kill();
  await rename(path.join(f.project, 'scripts'), path.join(f.project, 'unavailable-scripts'));
  const oldLock = await readFile(path.join(f.control, 'lock/owner.json'));
  const input = {
    project: f.project, unit: f.unit, npm: f.npm, node: f.node, backup: f.backup,
    port: f.port, waitSeconds: 10, timeoutSeconds: 90,
  };
  const execute = acknowledge => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [
      path.join(f.saved.directory, 'linux-restore-entry.mjs'), f.control, f.saved.manifestSha256,
      ...(acknowledge ? ['--accept-data-loss'] : []),
    ], { cwd: '/', timeout: 120000, maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C' } }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(JSON.stringify(input));
  });
  assert.equal((await execute(false)).code, 1);
  assert.deepEqual(await readFile(path.join(f.control, 'lock/owner.json')), oldLock);
  input.unit = 'unrelated-cold-restore.service';
  assert.equal((await execute(true)).code, 1);
  assert.deepEqual(await readFile(path.join(f.control, 'lock/owner.json')), oldLock);
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
  input.unit = f.unit;
  input.node = '/unrelated/node';
  assert.equal((await execute(true)).code, 1);
  assert.deepEqual(await readFile(path.join(f.control, 'lock/owner.json')), oldLock);
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
  input.node = f.node;
  const result = await execute(true);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'restored');
  assert.equal(JSON.parse(result.stdout).backupId, 'live-restore');
  assert.equal((await loadState(f.control)).phase, 'restored');
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'backup data');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.savedCommit);
  assert.deepEqual(await readFile(path.join(f.project, '.git/index')), f.savedIndex);
  await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(f.control, 'recovery-lock')), { code: 'ENOENT' });
  assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
  const invocation = (await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim();
  const repeated = await execute(true);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), JSON.parse(result.stdout));
  assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(), invocation);
  await cp(fileURLToPath(new URL('../scripts/deployment/', import.meta.url)),
    path.join(f.project, 'scripts', 'deployment'), { recursive: true });
  const second = await interrupted(t, 'stopped', 'accepted', 'none', f);
  await second.kill();
  await assert.rejects(lstat(path.join(f.control, 'cold-restore-complete.json')), { code: 'ENOENT' });
  await writeFile(path.join(f.project, 'saved-data'), 'second failed update data');
  const restoredAgain = await execute(true);
  assert.equal(restoredAgain.code, 0, restoredAgain.stderr);
  assert.equal(JSON.parse(restoredAgain.stdout).operationId, second.lock.operationId);
  assert.notEqual(JSON.parse(restoredAgain.stdout).operationId, JSON.parse(result.stdout).operationId);
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'backup data');
  assert.equal((await loadState(f.control)).phase, 'restored');
  await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
});
