import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { acquireLock, releaseLock } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation, readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

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
  const create = async (options = {}) => {
    const operation = await createWorkerOperation({ control, lock, saved, ...options });
    t.after(() => operation.close());
    return operation;
  };
  return { root, project, control, lock, saved, create };
}

test('operation persists exact lock and pinned helper digest before any enrollment', async t => {
  const f = await fixture(t);
  const operation = await f.create();
  const records = await readWorkerOperation(f.control);
  assert.deepEqual(records, [{
    version: 1, phase: 'opened', lock: f.lock,
    manifestSha256: f.saved.manifestSha256, workerId: null,
  }]);
  assert.ok(Object.isFrozen(records[0].lock));
  await assert.rejects(releaseLock(f.control, f.lock), /worker|evidence/i);
  await operation.seal();
  assert.equal((await readWorkerOperation(f.control)).at(-1).phase, 'sealed');
  await assert.rejects(operation.seal(), unsafe);
  await assert.rejects(releaseLock(f.control, f.lock), /worker|evidence/i);
});

test('helper creation alone prevents legacy finally-based lock release', async t => {
  const f = await fixture(t);
  await assert.rejects(releaseLock(f.control, f.lock), /worker|evidence/i);
  assert.equal(JSON.parse(await readFile(path.join(f.control, 'lock', 'owner.json'))).token, f.lock.token);
});

test('even partial service activation or retirement evidence closes worker admission', async t => {
  for (const [marker, existing] of [
    ['service-activation.ndjson', false], ['service-activation.ndjson', true],
    ['service-retirement.json', false], ['service-retirement.json', true],
  ]) {
    const f = await fixture(t);
    const operation = existing ? await f.create() : null;
    await writeFile(path.join(f.control, marker), '{"partial":');
    if (operation) {
      await assert.rejects(operation.seal(), unsafe);
      assert.equal((await readWorkerOperation(f.control)).at(-1).phase, 'opened');
    } else {
      await assert.rejects(f.create(), unsafe);
      await assert.rejects(readFile(path.join(f.control, 'worker-operation.ndjson')), { code: 'ENOENT' });
    }
  }
});

test('foreign lock and invalid manifest never create operation authority', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ lock: { ...f.lock, token: randomUUID() } }), unsafe);
  await assert.rejects(f.create({ saved: { ...f.saved, manifestSha256: 'a'.repeat(64) } }), unsafe);
  await assert.rejects(readFile(path.join(f.control, 'worker-operation.ndjson')), { code: 'ENOENT' });
});

test('competing creators yield one authority and never reopen a closed journal', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.create(), f.create()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && unsafe(r.reason)).length, 1);
  await results.find(r => r.status === 'fulfilled').value.close();
  await assert.rejects(f.create(), unsafe);
});

test('authority captures caller fields before asynchronous verification', async t => {
  const f = await fixture(t);
  const lock = { ...f.lock };
  const saved = { ...f.saved };
  const creating = f.create({ lock, saved });
  lock.token = randomUUID();
  saved.manifestSha256 = 'b'.repeat(64);
  await creating;
  const [record] = await readWorkerOperation(f.control);
  assert.equal(record.lock.token, f.lock.token);
  assert.equal(record.manifestSha256, f.saved.manifestSha256);
});

test('lock replacement or helper tampering prevents a seal and retains evidence', async t => {
  for (const mode of ['lock', 'helper']) {
    const f = await fixture(t);
    const operation = await f.create();
    if (mode === 'lock') await writeFile(path.join(f.control, 'lock', 'owner.json'),
      JSON.stringify({ ...f.lock, token: randomUUID() }));
    else await writeFile(path.join(f.saved.directory, 'worker-wire.mjs'), 'tampered');
    await assert.rejects(operation.seal(), unsafe);
    assert.equal((await readWorkerOperation(f.control)).at(-1).phase, 'opened');
  }
});

test('byte-identical lock owner replacement does not preserve live operation authority', async t => {
  const f = await fixture(t);
  const operation = await f.create();
  const file = path.join(f.control, 'lock', 'owner.json');
  await rename(file, `${file}.original`);
  await writeFile(file, await readFile(`${file}.original`), { mode: 0o600 });
  await assert.rejects(operation.seal(), unsafe);
  assert.equal((await readWorkerOperation(f.control)).at(-1).phase, 'opened');
});

test('unregistered worker evidence prevents zero-worker sealing', async t => {
  const f = await fixture(t);
  const operation = await f.create();
  await writeFile(path.join(f.control, `worker-${randomUUID()}.ndjson`), '');
  await assert.rejects(operation.seal(), unsafe);
});

test('unregistered worker evidence prevents opening a new native admission authority', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.control, `worker-${randomUUID()}.ndjson`), '');
  await assert.rejects(f.create(), unsafe);
  await assert.rejects(readFile(path.join(f.control, 'worker-operation.ndjson')), { code: 'ENOENT' });
});

test('truncated authority cannot be read, rewritten or used to release a lock', async t => {
  const f = await fixture(t);
  const operation = await f.create();
  await operation.close();
  const file = path.join(f.control, 'worker-operation.ndjson');
  const original = await readFile(file);
  await writeFile(file, original.subarray(0, original.length - 1));
  await assert.rejects(readWorkerOperation(f.control), unsafe);
  await assert.rejects(f.create(), unsafe);
  await assert.rejects(releaseLock(f.control, f.lock), /worker|evidence/i);
});

