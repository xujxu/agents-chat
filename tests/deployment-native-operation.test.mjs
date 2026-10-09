import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { temporaryDeployment, acceptOperation, acquireLock, releaseLock,
  retirementRecoveryInvocation, admissionFiles } from './deployment-fixture.mjs';
import { writeState } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation, readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { readWorkerJournal } from '../scripts/deployment/worker-journal.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { prepareNpmCommand } from '../scripts/deployment/npm-command.mjs';
import { readSourceCommandResult } from '../scripts/deployment/source-command.mjs';
import { runStage } from '../scripts/deployment/stage-runner.mjs';
import { inspectBuildArtifacts } from '../scripts/deployment/build-artifacts.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'ctl');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
  let runtime = { uid: 0, gid: 0 };
  if (process.platform === 'win32') {
    const script = `
      $ErrorActionPreference='Stop'
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      @{accountSid=$sid.Value;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Compress
    `;
    const { stdout } = await execute(process.env.DEPLOYMENT_TEST_PWSH,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 30000, maxBuffer: 4096 });
    runtime = { pwsh: process.env.DEPLOYMENT_TEST_PWSH, ...JSON.parse(stdout.trim()) };
  }
  const operation = await createWorkerOperation({ control, lock, saved });
  t.after(() => operation.close());
  const run = (code, workerId = randomUUID(), signal) => operation.run({
    workerId, signal, runtime,
    command: { file: process.execPath, args: ['-e', code], cwd: project,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) },
  });
  return { project, control, lock, saved, operation, run, runtime };
}

test('real native workers require enrolled lock-bound authority and seal exact settled inventory', async t => {
  const f = await fixture(t);
  const first = randomUUID();
  const second = randomUUID();
  assert.equal((await f.run('process.stdout.write("one")', first)).stdout, 'one');
  await assert.rejects(f.run('process.exit(7)', second), { code: 'DEPLOYMENT_COMMAND_FAILED' });
  await f.operation.seal();
  const records = await readWorkerOperation(f.control);
  assert.deepEqual(records.map(record => record.phase), ['opened', 'enrolled', 'enrolled', 'sealed']);
  assert.deepEqual(records.slice(1, 3).map(record => record.workerId), [first, second]);
  for (const workerId of [first, second]) {
    const receipts = await readWorkerJournal(f.control, {
      project: f.project, operationId: f.lock.operationId, workerId, controllerIdentity: f.lock.processIdentity,
    });
    assert.deepEqual(receipts.map(receipt => receipt.phase), ['intent', 'owned', 'admitted', 'settled']);
  }
  await assert.rejects(f.run('process.exit(0)'), { recoveryAllowed: false });
  await assert.rejects(releaseLock(f.control, f.lock), /evidence/);
});

