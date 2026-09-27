import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import fs, { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporaryDeployment, acceptOperation } from './deployment-fixture.mjs';
import { acquireLock, releaseLock } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

const source = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
const unsafe = error => error.recoveryAllowed === false;

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'control');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
  const operation = await createWorkerOperation({ control, lock, saved });
  t.after(() => operation.close());
  return { project, control, lock, saved, operation };
}

test('retirement requires both sealed workers and matching application acceptance', async t => {
  for (const mode of ['unsealed', 'unaccepted', 'closed']) {
    const f = await fixture(t);
    if (mode !== 'unsealed') await f.operation.seal();
    if (mode !== 'unaccepted') await acceptOperation(f.control, f.lock);
    if (mode === 'closed') await f.operation.close();
    await assert.rejects(f.operation.retire(), unsafe);
    assert.ok((await readdir(f.control)).includes('worker-engine'));
    await assert.rejects(releaseLock(f.control, f.lock), /worker|evidence/);
  }
});

test('accepted or restored live operation retires only worker artifacts and permits next fixed slot', async t => {
  for (const phase of ['deploy', 'restore']) {
    const f = await fixture(t);
    await mkdir(path.join(f.control, 'backup'));
    await writeFile(path.join(f.control, 'backup', 'sentinel'), 'retained full backup');
    await f.operation.seal();
    await acceptOperation(f.control, f.lock, phase);
    const state = await readFile(path.join(f.control, 'state.json'));
    await f.operation.retire();
    assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'lock', 'state.json']);
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained full backup');
    await assert.rejects(f.operation.retire(), unsafe);
    await releaseLock(f.control, f.lock);
    const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
    await saveWorkerEngine({ source, control: f.control, project: f.project, operationId: lock.operationId });
    assert.ok((await readdir(f.control)).includes('worker-engine'));
  }
});

test('retirement intent alone prevents lock release after partial deletion', async t => {
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: randomUUID() });
  await writeFile(path.join(root, 'worker-retirement.json'), '{"partial":');
  await assert.rejects(releaseLock(root, lock), /worker|evidence/);
});

test('accepted worker cleanup cannot discard service maintenance authority', async t => {
  const f = await fixture(t);
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  await writeFile(path.join(f.control, 'service-stop.ndjson'), '{"partial":');
  const before = (await readdir(f.saved.directory)).sort();
  await assert.rejects(f.operation.retire(), unsafe);
  assert.deepEqual((await readdir(f.saved.directory)).sort(), before);
  await assert.rejects(releaseLock(f.control, f.lock), /service/i);
});

test('unexpected helper file is retained rather than recursively removed', async t => {
  const f = await fixture(t);
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  await writeFile(path.join(f.saved.directory, 'foreign'), 'not owned');
  await assert.rejects(f.operation.retire(), unsafe);
  assert.equal(await readFile(path.join(f.saved.directory, 'foreign'), 'utf8'), 'not owned');
  await assert.rejects(releaseLock(f.control, f.lock), /worker|evidence/);
});