test('original writer refuses a replaced operation file', async t => {
  const f = await fixture(t);
  const operation = await f.create();
  const file = path.join(f.control, 'worker-operation.ndjson');
  await rename(file, `${file}.original`);
  await writeFile(file, await readFile(`${file}.original`), { mode: 0o600 });
  await assert.rejects(operation.seal(), unsafe);
});

test('failed enrollment flush closes operation admission before native preparation', async t => {
  const f = await fixture(t);
  const operation = await f.create();
  const probe = await open(path.join(f.control, 'worker-operation.ndjson'), 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  t.mock.method(prototype, 'sync', async () => { throw new Error('injected enrollment flush failure'); });
  const workerId = randomUUID();
  await assert.rejects(operation.run({
    workerId, command: { file: process.execPath, args: ['-e', 'process.exit(0)'], cwd: f.project, env: {} },
    runtime: process.platform === 'linux' ? { uid: 0, gid: 0 }
      : { pwsh: 'C:\\missing\\pwsh.exe', accountSid: 'S-1-5-18', sessionId: 0 },
  }), unsafe);
  t.mock.restoreAll();
  await assert.rejects(readFile(path.join(f.control, `worker-${workerId}.ndjson`)), { code: 'ENOENT' });
  await assert.rejects(operation.seal(), unsafe);
  await assert.rejects(operation.run({}), unsafe);
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
});

test('missing helper after authority creation cannot enroll a worker', async t => {
  const f = await fixture(t);
  const operation = await f.create();
  await rename(f.saved.directory, `${f.saved.directory}.displaced`);
  await assert.rejects(operation.run({
    workerId: randomUUID(), command: { file: process.execPath, args: [], cwd: f.project, env: {} },
    runtime: process.platform === 'linux' ? { uid: 0, gid: 0 }
      : { pwsh: 'C:\\missing\\pwsh.exe', accountSid: 'S-1-5-18', sessionId: 0 },
  }), unsafe);
  assert.equal((await readWorkerOperation(f.control)).length, 1);
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
});

test('invalid UTF-8, foreign digest and duplicate enrollment histories are never repaired', async t => {
  const f = await fixture(t);
  const operation = await f.create();
  await operation.close();
  const file = path.join(f.control, 'worker-operation.ndjson');
  const original = await readFile(file);
  const header = JSON.parse(original.toString('utf8'));
  const entry = { ...header, phase: 'enrolled', workerId: randomUUID() };
  const utf8 = Buffer.from(original);
  utf8[utf8.indexOf(Buffer.from(f.lock.operationId))] = 0xff;
  for (const bytes of [
    utf8,
    Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify({ ...entry, manifestSha256: 'a'.repeat(64) })}\n`),
    Buffer.from([header, entry, entry].map(record => JSON.stringify(record)).join('\n') + '\n'),
    Buffer.from([header, { ...header, phase: 'sealed' }, entry].map(record => JSON.stringify(record)).join('\n') + '\n'),
  ]) {
    await writeFile(file, bytes);
    await assert.rejects(readWorkerOperation(f.control), unsafe);
    assert.deepEqual(await readFile(file), bytes);
  }
});

test('actual authority owner death preserves its lock and cannot be adopted by another controller', {
  timeout: 45000,
}, async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'ctl');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const child = fork(new URL('./deployment-operation-owner-child.mjs', import.meta.url),
    [control, project, source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const { lock, saved } = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Authority child exited ${code}: ${diagnostic}`)));
  });
  child.kill('SIGKILL');
  await exited;
  assert.equal((await readWorkerOperation(control))[0].lock.pid, child.pid);
  await assert.rejects(createWorkerOperation({ control, lock, saved }), unsafe);
  await assert.rejects(releaseLock(control, lock), /owner/);
  await assert.rejects(acquireLock(control, { project, operationId: 'another' }), /lock/);
});

test('closing operation preserves both journal and retained-lock close failures', async t => {
  const f = await fixture(t);
  const probe = await open(path.join(f.control, 'lock', 'owner.json'), 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const handles = new Set();
  const stat = prototype.stat;
  t.mock.method(prototype, 'stat', async function (...args) {
    handles.add(this);
    return stat.apply(this, args);
  });
  const operation = await createWorkerOperation({ control: f.control, lock: f.lock, saved: f.saved });
  t.mock.restoreAll();
  const retained = [...handles].filter(handle => handle.fd >= 0);
  assert.equal(retained.length, 2);
  let closed = 0;
  for (const handle of retained) {
    const close = handle.close;
    t.mock.method(handle, 'close', async function () {
      await close.call(this);
      closed++;
      throw new Error(`injected close failure ${closed}`);
    });
  }
  await assert.rejects(operation.close(), error => {
    assert.equal(error.recoveryAllowed, false);
    assert.equal(error.cause.errors.length, 2);
    return true;
  });
  t.mock.restoreAll();
  assert.equal(closed, 2);
  await assert.rejects(operation.seal(), unsafe);
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
});
