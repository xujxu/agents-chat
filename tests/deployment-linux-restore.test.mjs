import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture, ready, systemctl } from './deployment-linux-service-fixture.mjs';
import { acquireLock, loadState, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from '../scripts/deployment/linux-configuration.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';
import { createLinuxServiceSnapshot } from '../scripts/deployment/linux-snapshot.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { runLinuxLiveRestore } from '../scripts/deployment/linux-restore.mjs';
import { saveRecoveryEngine, verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';

const profile = 'agents-chat-auth-638c553';
async function candidate(t, valid = true) {
  const server = port => `
const fs=require('node:fs');
const server=require('node:http').createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(${valid ? `{credentials:{id:'credentials',name:'Credentials',type:'credentials',
    signinUrl:'http://localhost/api/auth/signin/credentials',callbackUrl:'http://localhost/api/auth/callback/credentials'}}` : '{}'}));
});
server.listen(${port},'127.0.0.1',()=>{
  fs.writeFileSync('port',String(server.address().port));fs.writeFileSync('ready',String(process.pid));
});`;
  const f = await fixture(t, { nonroot: true, server: server(0), settings: `Environment=NODE_ENV=production
Environment=NEXTAUTH_SECRET=fixture-private-secret
Environment=NEXTAUTH_URL=http://localhost:3010
Environment=ADMIN_USERNAME=fixture
Environment=ADMIN_PASSWORD=fixture-private-password` });
  await ready(f);
  const port = Number(await readFile(path.join(f.project, 'port'), 'utf8'));
  await writeFile(path.join(f.project, 'server.cjs'), server(port));
  const service = await inspectLinuxService(f);
  t.after(() => service.close());
  const configuration = await inspectLinuxConfiguration({ service, profile });
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  const state = {
    version: 1, operationId: lock.operationId, project: f.project, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
    backupId: null, priorRuntime: 'running', runtimeIdentity: service.identity.runtime.invocationId,
    startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
  };
  await writeState(control, state);
  await writeState(control, { ...state, phase: 'stopped', previousPhase: 'preflight' });
  const stopped = await stopLinuxService({ ...f, control, lock });
  t.after(() => stopped.close());
  await writeState(control, { ...state, phase: 'copying', previousPhase: 'stopped' });
  await writeFile(path.join(f.project, 'saved-data'), 'backup data');
  const backup = path.join(control, 'backup');
  await createLinuxServiceSnapshot({
    service, stopped, configuration, destination: backup, id: 'live-restore',
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
  });
  await stopped.activate({ purpose: 'prior-runtime' });
  await writeState(control, { ...await loadState(control), phase: 'prior-runtime-restored',
    previousPhase: 'copying', errorCode: 'FIXTURE_CAPTURE' });
  await stopped.retire();
  await releaseLock(control, lock);
  await writeFile(path.join(f.project, 'saved-data'), 'new data');
  const current = await inspectLinuxService(f);
  t.after(() => current.close());
  const config = await inspectLinuxConfiguration({ service: current, profile });
  const owner = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  return { ...f, service: current, configuration: config, control, lock: owner, backup, port };
}

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