test('failed retirement intent flush removes no helper or operation evidence', async t => {
  const f = await fixture(t);
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  const before = (await readdir(f.saved.directory)).sort();
  const probe = await open(path.join(f.control, 'worker-operation.ndjson'), 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  t.mock.method(prototype, 'sync', async () => { throw new Error('injected retirement intent flush failure'); });
  try { await assert.rejects(f.operation.retire(), unsafe); }
  finally { t.mock.restoreAll(); }
  assert.deepEqual((await readdir(f.saved.directory)).sort(), before);
  assert.ok((await readFile(path.join(f.control, 'worker-operation.ndjson'), 'utf8')).includes('"sealed"'));
  assert.ok((await readdir(f.control)).includes('worker-retirement.json'));
  await assert.rejects(f.operation.retire(), unsafe);
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
});

test('partial exact-file deletion retains durable inventory and refuses retry or unlock', async t => {
  const f = await fixture(t);
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  const unlink = fs.unlink;
  let removed = 0;
  t.mock.method(fs, 'unlink', async file => {
    if (path.dirname(file) === f.saved.directory && ++removed === 3) {
      throw Object.assign(new Error('injected helper deletion denied'), { code: 'EACCES' });
    }
    return unlink(file);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.operation.retire(), unsafe); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(removed, 3);
  const intent = JSON.parse(await readFile(path.join(f.control, 'worker-retirement.json'), 'utf8'));
  assert.equal(intent.lock.token, f.lock.token);
  assert.equal(intent.manifestSha256, f.saved.manifestSha256);
  const helpers = intent.files.filter(file => path.dirname(file.path) === 'worker-engine');
  assert.equal((await readdir(f.saved.directory)).length, helpers.length - 2);
  await assert.rejects(f.operation.retire(), unsafe);
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
  await assert.rejects(acquireLock(f.control, { project: f.project, operationId: randomUUID() }), /lock/);
});

test('unexpected file appearing during deletion stops without deleting the foreign file', async t => {
  const f = await fixture(t);
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  const unlink = fs.unlink;
  let injected = false;
  t.mock.method(fs, 'unlink', async file => {
    await unlink(file);
    if (!injected && path.dirname(file) === f.saved.directory) {
      injected = true;
      await writeFile(path.join(f.saved.directory, 'foreign-file'), 'unrelated');
    }
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.operation.retire(), unsafe); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(await readFile(path.join(f.saved.directory, 'foreign-file'), 'utf8'), 'unrelated');
  assert.ok((await readdir(f.control)).includes('worker-retirement.json'));
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
});

test('final marker deletion failure keeps the only remaining worker artifact as an unlock barrier', async t => {
  const f = await fixture(t);
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  const unlink = fs.unlink;
  t.mock.method(fs, 'unlink', async file => {
    if (path.basename(file) === 'worker-retirement.json') throw new Error('injected marker delete failure');
    return unlink(file);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.operation.retire(), unsafe); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual((await readdir(f.control)).sort(), ['lock', 'state.json', 'worker-retirement.json']);
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
});

test('actual controller death during deletion retains precise intent and does not grant another lock', {
  timeout: 60000,
}, async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'ctl');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const child = fork(new URL('./deployment-retirement-child.mjs', import.meta.url),
    [control, project, source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const { lock, saved } = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Retirement fixture exited ${code}: ${stderr}`)));
  });
  child.kill('SIGKILL');
  await exited;
  const marker = await readFile(path.join(control, 'worker-retirement.json'));
  const inventory = JSON.parse(marker).files.filter(file => path.dirname(file.path) === 'worker-engine');
  assert.equal((await readdir(saved.directory)).length, inventory.length - 1);
  assert.equal(JSON.parse(await readFile(path.join(control, 'state.json'))).phase, 'accepted');
  await assert.rejects(acquireLock(control, { project, operationId: randomUUID() }), /lock/);
  await assert.rejects(releaseLock(control, lock), /owner/);
  assert.deepEqual(await readFile(path.join(control, 'worker-retirement.json')), marker);
});

test('acceptance changing while the retirement snapshot is captured cannot authorize deletion', async t => {
  const f = await fixture(t);
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  const statePath = path.join(f.control, 'state.json');
  const accepted = JSON.parse(await readFile(statePath, 'utf8'));
  const originalOpen = fs.open;
  let changed = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (!changed && file === statePath) {
      changed = true;
      await writeFile(statePath, `${JSON.stringify({ ...accepted, phase: 'activation-unverified' })}\n`);
    }
    return originalOpen(file, ...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.operation.retire(), unsafe); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(changed, true);
  assert.ok((await readdir(f.control)).includes('worker-engine'));
  assert.ok((await readdir(f.control)).includes('worker-operation.ndjson'));
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
});