test('actual npm install and build run inside enrolled native ownership with descendant settlement', async t => {
  const f = await fixture(t);
  const npmCli = process.env.DEPLOYMENT_TEST_NPM_CLI;
  assert.ok(npmCli, 'Actions must supply the installed npm CLI path.');
  await writeFile(path.join(f.project, 'package.json'), JSON.stringify({
    name: 'deployment-build-fixture', version: '1.0.0', scripts: { build: 'node build.cjs' },
  }));
  await writeFile(path.join(f.project, 'package-lock.json'), JSON.stringify({
    name: 'deployment-build-fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'deployment-build-fixture', version: '1.0.0' } },
  }));
  await writeFile(path.join(f.project, 'build.cjs'), "require('node:fs').writeFileSync('artifact','built');");
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
  environment.npm_config_cache = path.join(f.project, '.npm');
  const run = async (stage, signal) => f.operation.run({
    workerId: randomUUID(), runtime: f.runtime, signal,
    command: await prepareNpmCommand({ project: f.project, node: process.execPath, npmCli, stage, environment, signal }),
  });

  await run('dependencies');
  await run('build');
  assert.equal(await readFile(path.join(f.project, 'artifact'), 'utf8'), 'built');
  await writeFile(path.join(f.project, 'build.cjs'), 'process.exit(19);');
  await assert.rejects(run('build'), error => error.code === 'DEPLOYMENT_COMMAND_FAILED' && error.result.exitCode !== 0);
  await writeFile(path.join(f.project, 'build.cjs'), `
    const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');fs.writeFileSync('writer-ready','yes');setInterval(()=>fs.appendFileSync('writer','x'),10);")}],
      {detached:true,stdio:'ignore'}).unref();
    setInterval(()=>{},1000);
  `);
  const controller = new AbortController();
  const reason = new Error('cancel real npm build');
  const rejected = assert.rejects(run('build', controller.signal), error => error === reason);
  try {
    for (let attempt = 0; ; attempt++) {
      try { await readFile(path.join(f.project, 'writer')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (attempt === 600) throw new Error('npm build descendant did not start.');
      await delay(50);
    }
  } finally { controller.abort(reason); }
  await rejected;
  const before = await readFile(path.join(f.project, 'writer'));
  await delay(200);
  assert.deepEqual(await readFile(path.join(f.project, 'writer')), before);
  await unlink(path.join(f.project, 'writer'));
  await assert.rejects(runStage('build', signal => run('build', signal), { timeoutMs: 15000 }),
    error => error.code === 'DEPLOYMENT_STAGE_TIMEOUT' && error.recoveryAllowed === true);
  const timedOut = await readFile(path.join(f.project, 'writer'));
  assert.ok(timedOut.length, 'Timed build must actually run its descendant before the deadline.');
  await delay(200);
  assert.deepEqual(await readFile(path.join(f.project, 'writer')), timedOut);
  await f.operation.seal();
  assert.equal((await readWorkerOperation(f.control)).at(-1).phase, 'sealed');
});
test('actual Git source selection runs through saved native ownership without relying on checkout helpers', async t => {
  const f = await fixture(t);
  const git = process.env.DEPLOYMENT_TEST_GIT;
  assert.ok(git, 'Actions must supply the installed Git executable.');
  const setup = async (...args) => (await execute(git, ['-C', f.project, ...args])).stdout.trim();
  await setup('init', '--initial-branch=main');
  await setup('config', 'user.name', 'Deployment fixture');
  await setup('config', 'user.email', 'fixture@example.invalid');
  await setup('config', 'core.autocrlf', 'false');
  await writeFile(path.join(f.project, 'source.txt'), 'old\n');
  await setup('add', '.');
  await setup('commit', '-m', 'old');
  const old = await setup('rev-parse', 'HEAD');
  await writeFile(path.join(f.project, 'source.txt'), 'new\n');
  await setup('commit', '-am', 'new');
  const next = await setup('rev-parse', 'HEAD');
  await setup('switch', '--detach', old);
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
  const helpers = path.join(path.dirname(f.project), 'source-helpers');
  await mkdir(helpers);
  for (const name of ['source-command.mjs', 'source.mjs', 'snapshot-files.mjs',
    'worker-files.mjs', 'worker-wire.mjs', 'worker-identity.mjs']) {
    await copyFile(path.join(source, name), path.join(helpers, name));
  }
  const { captureSourceCommands } = await import(pathToFileURL(path.join(helpers, 'source-command.mjs')).href);
  const captureSignal = new AbortController();
  const commands = await captureSourceCommands({
    project: f.project, node: process.execPath, git, environment, signal: captureSignal.signal,
  });
  captureSignal.abort(new Error('Capture stage ended; later stages use fresh signals.'));
  await rename(helpers, `${helpers}-displaced`);
  const run = async (action, options = {}) => {
    const command = commands.prepare({ action, options });
    return readSourceCommandResult(await f.operation.run({
      workerId: randomUUID(), runtime: f.runtime, command,
    }), action, f.project);
  };
  assert.equal((await run('inspect')).commit, old);
  const target = await run('resolve', { revision: next });
  assert.equal(target.commit, next);
  assert.equal(await setup('rev-parse', 'HEAD'), old);
  assert.equal((await run('select', target)).commit, next);
  assert.equal(await readFile(path.join(f.project, 'source.txt'), 'utf8'), 'new\n');
  await setup('switch', 'main');
  const upstream = path.join(path.dirname(f.project), 'upstream');
  await execute(git, ['clone', '--no-hardlinks', f.project, upstream]);
  for (const args of [['config', 'user.name', 'Deployment fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
    await execute(git, ['-C', upstream, ...args]);
  }
  await writeFile(path.join(upstream, 'source.txt'), 'upstream\n');
  await execute(git, ['-C', upstream, 'commit', '-am', 'upstream']);
  const third = (await execute(git, ['-C', upstream, 'rev-parse', 'HEAD'])).stdout.trim();
  await setup('remote', 'add', 'origin', upstream);
  await setup('config', 'branch.main.remote', 'origin');
  await setup('config', 'branch.main.merge', 'refs/heads/main');
  const fetched = await run('resolve');
  assert.equal(fetched.mode, 'fast-forward');
  assert.equal(fetched.commit, third);
  assert.equal(await setup('rev-parse', 'HEAD'), next);
  assert.equal((await run('select', fetched)).commit, third);
  assert.equal(await setup('symbolic-ref', '--short', 'HEAD'), 'main');
  await writeFile(path.join(f.project, 'source.txt'), 'preserve dirty source\n');
  await assert.rejects(run('inspect'), { code: 'DEPLOYMENT_COMMAND_FAILED' });
  assert.equal(await readFile(path.join(f.project, 'source.txt'), 'utf8'), 'preserve dirty source\n');
  await f.operation.seal();
});

test('actual application source installs and builds inside native ownership', {
  skip: process.env.DEPLOYMENT_TEST_REAL_BUILD !== '1',
}, async t => {
  const f = await fixture(t);
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const git = process.env.DEPLOYMENT_TEST_GIT;
  const npmCli = process.env.DEPLOYMENT_TEST_NPM_CLI;
  assert.ok(git && npmCli, 'Actual application build requires explicit Git/npm paths.');
  await execute(git, ['-c', `safe.directory=${repository}`, 'clone', '--no-hardlinks', repository, f.project],
    { timeout: 120000, maxBuffer: 8192 });
  if (process.platform === 'win32') {
    assert.equal((await execute(git, ['-C', f.project, 'rev-parse', '--is-shallow-repository'])).stdout.trim(),
      'false', 'Complete Windows application snapshot requires full source history before building.');
  }
  const commit = (await execute(git, ['-C', f.project, 'rev-parse', 'HEAD'])).stdout.trim();
  const environment = {};
  const permitted = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']);
  for (const [key, value] of Object.entries(process.env)) if (permitted.has(key.toUpperCase())) environment[key] = value;
  environment.HOME = path.dirname(f.project);
  environment.NODE_ENV = 'production';
  environment.NEXT_TELEMETRY_DISABLED = '1';
  environment.NEXTAUTH_SECRET = 'actions-isolated-build-fixture-secret';
  environment.NEXTAUTH_URL = 'http://localhost:3010';
  environment.npm_config_cache = path.join(path.dirname(f.project), 'npm-cache');
  for (const stage of ['dependencies', 'build']) {
    await runStage(stage, async signal => f.operation.run({
      workerId: randomUUID(), runtime: f.runtime, signal,
      command: await prepareNpmCommand({ project: f.project, node: process.execPath, npmCli, stage, environment, signal }),
    }), { timeoutMs: 600000 });
  }
  const artifacts = await inspectBuildArtifacts({ project: f.project });
  assert.ok(artifacts.identity.buildId);
  const { captureSourceCommands } = await import('../scripts/deployment/source-command.mjs');
  const commands = await captureSourceCommands({ project: f.project, node: process.execPath, git, environment });
  const inspected = readSourceCommandResult(await f.operation.run({
    workerId: randomUUID(), runtime: f.runtime, command: commands.prepare({ action: 'inspect' }),
  }), 'inspect', f.project);
  assert.equal(inspected.commit, commit);
  await artifacts.check();
  await f.operation.seal();
  if (process.platform === 'win32') {
    const { stdout } = await execute(f.runtime.pwsh, ['-NoProfile', '-NonInteractive', '-File',
      path.join(repository, 'tests/deployment-windows-managed-application.ps1'),
      '-Project', f.project, '-Control', f.control, '-Node', process.execPath,
    ], { timeout: 240000, maxBuffer: 16384 });
    console.log(stdout.trim());
    await artifacts.check();
    const snapshot = await execute(f.runtime.pwsh, ['-NoProfile', '-NonInteractive', '-File',
      path.join(repository, 'tests/deployment-windows-managed-application.ps1'),
      '-Project', f.project, '-Control', f.control, '-Node', process.execPath,
      '-CompleteSnapshot',
    ], { timeout: 720000, maxBuffer: 16384 });
    console.log(snapshot.stdout.trim());
    await artifacts.check();
  }
});

test('a reused enrollment cannot recreate the original native domain', async t => {
  const f = await fixture(t);
  const workerId = randomUUID();
  await f.run('process.stdout.write("first")', workerId);
  await assert.rejects(f.run('require("node:fs").writeFileSync("reused","bad")', workerId),
    { recoveryAllowed: false });
  await assert.rejects(readFile(path.join(f.project, 'reused')), { code: 'ENOENT' });
  assert.equal((await readWorkerOperation(f.control)).length, 2);
});

test('operation cannot seal or admit another worker while a real writer is running', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('cancel enrolled writer');
  const rejected = assert.rejects(f.run(`
    const fs=require('node:fs');fs.writeFileSync('started','yes');
    setInterval(()=>fs.appendFileSync('writer','x'),10);
  `, randomUUID(), controller.signal), error => error === reason);
  for (let index = 0; index < 600; index++) {
    try { await readFile(path.join(f.project, 'started')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (index === 599) throw new Error('Enrolled native writer did not start.');
    await delay(50);
  }
  await assert.rejects(f.operation.seal(), { recoveryAllowed: false });
  await assert.rejects(f.run('process.exit(0)'), { recoveryAllowed: false });
  await assert.rejects(f.operation.close(), { recoveryAllowed: false });
  controller.abort(reason);
  await rejected;
  await f.operation.seal();
  assert.equal((await readWorkerOperation(f.control)).at(-1).phase, 'sealed');
});

test('replaced operation authority after native readiness never grants the actual command', async t => {
  const f = await fixture(t);
  const workerId = randomUUID();
  let original;
  const powershell = async script => execute(process.env.DEPLOYMENT_TEST_PWSH,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 30000, maxBuffer: 4096 });
  t.after(async () => {
    if (process.platform === 'win32' && original) {
      await powershell(`
        $ErrorActionPreference='Stop'
        try{$p=[Diagnostics.Process]::GetProcessById(${original.pid})}
        catch [ArgumentException]{return}
        if($p.StartTime.ToUniversalTime().Ticks.ToString() -cne '${original.ticks}'){throw 'Owner identity changed.'}
        $p.Kill()
        if(-not $p.WaitForExit(15000)){throw 'Fixture owner cleanup timed out.'}
      `);
    } else if (process.platform === 'linux' && original) {
      const { stdout } = await execute('/usr/bin/systemctl',
        ['show', original.unit, '--property=InvocationID', '--value'], { timeout: 15000 });
      assert.equal(stdout.trim(), original.invocationId);
      await execute('/usr/bin/systemctl', ['reset-failed', original.unit], { timeout: 15000 });
    }
  });
  const file = path.join(f.control, 'worker-operation.ndjson');
  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const write = prototype.write;
  let replaced = false;
  t.mock.method(prototype, 'write', async function (buffer, offset, length, position) {
    const result = await write.call(this, buffer, offset, length, position);
    if (!replaced && buffer.toString('utf8').includes('"phase":"admitted"')) {
      if (process.platform === 'win32') {
        const { stdout } = await powershell(`
          $ErrorActionPreference='Stop'
          $matches=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" |
            Where-Object { $_.CommandLine -like '*${workerId}*' })
          if($matches.Count -ne 1){throw 'Expected one native fixture owner.'}
          $p=[Diagnostics.Process]::GetProcessById($matches[0].ProcessId)
          @{pid=$p.Id;ticks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress
        `);
        original = JSON.parse(stdout.trim());
      } else {
        original = JSON.parse(buffer.toString('utf8')).domain;
      }
      replaced = true;
      await rename(file, `${file}.original`);
      await writeFile(file, await readFile(`${file}.original`), { mode: 0o600 });
    }
    return result;
  });
  await assert.rejects(f.run('require("node:fs").writeFileSync("forbidden","bad")', workerId),
    { recoveryAllowed: false });
  t.mock.restoreAll();
  assert.equal(replaced, true);
  await assert.rejects(readFile(path.join(f.project, 'forbidden')), { code: 'ENOENT' });
  await assert.rejects(f.operation.seal(), { recoveryAllowed: false });
});

test('two accepted native operations reuse one helper slot without deleting backup or app state', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.control, 'backup'));
  await writeFile(path.join(f.control, 'backup', 'retained'), 'original backup');
  await f.run('process.stdout.write("first operation")');
  await f.operation.seal();
  await acceptOperation(f.control, f.lock);
  await f.operation.retire();
  await releaseLock(f.control, f.lock);
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'state.json', ...admissionFiles]);
  const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
  const accepted = JSON.parse(await readFile(path.join(f.control, 'state.json'), 'utf8'));
  await writeState(f.control, { ...accepted, operationId: lock.operationId, phase: 'preflight',
    previousPhase: null, startedAt: lock.createdAt });
  const saved = await saveWorkerEngine({ source, control: f.control, project: f.project, operationId: lock.operationId });
  const operation = await createWorkerOperation({ control: f.control, lock, saved });
  t.after(() => operation.close());
  const result = await operation.run({
    workerId: randomUUID(), runtime: f.runtime,
    command: { file: process.execPath, args: ['-e', 'process.stdout.write("second operation")'], cwd: f.project,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) },
  });
  assert.equal(result.stdout, 'second operation');
  await operation.seal();
  let previousPhase = 'preflight';
  for (const phase of ['source-selected', 'dependencies', 'building', 'configuring', 'activating', 'accepted']) {
    await writeState(f.control, { ...accepted, operationId: lock.operationId, phase,
      previousPhase, startedAt: lock.createdAt });
    previousPhase = phase;
  }
  await operation.retire();
  await releaseLock(f.control, lock);
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'state.json', ...admissionFiles]);
  assert.equal(await readFile(path.join(f.control, 'backup', 'retained'), 'utf8'), 'original backup');
});

