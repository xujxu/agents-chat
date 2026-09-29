import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, ready } from './deployment-linux-service-fixture.mjs';
import { acquireLock, loadState, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from '../scripts/deployment/linux-configuration.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';
import { createLinuxServiceSnapshot } from '../scripts/deployment/linux-snapshot.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function restoreCandidate(t, valid = true, { gitSource = false } = {}) {
  const server = port => `
const fs=require('node:fs');
const server=require('node:http').createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(${valid ? `{'admin-login':{id:'admin-login',name:'Admin',type:'credentials',
    signinUrl:'http://localhost/api/auth/signin/admin-login',callbackUrl:'http://localhost/api/auth/callback/admin-login'}}` : '{}'}));
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
  const configuration = await inspectLinuxConfiguration({ service, profile: 'agents-chat-auth-638c553' });
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
  const git = async (...args) => (await execute('git', ['-c', `safe.directory=${f.project}`, '-C', f.project, ...args],
    { timeout: 20000, maxBuffer: 16384 })).stdout.trim();
  let savedCommit = 'a'.repeat(40);
  let savedIndex;
  if (gitSource) {
    await git('init', '--initial-branch=main');
    await git('config', 'user.name', 'Deployment fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(path.join(f.project, 'source.txt'), 'saved source\n');
    await git('add', 'source.txt', 'server.cjs', 'package.json');
    await git('commit', '-m', 'saved source');
    savedCommit = await git('rev-parse', 'HEAD');
    savedIndex = await readFile(path.join(f.project, '.git/index'));
  }
  const backup = path.join(control, 'backup');
  await createLinuxServiceSnapshot({
    service, stopped, configuration, destination: backup, id: 'live-restore',
    source: { commit: savedCommit, provenance: 'observed' },
  });
  await stopped.activate({ purpose: 'prior-runtime' });
  await writeState(control, { ...await loadState(control), phase: 'prior-runtime-restored',
    previousPhase: 'copying', errorCode: 'FIXTURE_CAPTURE' });
  await stopped.retire();
  await releaseLock(control, lock);
  await writeFile(path.join(f.project, 'saved-data'), 'new data');
  if (gitSource) {
    await writeFile(path.join(f.project, 'source.txt'), 'updated source\n');
    await git('commit', '-am', 'updated source');
  }
  const current = await inspectLinuxService(f);
  t.after(() => current.close());
  const config = await inspectLinuxConfiguration({ service: current, profile: 'agents-chat-auth-638c553' });
  const owner = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  return { ...f, service: current, configuration: config, control, lock: owner, backup, port, git, savedCommit, savedIndex };
}
