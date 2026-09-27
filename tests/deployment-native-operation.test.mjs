import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { temporaryDeployment, acceptOperation } from './deployment-fixture.mjs';
import { acquireLock, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation, readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { readWorkerJournal } from '../scripts/deployment/worker-journal.mjs';
import { saveRecoveryEngine, retirementRecoveryInvocation } from '../scripts/deployment/saved-recovery-engine.mjs';

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
      $root='${control.replaceAll("'", "''")}'
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach($entry in @((Get-Item -LiteralPath $root)) + @(Get-ChildItem -LiteralPath $root -Recurse)){
        $acl=Get-Acl -LiteralPath $entry.FullName
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true,$false)
        foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
        foreach($s in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
          if($entry.PSIsContainer){
            $rule=[Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
          }else{$rule=[Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow')}
          $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $entry.FullName -AclObject $acl
      }
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
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'state.json']);
  const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
  const accepted = JSON.parse(await readFile(path.join(f.control, 'state.json'), 'utf8'));
  await writeState(f.control, { ...accepted, operationId: lock.operationId, phase: 'preflight',
    previousPhase: null, startedAt: lock.createdAt });
  const saved = await saveWorkerEngine({ source, control: f.control, project: f.project, operationId: lock.operationId });
  if (process.platform === 'win32') {
    const script = `
      $ErrorActionPreference='Stop'
      $root='${saved.directory.replaceAll("'", "''")}'
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach($entry in @((Get-Item -LiteralPath $root)) + @(Get-ChildItem -LiteralPath $root -Recurse)){
        $acl=Get-Acl -LiteralPath $entry.FullName
        $acl.SetOwner($sid)
        Set-Acl -LiteralPath $entry.FullName -AclObject $acl
      }
    `;
    await execute(f.runtime.pwsh,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 30000, maxBuffer: 4096 });
  }
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
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'state.json']);
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
  assert.deepEqual((await readdir(control)).sort(), ['recovery-engine', 'state.json']);
});
