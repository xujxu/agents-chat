import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { runOwnedWorker } from '../scripts/deployment/owned-worker.mjs';
import { createWorkerJournal, readWorkerJournal } from '../scripts/deployment/worker-journal.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { prepareLinuxWorker } from '../scripts/deployment/linux-worker.mjs';
import { runStage } from '../scripts/deployment/stage-runner.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));

async function fixture(t, code, args = [], controlName = 'ctl') {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, controlName);
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const owner = {
    project, operationId: randomUUID(), workerId: randomUUID(),
    controllerIdentity: await processIdentity(process.pid),
  };
  const saved = await saveWorkerEngine({ source, control, project, operationId: owner.operationId });
  const journal = await createWorkerJournal(control, owner);
  t.after(() => journal.close());
  const command = { file: process.execPath, args: ['-e', code, ...args], cwd: project,
    env: { PATH: process.env.PATH, NATIVE_FIXTURE: 'exact $ % " space' } };
  const receipts = [];
  const controller = new AbortController();
  const operations = {
    async record(receipt) { await journal.record(receipt); receipts.push(receipt); },
    prepare: context => prepareLinuxWorker({ ...context, saved, command, uid: 0, gid: 0 }),
  };
  const run = () => runOwnedWorker({ owner, signal: controller.signal }, operations);
  t.after(async () => {
    // Only this fixture's UUID unit; cleanup never searches names or ports.
    const unit = `agents-deploy-${owner.workerId}.service`;
    const { stdout } = await execute('systemctl', ['show', unit, '--property=LoadState', '--value']);
    if (stdout.trim() === 'not-found') return;
    await execute('systemctl', ['stop', unit], { timeout: 15000 });
    const state = await execute('systemctl', ['show', unit, '--property=LoadState', '--value']);
    if (state.stdout.trim() !== 'not-found') await execute('systemctl', ['reset-failed', unit]);
  });
  return { project, control, owner, saved, command, run, receipts, controller, operations };
}

test('real systemd worker is admitted from the saved engine and settles its retained cgroup', async t => {
  const f = await fixture(t, `process.stdout.write(process.env.NATIVE_FIXTURE); process.stderr.write('diagnostic');`);
  const result = await f.run();
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'exact $ % " space');
  assert.equal(result.stderr, 'diagnostic');
  assert.deepEqual(f.receipts.map(receipt => receipt.phase), ['intent', 'owned', 'admitted', 'settled']);
  assert.equal(f.receipts[1].domain.kind, 'systemd');
  assert.equal((await readWorkerJournal(f.control, f.owner)).at(-1).phase, 'settled');
});

test('root exit cannot leave detached descendants writing after settlement', async t => {
  const code = `
    const { spawn } = require('node:child_process');
    const script = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync('writer','x'),10)";
    const child=spawn(process.execPath,['-e',script],{detached:true,stdio:'ignore'});
    child.unref();
    setTimeout(()=>process.exit(0),300);
  `;
  const f = await fixture(t, code);
  await f.run();
  const file = path.join(f.project, 'writer');
  const first = await readFile(file, 'utf8');
  assert.ok(first.length > 0);
  await delay(250);
  assert.equal(await readFile(file, 'utf8'), first);
});

test('cancellation of a running target stops ignored signals and redirected descendants', async t => {
  const f = await fixture(t, `
    const fs=require('node:fs');
    process.on('SIGTERM',()=>{});
    fs.writeFileSync('writer','x');
    fs.writeFileSync('started','yes');
    setInterval(()=>fs.appendFileSync('writer','x'),10);
  `);
  const running = f.run();
  const rejection = assert.rejects(running, /cancel native/);
  for (let index = 0; index < 200; index++) {
    try { await stat(path.join(f.project, 'started')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
    if (index === 199) assert.fail('target never started');
  }
  f.controller.abort(new Error('cancel native'));
  await rejection;
  const file = path.join(f.project, 'writer');
  const first = await readFile(file, 'utf8');
  await delay(250);
  assert.equal(await readFile(file, 'utf8'), first);
  assert.equal(f.receipts.at(-1).phase, 'settled');
});

test('cancellation after native readiness never grants the target', async t => {
  const f = await fixture(t, `require('node:fs').writeFileSync('must-not-run','bad');`);
  const record = f.operations.record;
  f.operations.record = async receipt => {
    await record(receipt);
    if (receipt.phase === 'owned') f.controller.abort(new Error('cancel before grant'));
  };
  await assert.rejects(f.run(), /cancel before grant/);
  await assert.rejects(stat(path.join(f.project, 'must-not-run')), { code: 'ENOENT' });
  assert.deepEqual(f.receipts.map(receipt => receipt.phase), ['intent', 'owned', 'settled']);
});

test('nonzero targets fail after cleanup and huge output is bounded without deadlock', async t => {
  const f = await fixture(t, `
    process.stdout.write('o'.repeat(2*1024*1024));
    process.stderr.write('e'.repeat(2*1024*1024),()=>process.exit(7));
  `);
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'DEPLOYMENT_COMMAND_FAILED');
    assert.equal(error.result.exitCode, 7);
    assert.equal(Buffer.byteLength(error.result.stdout), 8192);
    assert.equal(Buffer.byteLength(error.result.stderr), 8192);
    return true;
  });

  assert.equal(f.receipts.at(-1).phase, 'settled');
});