test('independent recovery releases interrupted cleanup only after a real native worker settled', { timeout: 120000 }, async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'ctl');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const recovery = await saveRecoveryEngine({ source, control });
  let runtime = { uid: 0, gid: 0 };
  if (process.platform === 'win32') {
    const { stdout } = await execute(process.env.DEPLOYMENT_TEST_PWSH, ['-NoProfile', '-NonInteractive', '-Command',
      '@{accountSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Compress'],
    { timeout: 30000, maxBuffer: 4096 });
    runtime = { pwsh: process.env.DEPLOYMENT_TEST_PWSH, ...JSON.parse(stdout.trim()) };
  }
  const child = fork(new URL('./deployment-retirement-child.mjs', import.meta.url),
    [control, project, source, JSON.stringify(runtime)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const { lock } = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Native cleanup fixture exited ${code}: ${stderr}`)));
  });
  assert.equal(await readFile(path.join(project, 'native-completed'), 'utf8'), 'yes');
  child.kill('SIGKILL');
  await exited;
  const invocation = retirementRecoveryInvocation(recovery, { control, project, operationId: lock.operationId });
  const { stdout } = await execute(invocation.file, invocation.args,
    { env: invocation.env, timeout: 60000, maxBuffer: 8192 });
  assert.equal(JSON.parse(stdout).status, 'retired');
  const next = await acquireLock(control, { project, operationId: randomUUID() });
  await releaseLock(control, next);
  assert.deepEqual((await readdir(control)).sort(), ['recovery-engine', 'state.json', ...admissionFiles]);
});
