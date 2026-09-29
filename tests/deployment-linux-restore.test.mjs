import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { systemctl } from './deployment-linux-service-fixture.mjs';
import { restoreCandidate as candidate } from './deployment-linux-restore-fixture.mjs';
import { loadState, releaseLock } from '../scripts/deployment/state.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { runLinuxLiveRestore } from '../scripts/deployment/linux-restore.mjs';
import { saveRecoveryEngine, verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';

test('composed native live restoration restores files, verifies owned HTTP readiness and unlocks only after acceptance', async t => {
  const f = await candidate(t);
  const result = await runLinuxLiveRestore({ ...f, acceptDataLoss: true, waitSeconds: 10 });
  assert.deepEqual(result, { status: 'restored', backupId: 'live-restore' });
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'backup data');
  assert.equal((await verifySnapshot(f.backup)).id, 'live-restore');
  assert.equal((await loadState(f.control)).phase, 'restored');
  await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
  assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
});

test('native source restoration restores matching worktree, branch HEAD and exact index from the backup', async t => {
  const f = await candidate(t, true, { gitSource: true });
  assert.notEqual(await f.git('rev-parse', 'HEAD'), f.savedCommit);
  const backup = await verifySnapshot(f.backup);
  assert.equal(backup.gitMetadata.version, 1);
  const result = await runLinuxLiveRestore({ ...f, acceptDataLoss: true, waitSeconds: 10 });
  assert.equal(result.status, 'restored');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.savedCommit);
  assert.equal(await f.git('symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.deepEqual(await readFile(path.join(f.project, '.git/index')), f.savedIndex);
  assert.equal(await readFile(path.join(f.project, 'source.txt'), 'utf8'), 'saved source\n');
  assert.equal(await f.git('diff', '--name-only', 'HEAD', '--', 'source.txt', 'server.cjs', 'package.json'), '');
  assert.equal((await loadState(f.control)).targetCommit, f.savedCommit);
});

test('composed native restore health refusal stops its activation and retains lock, evidence and backup', async t => {
  const f = await candidate(t, false);
  await assert.rejects(runLinuxLiveRestore({ ...f, acceptDataLoss: true, waitSeconds: 10 }), /providers do not match/i);
  const state = await loadState(f.control);
  assert.equal(state.phase, 'recovery-required');
  assert.equal(state.operation, 'restore');
  assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
  assert.equal((await lstat(path.join(f.control, 'lock'))).isDirectory(), true);
  const journal = (await readFile(path.join(f.control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).phase, 'activation-stopped');
  assert.equal((await verifySnapshot(f.backup)).id, 'live-restore');
});

test('saved Linux restore entry works without checkout helpers and refuses missing acknowledgement before downtime', async t => {
  const f = await candidate(t);
  await releaseLock(f.control, f.lock);
  const source = path.join(f.project, 'scripts', 'deployment');
  await cp(fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), source, { recursive: true });
  const saved = await saveRecoveryEngine({ source, control: f.control });
  await rename(path.join(f.project, 'scripts'), path.join(f.project, 'unavailable-scripts'));
  const input = {
    project: f.project, unit: f.unit, npm: f.npm, node: f.node, backup: f.backup,
    port: f.port, waitSeconds: 10, timeoutSeconds: 60,
  };
  const execute = acknowledge => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [
      path.join(saved.directory, 'linux-restore-entry.mjs'), f.control, saved.manifestSha256,
      ...(acknowledge ? ['--accept-data-loss'] : []),
    ], { cwd: '/', timeout: 90000, maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C' } }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(JSON.stringify(input));
  });
  const refused = await execute(false);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /acknowledgement|accept-data-loss/i);
  await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
  await f.service.check();
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
  const helper = path.join(saved.directory, 'linux-readiness.mjs');
  const bytes = await readFile(helper);
  await writeFile(helper, 'throw new Error("changed helper");\n');
  assert.equal((await execute(true)).code, 1);
  await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
  await f.service.check();
  await writeFile(helper, bytes);
  input.backup = path.join(f.control, 'missing-backup');
  const missing = await execute(true);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /stage=restore/);
  assert.match(missing.stderr, /code=ENOENT/);
  await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
  await f.service.check();
  input.backup = f.backup;
  const restored = await execute(true);
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(JSON.parse(restored.stdout), { status: 'restored', backupId: 'live-restore' });
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'backup data');
  assert.equal((await loadState(f.control)).phase, 'restored');
  await assert.rejects(lstat(path.join(f.control, 'lock')), { code: 'ENOENT' });
  assert.deepEqual(await verifyRecoveryEngine({ control: f.control, manifestSha256: saved.manifestSha256 }), saved);
});