test('binary or partial UTF-8 output cannot exceed the public diagnostic tail limit', async t => {
  const f = await fixture(t, `process.stdout.write(Buffer.alloc(20000,255));`);
  const result = await f.run();
  assert.ok(Buffer.byteLength(result.stdout) <= 8192);
});

test('target arguments are not shell-expanded or interpreted by systemd', async t => {
  const args = ['$HOME', '%n', 'quote " and spaces', 'semi;colon', 'unicode-\u4e2d'];
  const f = await fixture(t, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));', args);
  assert.deepEqual(JSON.parse((await f.run()).stdout), args);
});

test('saved bootstrap and socket paths preserve literal systemd and environment metacharacters', async t => {
  const f = await fixture(t, `process.stdout.write('literal-path');`, [], 'ctl-%n-$HOME');
  assert.equal((await f.run()).stdout, 'literal-path');
});

test('mutable command input is captured before native preparation awaits', async t => {
  const f = await fixture(t, `process.stdout.write('original');`);
  const prepare = f.operations.prepare;
  f.operations.prepare = context => {
    const pending = prepare(context);
    f.command.args[1] = `process.stdout.write('changed');`;
    f.command.env.NATIVE_FIXTURE = 'changed';
    return pending;
  };
  assert.equal((await f.run()).stdout, 'original');
});

test('foreign controller identity and implicit runtime account are refused before native creation', async t => {
  const f = await fixture(t, 'process.exit(0)');
  await assert.rejects(prepareLinuxWorker({
    owner: { ...f.owner, controllerIdentity: 'foreign' }, saved: f.saved,
    command: f.command, uid: 0, gid: 0,
  }), /identity|controller/i);
  await assert.rejects(prepareLinuxWorker({
    owner: f.owner, saved: f.saved, command: f.command,
  }), /account|uid|gid/i);
  const { stdout } = await execute('systemctl', [
    'show', `agents-deploy-${f.owner.workerId}.service`, '--property=LoadState', '--value',
  ]);
  assert.equal(stdout.trim(), 'not-found');
});

test('an existing same-name sentinel unit is refused without stopping or replacing it', async t => {
  const f = await fixture(t, `require('node:fs').writeFileSync('must-not-run','bad');`);
  const unit = `agents-deploy-${f.owner.workerId}.service`;
  await execute('systemd-run', [
    '--system', '--quiet', '--unit', unit, '--property=Type=exec',
    '--property=RuntimeMaxSec=60s', '/usr/bin/sleep', 'infinity',
  ], { timeout: 15000 });
  const before = await execute('systemctl', ['show', unit, '--property=MainPID,InvocationID,ActiveState']);
  await assert.rejects(prepareLinuxWorker({
    owner: f.owner, saved: f.saved, command: f.command, uid: 0, gid: 0,
  }), /already exists/);
  const after = await execute('systemctl', ['show', unit, '--property=MainPID,InvocationID,ActiveState']);
  assert.equal(after.stdout, before.stdout);
  assert.match(after.stdout, /ActiveState=active/);
  await assert.rejects(stat(path.join(f.project, 'must-not-run')), { code: 'ENOENT' });
});

async function waitForFile(file) {
  for (let index = 0; index < 200; index++) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  throw new Error(`Target did not create ${path.basename(file)}.`);
}

