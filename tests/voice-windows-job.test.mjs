import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const launcher = path.resolve('.data/voice-windows-build/voice-job.exe');
const policy = path.resolve('.data/voice-windows-build/voice-policy.exe');
const fixture = path.resolve('tests/fixtures/voice-windows-engine.mjs');
const parentFixture = path.resolve('tests/fixtures/voice-windows-parent.mjs');
const pause = () => new Promise(resolve => setTimeout(resolve, 25));

async function until(check, label) {
  const end = Date.now() + 5000;
  do {
    if (await check()) return;
    await pause();
  } while (Date.now() < end);
  assert.fail(label);
}

async function jsonFile(file) {
  let result;
  await until(async () => {
    try { result = JSON.parse(await readFile(file, 'utf8')); return true; }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
      throw error;
    }
  }, `fixture did not become ready: ${path.basename(file)}`);
  return result;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function stop(pid) {
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
}

function run(binary, args) {
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;
  });
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({
      code, stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
  void done.catch(() => {});
  return { child, done };
}

test('Windows Job launcher contracts', { timeout: 90000 }, async t => {
  assert.equal(process.platform, 'win32', 'run only in the Windows Actions job');
  const root = await mkdtemp(path.join(tmpdir(), 'voice job \u8bed\u97f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracked = new Set();
  t.after(() => { for (const pid of tracked) stop(pid); });
  const start = (binary, args) => {
    const result = run(binary, args);
    if (result.child.pid) tracked.add(result.child.pid);
    return result;
  };
  const engine = (args, deadline = '5000', executable = launcher) =>
    start(executable, [deadline, process.execPath, fixture, ...args]);

  await t.test('exact Unicode, whitespace, quote and backslash arguments; no shell', async () => {
    const args = ['two words', '\u4f60\u597d', '', 'say"hello', 'C:\\trailing\\', '& echo not-a-command'];
    const spaced = path.join(root, 'launcher space.exe');
    await copyFile(launcher, spaced);
    const result = await engine(['args', ...args], '5000', spaced).done;
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.equal(result.stderr, '');
  });

  await t.test('engine exit preserved and private native stderr not forwarded', async () => {
    assert.deepEqual(await engine(['exit', '7']).done, { code: 7, stdout: '', stderr: '' });
  });

  await t.test('missing executable is an explicit sanitized failure', async () => {
    const result = await start(launcher, ['5000', path.join(root, 'missing.exe')]).done;
    assert.equal(result.code, 125);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^voice_job_error:\d+\r?\n$/);
    assert.ok(!result.stderr.includes(root));
  });

  await t.test('inner Job sets lifecycle only, including when nested', async () => {
    for (const args of [
      ['5000', policy],
      ['10000', process.execPath, fixture, 'nested', launcher, policy],
    ]) {
      const result = await start(launcher, args).done;
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        limitFlags: 8192, cpuControlFlags: 0,
      });
    }
  });

  for (const mode of ['eof', 'cancel', 'deadline', 'launcher-death', 'engine-exit']) {
    await t.test(`tears down real descendants: ${mode}`, async () => {
      const file = path.join(root, `${mode}.json`);
      const job = engine([mode === 'engine-exit' ? 'tree-exit' : 'tree', file],
        mode === 'deadline' ? '2000' : '15000');
      const pids = await jsonFile(file);
      tracked.add(pids.engine); tracked.add(pids.descendant);
      if (mode !== 'engine-exit') {
        assert.ok(alive(pids.engine));
        assert.ok(alive(pids.descendant));
      }
      if (mode === 'eof') job.child.stdin.end();
      if (mode === 'cancel') job.child.stdin.write('cancel\n');
      if (mode === 'launcher-death') job.child.kill('SIGKILL');
      const result = await job.done;
      if (mode === 'eof' || mode === 'cancel') assert.equal(result.code, 126);
      if (mode === 'deadline') assert.equal(result.code, 124);
      if (mode === 'engine-exit') {
        assert.equal(result.code, 0);
        assert.equal(result.stdout, 'completed');
      }
      await until(() => !alive(pids.engine) && !alive(pids.descendant),
        `${mode} left running processes`);
    });
  }

  await t.test('actual Node-parent death closes control without inherited writers', async () => {
    const treeFile = path.join(root, 'parent-tree.json');
    const parentFile = path.join(root, 'parent-launcher.json');
    const parent = start(process.execPath, [
      parentFixture, launcher, fixture, treeFile, parentFile,
    ]);
    const [pids, owner] = await Promise.all([jsonFile(treeFile), jsonFile(parentFile)]);
    tracked.add(pids.engine); tracked.add(pids.descendant); tracked.add(owner.launcher);
    assert.ok(alive(pids.engine) && alive(pids.descendant));
    parent.child.kill('SIGKILL');
    await parent.done;
    await until(() => !alive(owner.launcher) && !alive(pids.engine) && !alive(pids.descendant),
      'parent death leaked its launcher or engine tree');
  });

  await t.test('repeated early cancellation does not spawn a late engine', async () => {
    for (let i = 0; i < 12; i++) {
      const job = engine(['args', 'unused']);
      job.child.stdin.end();
      const result = await job.done;
      assert.ok(result.code === 126 || result.code === 0);
      if (result.code === 0) assert.equal(result.stdout, '["unused"]');
    }
  });
});
