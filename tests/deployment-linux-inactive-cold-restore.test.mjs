import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { coldRestoreCandidate, invokeSavedRestore } from './deployment-linux-restore-fixture.mjs';
import { admitLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-admission.mjs';
import { restoreLinuxColdFiles } from '../scripts/deployment/linux-cold-restore-files.mjs';
import { activateLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-activation.mjs';
import { completeLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-completion.mjs';
import { inspectLinuxColdActivation } from '../scripts/deployment/linux-cold-activation-recovery.mjs';
import { loadState } from '../scripts/deployment/state.mjs';
import { linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';

const native = { skip: process.platform !== 'linux' || process.getuid() !== 0 };

for (const runtimeState of ['inactive', 'failed']) {
  test(`dead-controller restoration preserves originally ${runtimeState} history through versioned activation`, native, async t => {
    const f = await coldRestoreCandidate(t, 'stopped', true, { runtimeState });
    const lock = await readFile(path.join(f.control, 'lock/owner.json'));
    const original = await loadState(f.control);
    const backup = await readFile(path.join(f.backup, 'manifest.json'));
    assert.equal(original.priorRuntime, 'stopped');
    assert.match(original.runtimeIdentity, /^stopped:[a-f0-9]{64}$/);
    await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }), /alive|owner/i);
    await f.kill();
    const statePath = path.join(f.control, 'state.json');
    const stateBytes = await readFile(statePath);
    await writeFile(statePath, JSON.stringify({ ...original, runtimeIdentity: `stopped:${'0'.repeat(64)}` }));
    await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }), /identity|original|stop|state/i);
    await writeFile(statePath, stateBytes);
    await assert.rejects(lstat(path.join(f.control, 'recovery-lock')), { code: 'ENOENT' });
    const admitted = await admitLinuxColdRestore({ ...f, acceptDataLoss: true });
    try {
      assert.equal(admitted.service.identity.runtime.mainPid, 0);
      assert.deepEqual(admitted.providers, ['admin-login']);
      await admitted.check();
      assert.deepEqual(await readFile(path.join(f.control, 'lock/owner.json')), lock);
      assert.deepEqual(await loadState(f.control), original);
      assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
    } finally { await admitted.close(); }
    const restored = await restoreLinuxColdFiles({ ...f, acceptDataLoss: true, timeoutSeconds: 90 });
    t.after(() => restored.close());
    const active = await activateLinuxColdRestore({ restored, port: f.port, waitSeconds: 10, timeoutSeconds: 90 });
    t.after(() => active.close());
    const intent = JSON.parse(await readFile(path.join(f.control, 'recovery-lock/activation-intent.json'), 'utf8'));
    assert.equal(intent.version, 2);
    assert.equal(intent.state.priorRuntime, 'stopped');
    assert.equal(intent.state.runtimeIdentity, original.runtimeIdentity);
    assert.ok(active.identity.runtime.mainPid > 0);
    const result = await completeLinuxColdRestore({ ...f, restored, active, waitSeconds: 10, timeoutSeconds: 90 });
    assert.equal(result.status, 'restored');
    const final = await loadState(f.control);
    assert.equal(final.priorRuntime, 'stopped');
    assert.equal(final.runtimeIdentity, original.runtimeIdentity);
    assert.equal(final.phase, 'restored');
    assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'backup data');
    assert.deepEqual(await readFile(path.join(f.backup, 'manifest.json')), backup);
    await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(f.control, 'recovery-lock')), { code: 'ENOENT' });
    assert.deepEqual(await completeLinuxColdRestore({ ...f, waitSeconds: 10, timeoutSeconds: 90 }), result);
  });
}

test('failed-service cold readiness survives restorer death without rewriting stopped history', native, async t => {
  const f = await coldRestoreCandidate(t, 'stopped', true, { runtimeState: 'failed' });
  const original = await loadState(f.control);
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
  const intentPath = path.join(f.control, 'recovery-lock/activation-intent.json');
  const intentBytes = await readFile(intentPath);
  const intent = JSON.parse(intentBytes);
  assert.equal(intent.version, 2);
  assert.equal(intent.state.runtimeIdentity, original.runtimeIdentity);
  for (const changed of [
    { ...intent, version: 1 },
    { ...intent, state: { ...intent.state, priorRuntime: 'running' } },
    { ...intent, state: { ...intent.state, runtimeIdentity: `stopped:${'0'.repeat(64)}` } },
  ]) {
    await writeFile(intentPath, JSON.stringify(changed));
    await assert.rejects(inspectLinuxColdActivation(options), /activation|intent|identity/i);
    await writeFile(intentPath, intentBytes);
    assert.deepEqual(await loadState(f.control), original);
  }
  const admitted = await inspectLinuxColdActivation(options);
  try {
    assert.equal(admitted.status, 'ready-to-commit');
    assert.deepEqual(admitted.identity, ready.identity);
    await admitted.check();
  } finally { await admitted.close(); }
  assert.equal((await completeLinuxColdRestore(options)).status, 'restored');
  const final = await loadState(f.control);
  assert.equal(final.priorRuntime, 'stopped');
  assert.equal(final.runtimeIdentity, original.runtimeIdentity);
  assert.equal((await linuxSystemdProperties(f.unit, ['InvocationID'])).InvocationID, ready.identity.runtime.invocationId);
});

test('saved cold entry restores an initially stopped source checkout without installed helpers', native, async t => {
  const f = await coldRestoreCandidate(t, 'stopped', true, { runtimeState: 'inactive', gitSource: true });
  await f.kill();
  await rename(path.join(f.project, 'scripts'), path.join(f.project, 'unavailable-scripts'));
  const original = await loadState(f.control);
  const input = { project: f.project, unit: f.unit, npm: f.npm, node: f.node, backup: f.backup,
    port: f.port, waitSeconds: 10, timeoutSeconds: 90 };
  const refused = await invokeSavedRestore(f, input, false);
  assert.equal(refused.code, 1);
  assert.deepEqual(await loadState(f.control), original);
  const result = await invokeSavedRestore(f, input);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'restored');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.savedCommit);
  assert.deepEqual(await readFile(path.join(f.project, '.git/index')), f.savedIndex);
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'backup data');
  assert.equal((await loadState(f.control)).runtimeIdentity, original.runtimeIdentity);
  const before = await linuxSystemdProperties(f.unit, ['ActiveState', 'MainPID', 'InvocationID']);
  assert.equal(before.ActiveState, 'active');
  const repeated = await invokeSavedRestore(f, input);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), JSON.parse(result.stdout));
  assert.deepEqual(await linuxSystemdProperties(f.unit, ['ActiveState', 'MainPID', 'InvocationID']), before);
});
