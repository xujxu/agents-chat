import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { acquireLock, releaseLock } from '../scripts/deployment/state.mjs';
import { saveRecoveryEngine, retirementRecoveryInvocation } from '../scripts/deployment/saved-recovery-engine.mjs';

const sourceTree = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
const execute = promisify(execFile);
async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'ctl');
  const source = path.join(project, 'scripts', 'deployment');
  await cp(sourceTree, source, { recursive: true });
  await mkdir(control, { mode: 0o700 });
  await mkdir(path.join(control, 'backup'));
  await writeFile(path.join(control, 'backup', 'sentinel'), 'retained backup');
  const engine = await saveRecoveryEngine({ source, control });
  const child = fork(new URL('./deployment-retirement-child.mjs', import.meta.url),
    [control, project, source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const { lock, saved } = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Cleanup owner exited ${code}: ${diagnostic}`)));
  });
  const invoke = () => retirementRecoveryInvocation(engine, { control, project, operationId: lock.operationId });
  const recover = async () => {
    const command = invoke();
    return execute(command.file, command.args, { env: command.env, timeout: 45000, maxBuffer: 8192 });
  };
  const kill = async () => { child.kill('SIGKILL'); await exited; };
  return { root, project, control, source, engine, lock, saved, kill, recover };
}

test('independent saved recovery finishes partial retirement after original checkout disappears', async t => {
  const f = await fixture(t);
  await f.kill();
  const state = await readFile(path.join(f.control, 'state.json'));
  await rename(f.project, `${f.project}.displaced`);
  const result = JSON.parse((await f.recover()).stdout);
  assert.deepEqual(result, { status: 'retired', operationId: f.lock.operationId, restored: false });
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-engine', 'state.json']);
  assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
  assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained backup');
  await mkdir(f.project);
  const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
  await releaseLock(f.control, lock);
});

test('live original owner cannot be adopted and failure creates no recovery guard', async t => {
  const f = await fixture(t);
  const marker = await readFile(path.join(f.control, 'worker-retirement.json'));
  await assert.rejects(f.recover());
  assert.deepEqual(await readFile(path.join(f.control, 'worker-retirement.json')), marker);
  assert.ok(!(await readdir(f.control)).includes('recovery-lock'));
});

test('malformed or foreign deletion evidence is rejected before any additional deletion', async t => {
  for (const mode of ['truncated', 'path', 'state', 'foreign']) {
    const f = await fixture(t);
    await f.kill();
    const file = path.join(f.control, 'worker-retirement.json');
    const marker = JSON.parse(await readFile(file, 'utf8'));
    if (mode === 'truncated') await writeFile(file, '{"version":2,');
    if (mode === 'path') {
      marker.files[0].path = path.join('backup', 'sentinel');
      await writeFile(file, JSON.stringify(marker));
    }
    if (mode === 'state') await writeFile(path.join(f.control, 'state.json'), '{}');
    if (mode === 'foreign') await writeFile(path.join(f.saved.directory, 'foreign'), 'untouched');
    const before = (await readdir(f.saved.directory)).sort();
    await assert.rejects(f.recover());
    assert.deepEqual((await readdir(f.saved.directory)).sort(), before);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained backup');
    assert.ok((await readdir(f.control)).includes('lock'));
  }
});

test('concurrent saved recovery processes cannot both acquire cleanup authority', async t => {
  const f = await fixture(t);
  await f.kill();
  const results = await Promise.allSettled([f.recover(), f.recover()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-engine', 'state.json']);
});

test('preexisting incomplete recovery guard blocks recovery and ordinary lock operations', async t => {
  const f = await fixture(t);
  await f.kill();
  await mkdir(path.join(f.control, 'recovery-lock'), { mode: 0o700 });
  await assert.rejects(f.recover());
  await assert.rejects(acquireLock(f.control, { project: f.project, operationId: 'new' }));
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: 'guard' });
  await mkdir(path.join(root, 'recovery-lock'), { mode: 0o700 });
  await assert.rejects(releaseLock(root, lock), /recovery/i);
});

test('fixed recovery bundle is reusable only for identical verified source', async t => {
  const f = await fixture(t);
  assert.deepEqual(await saveRecoveryEngine({ source: f.source, control: f.control }), f.engine);
  await writeFile(path.join(f.source, 'retirement-recovery.mjs'), 'changed');
  await assert.rejects(saveRecoveryEngine({ source: f.source, control: f.control }));
  await f.kill();
  await f.recover();
});