test('a real stage deadline settles the worker before any recovery is allowed', async t => {
  const f = await fixture(t, `
    const fs=require('node:fs'); fs.writeFileSync('writer','x');
    fs.writeFileSync('started','yes'); process.on('SIGTERM',()=>{});
    setInterval(()=>fs.appendFileSync('writer','x'),10);
  `);
  const prepare = f.operations.prepare;
  f.operations.prepare = async context => {
    const handle = await prepare(context);
    const run = handle.run;
    handle.run = async ({ signal }) => {
      const result = run({ signal });
      result.catch(() => {});
      await waitForFile(path.join(f.project, 'started'));
      return runStage('native-command', innerSignal => {
        innerSignal.addEventListener('abort', () => f.controller.abort(innerSignal.reason), { once: true });
        return result;
      }, { timeoutMs: 200, settlementMs: 10000 });
    };
    return handle;
  };
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'DEPLOYMENT_STAGE_TIMEOUT');
    assert.equal(error.recoveryAllowed, true);
    return true;
  });
  assert.equal(f.receipts.at(-1).phase, 'settled');
  const content = await readFile(path.join(f.project, 'writer'), 'utf8');
  await delay(250);
  assert.equal(await readFile(path.join(f.project, 'writer'), 'utf8'), content);
});

test('killing the native bootstrap terminates its target writers without losing cleanup authority', async t => {
  const f = await fixture(t, `
    const fs=require('node:fs'); fs.writeFileSync('writer','x'); fs.writeFileSync('started','yes');
    setInterval(()=>fs.appendFileSync('writer','x'),10);
  `);
  const outcome = f.run().then(value => ({ value }), error => ({ error }));
  await waitForFile(path.join(f.project, 'started'));
  const unit = `agents-deploy-${f.owner.workerId}.service`;
  const { stdout } = await execute('systemctl', ['show', unit, '--property=MainPID', '--value']);
  const pid = Number(stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  process.kill(pid, 'SIGKILL');
  const result = await outcome;
  assert.match(result.error.message, /transport closed/i);
  assert.equal(f.receipts.at(-1).phase, 'settled');
  const content = await readFile(path.join(f.project, 'writer'), 'utf8');
  await delay(250);
  assert.equal(await readFile(path.join(f.project, 'writer'), 'utf8'), content);
});

test('killing the CLI controller stops native writers but retains admitted journal evidence', {
  timeout: 30000,
}, async t => {
  const f = await fixture(t, `
    const fs=require('node:fs'); fs.writeFileSync('writer','x'); fs.writeFileSync('started','yes');
    setInterval(()=>fs.appendFileSync('writer','x'),10);
  `);
  const owner = { ...f.owner, workerId: randomUUID() };
  const unit = `agents-deploy-${owner.workerId}.service`;
  const child = fork(new URL('./deployment-linux-controller-child.mjs', import.meta.url),
    [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  const exit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
    const state = await execute('systemctl', ['show', unit, '--property=LoadState', '--value']);
    if (state.stdout.trim() !== 'not-found') {
      await execute('systemctl', ['stop', unit], { timeout: 15000 });
      const remaining = await execute('systemctl', ['show', unit, '--property=LoadState', '--value']);
      if (remaining.stdout.trim() !== 'not-found') await execute('systemctl', ['reset-failed', unit]);
    }
  });
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Controller failed ${code}: ${stderr}`)));
  });
  child.send({ owner, saved: f.saved, command: f.command, control: f.control });
  const announced = await ready;
  await waitForFile(path.join(f.project, 'started'));
  child.kill('SIGKILL');
  await exit;
  let state;
  for (let index = 0; index < 200; index++) {
    state = await execute('systemctl', ['show', unit, '--property=ActiveState', '--value']);
    if (state.stdout.trim() === 'failed') break;
    await delay(50);
  }
  assert.equal(state.stdout.trim(), 'failed');
  const content = await readFile(path.join(f.project, 'writer'), 'utf8');
  await delay(250);
  assert.equal(await readFile(path.join(f.project, 'writer'), 'utf8'), content);
  assert.equal((await readWorkerJournal(f.control, announced.owner)).at(-1).phase, 'admitted');
  await assert.rejects(createWorkerJournal(f.control, announced.owner));
});
