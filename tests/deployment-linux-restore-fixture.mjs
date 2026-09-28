import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, ready } from './deployment-linux-service-fixture.mjs';
import { acquireLock, loadState, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from '../scripts/deployment/linux-configuration.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';
import { createLinuxServiceSnapshot } from '../scripts/deployment/linux-snapshot.mjs';

export async function restoreCandidate(t, valid = true) {
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
  const config = await inspectLinuxConfiguration({ service: current, profile: 'agents-chat-auth-638c553' });
  const owner = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  return { ...f, service: current, configuration: config, control, lock: owner, backup, port };
}
