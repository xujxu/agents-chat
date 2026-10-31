import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { freshSourceInstallationFixture, removeFirstSourceUnit } from './deployment-linux-first-source-fixture.mjs';
import { loadState, releaseLock } from '../scripts/deployment/state.mjs';
import { linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';

const execute = promisify(execFile);

test('failed public first installation retains evidence and refuses retry or fictitious restoration', {
  skip: process.env.DEPLOYMENT_TEST_REAL_FIRST_FAILURE !== '1',
}, async t => {
  const uid = Number((await execute('/usr/bin/id', ['-u', 'agents-chat-test'])).stdout.trim());
  const gid = Number((await execute('/usr/bin/id', ['-g', 'agents-chat-test'])).stdout.trim());
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  const f = await freshSourceInstallationFixture(t, { unit: 'agents-chat.service', uid, gid });
  const invoke = async (operation, flags) => execute('/usr/bin/bash', [
    path.join(f.project, `scripts/${operation}.sh`), '--project-dir', f.project, '--json', ...flags,
  ], { cwd: '/', timeout: 180000, maxBuffer: 16384,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: '/root', NODE_ENV: 'development' } });
  try {
    await releaseLock(f.control, f.lock);
    await rmdir(f.control);
    const dotenv = path.join(f.project, '.env.local');
    await writeFile(dotenv, `${await readFile(dotenv, 'utf8')}npm_config_cache=${path.join(f.home, '.npm')}\nnpm_config_offline=true\n`);
    await assert.rejects(invoke('deploy', ['--no-pull', '--timeout', '120']), error => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, 'failed');
      assert.equal(result.backupCreated, false);
      assert.match(result.message, /no previous backup/i);
      assert.match(error.stderr, /Deployment phase: dependencies/);
      assert.doesNotMatch(error.stderr, /Deployment phase: (building|configuring|activating|accepted)/);
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, /fresh-build-private-(secret|password)/);
      assert.match(result.nextActions.status, /--status --json$/);
      return true;
    });
    const state = await loadState(f.control);
    assert.equal(state.phase, 'recovery-required');
    assert.equal(state.priorRuntime, 'absent');
    assert.equal(state.backupId, null);
    for (const file of [
      path.join(f.control, 'backup'), path.join(f.control, 'deployment.json'),
      path.join(f.control, 'service-install.ndjson'), path.join(f.project, '.data'),
      path.join(f.project, '.next'),
    ]) await assert.rejects(lstat(file), { code: 'ENOENT' });
    assert.equal((await linuxSystemdProperties(f.installation.identity.unit, ['LoadState'],
      { allowMissing: true })).LoadState, 'not-found');
    const before = (await readdir(f.control)).sort();
    const lock = await readFile(path.join(f.control, 'lock/owner.json'));
    assert.ok(before.includes('recovery-engine'));
    const status = JSON.parse((await invoke('deploy', ['--status'])).stdout);
    assert.equal(status.status, 'interrupted');
    assert.equal(status.phase, 'recovery-required');
    assert.equal(status.operationId, state.operationId);
    await assert.rejects(invoke('deploy', ['--no-pull']), error => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).code, 'DEPLOYMENT_RECOVERY_REQUIRED');
      return true;
    });
    await assert.rejects(invoke('restore', ['--accept-data-loss']), error => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.code, 'DEPLOYMENT_BACKUP_MISSING');
      assert.equal(result.backupAvailable, false);
      assert.match(result.message, /no retained backup/i);
      assert.doesNotMatch(error.stderr, /Restoring retained backup/);
      return true;
    });
    assert.deepEqual(await loadState(f.control), state);
    assert.deepEqual(await readFile(path.join(f.control, 'lock/owner.json')), lock);
    assert.deepEqual((await readdir(f.control)).sort(), before);
  } finally {
    await removeFirstSourceUnit(f);
  }
});
