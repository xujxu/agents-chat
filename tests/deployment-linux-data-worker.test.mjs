import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, chown, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { databaseFixture, profile } from './deployment-database-fixture.mjs';
import { fixture, ready } from './deployment-linux-service-fixture.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { inspectLinuxData } from '../scripts/deployment/linux-data.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { runStage } from '../scripts/deployment/stage-runner.mjs';

async function owned(t) {
  const f = await fixture(t, { nonroot: true });
  await ready(f);
  const service = await inspectLinuxService(f);
  t.after(() => service.close());
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)),
    control, project: f.project, operationId: lock.operationId,
  });
  const operation = await createWorkerOperation({ control, lock, saved });
  t.after(() => operation.close());
  return { ...f, service, operation };
}

async function data(t, f) {
  const db = await databaseFixture(t);
  db.chats.exec("INSERT INTO chats(user_id,chat_id,name,ts) VALUES ('user','chat','retained',1)");
  db.chats.close();
  db.config.close();
  const directory = path.join(f.project, '.data');
  await cp(db.directory, directory, { recursive: true });
  await chown(directory, 65534, 65534);
  for (const name of await readdir(directory)) await chown(path.join(directory, name), 65534, 65534);
}

test('real SQLite inspection runs as the installed non-root account in a settled owned worker', async t => {
  const f = await owned(t);
  await data(t, f);
  const modules = path.join(f.project, 'node_modules');
  await mkdir(modules);
  async function readable(file) {
    const entries = await readdir(file, { withFileTypes: true });
    await chmod(file, 0o755);
    for (const entry of entries) {
      const child = path.join(file, entry.name);
      if (entry.isDirectory()) await readable(child);
      else if (entry.isFile()) await chmod(child, 0o644);
      else throw new Error('Unexpected installed binding fixture link.');
    }
  }
  for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
    const destination = path.join(modules, name);
    await cp(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)), destination, { recursive: true });
    await readable(destination);
  }
  const observed = await f.operation.run({
    workerId: randomUUID(), runtime: { uid: 65534, gid: 65534 },
    command: { file: process.execPath, cwd: f.project, env: {}, args: ['-e',
      'const D=require("better-sqlite3");const db=new D(":memory:");db.close();process.stdout.write(String(process.getuid()));'] },
  });
  assert.equal(observed.stdout, '65534');
  const result = await inspectLinuxData({ service: f.service, operation: f.operation, profile });
  assert.ok(result.databases.every(db => db.status === 'data-supported'));
  await f.operation.seal();
  assert.equal((await f.service.check()).populated, true);
});

test('blocked installed binding and descendant settle on cancellation without stopping the application', async t => {
  const f = await owned(t);
  await data(t, f);
  const binding = path.join(f.project, 'node_modules', 'better-sqlite3');
  await mkdir(binding, { recursive: true });
  await writeFile(path.join(binding, 'index.js'), `
    const fs = require('node:fs');
    const child = require('node:child_process').spawn(process.execPath, ['-e',
      'setInterval(()=>require("node:fs").appendFileSync("worker-writes","x"),10)'],
      {detached:true,stdio:'ignore'});
    fs.writeFileSync('binding-started', JSON.stringify({pid:process.pid,child:child.pid,uid:process.getuid()}));
    while(true) {}
  `);
  const abort = new AbortController();
  const reason = new Error('cancel native binding');
  const result = inspectLinuxData({ service: f.service, operation: f.operation, profile, signal: abort.signal });
  const rejected = assert.rejects(result, error => error === reason);
  let started;
  try {
    for (let i = 0; i < 600; i++) {
      try { started = JSON.parse(await readFile(path.join(f.project, 'binding-started'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(25);
    }
    assert.ok(started, 'owned binding must start');
    assert.equal(started.uid, 65534);
  } finally { abort.abort(reason); await rejected; }
  await f.operation.seal();
  assert.equal(await processIdentity(started.pid), null);
  const journal = path.join(f.project, 'worker-writes');
  const bytes = async () => readFile(journal).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const before = await bytes();
  await delay(100);
  assert.deepEqual(await bytes(), before);
  assert.equal((await f.service.check()).populated, true);
});

test('stage deadline interrupts synchronous SQLite binding work and proves the original domain settled', async t => {
  const f = await owned(t);
  await data(t, f);
  const binding = path.join(f.project, 'node_modules', 'better-sqlite3');
  await mkdir(binding, { recursive: true });
  await writeFile(path.join(binding, 'index.js'), `
    require('node:fs').writeFileSync('deadline-binding', String(process.pid));
    while(true) {}
  `);
  await assert.rejects(runStage('data-admission', signal =>
    inspectLinuxData({ service: f.service, operation: f.operation, profile, signal }),
  { timeoutMs: 15000 }), { code: 'DEPLOYMENT_STAGE_TIMEOUT', recoveryAllowed: true });
  const pid = Number(await readFile(path.join(f.project, 'deadline-binding'), 'utf8'));
  assert.ok(pid > 0);
  assert.equal(await processIdentity(pid), null);
  await f.operation.seal();
  assert.equal((await f.service.check()).populated, true);
});
