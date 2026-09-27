import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
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
import { prepareWindowsWorker } from '../scripts/deployment/windows-worker.mjs';

const execute = promisify(execFile);
const pwsh = process.env.DEPLOYMENT_TEST_PWSH;
const source = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
const ps = (script, args = []) => execute(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(`$args=@(${args.map(arg => `'${arg.replaceAll("'", "''")}'`).join(',')})\n${script}`,
    'utf16le').toString('base64')], { timeout: 30000, maxBuffer: 8192 });

async function fixture(t, code, args = []) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'project with spaces');
  const control = path.join(root, 'control');
  await mkdir(project);
  await mkdir(control);
  const script = `
    $ErrorActionPreference='Stop'
    $root=$args[0]
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    foreach($s in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    @{accountSid=$sid.Value;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Compress
  `;
  const runtime = JSON.parse((await ps(script, [control])).stdout.trim());
  const owner = { project, operationId: randomUUID(), workerId: randomUUID(),
    controllerIdentity: await processIdentity(process.pid) };
  const saved = await saveWorkerEngine({ source, control, project, operationId: owner.operationId });
  const journal = await createWorkerJournal(control, owner);
  t.after(() => journal.close());
  const controller = new AbortController();
  const command = { file: process.execPath, args: ['-e', code, ...args], cwd: project,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEST_LITERAL: '$HOME %n " space' } };
  const receipts = [];
  const operations = {
    async record(receipt) { await journal.record(receipt); receipts.push(receipt); },
    prepare: context => prepareWindowsWorker({ ...context, saved, command, pwsh, ...runtime }),
  };
  return { project, control, owner, saved, command, runtime, operations, receipts, controller,
    run: () => runOwnedWorker({ owner, signal: controller.signal }, operations) };
}

async function waitFile(file) {
  for (let index = 0; index < 400; index++) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  throw new Error('Native target did not start.');
}
const writing = `const fs=require('node:fs');fs.writeFileSync('writer','x');
  fs.writeFileSync('started','yes');setInterval(()=>fs.appendFileSync('writer','x'),10);`;

async function nativeOwners(f) {
  return JSON.parse((await ps(`
    $ErrorActionPreference='Stop'
    $worker=$args[1]
    $matches=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($args[0])" |
      Where-Object { $_.CommandLine -like "*$worker*" } |
      ForEach-Object {
        $p=[Diagnostics.Process]::GetProcessById($_.ProcessId)
        @{pid=$p.Id;identity="$($p.Id):$($p.StartTime.ToUniversalTime().Ticks)"}
      })
    ConvertTo-Json -InputObject $matches -Compress
  `, [String(process.pid), f.owner.workerId])).stdout.trim());
}

async function killNative(helper) {
  await ps(`
    $ErrorActionPreference='Stop'
    $p=[Diagnostics.Process]::GetProcessById([int]$args[0])
    if("$($p.Id):$($p.StartTime.ToUniversalTime().Ticks)" -cne $args[1]){throw 'Helper identity changed.'}
    $p.Kill()
    if(-not $p.WaitForExit(15000)){throw 'Helper exit timed out.'}
  `, [String(helper.pid), helper.identity]);
}

test('Windows saved engine connects Job identity to real admission and settlement receipts', async t => {
  const f = await fixture(t, 'process.stdout.write(process.env.TEST_LITERAL);process.stderr.write("err");');
  const result = await f.run();
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '$HOME %n " space');
  assert.equal(result.stderr, 'err');
  assert.deepEqual(f.receipts.map(r => r.phase), ['intent', 'owned', 'admitted', 'settled']);
  assert.equal(f.receipts[1].domain.kind, 'windows-job');
  assert.equal(f.receipts[1].domain.ownerIdentity, f.owner.controllerIdentity);
  assert.equal(f.receipts[1].domain.accountSid, f.runtime.accountSid);
  assert.equal((await readWorkerJournal(f.control, f.owner)).at(-1).phase, 'settled');
});

test('cancelled run cleans up through independent RPCs despite a pending command response', async t => {
  const f = await fixture(t, writing);
  const reason = new Error('cancel Windows target');
  const rejected = assert.rejects(f.run(), error => error === reason);
  await waitFile(path.join(f.project, 'started'));
  f.controller.abort(reason);
  await rejected;
  assert.equal(f.receipts.at(-1).phase, 'settled');
  const before = await readFile(path.join(f.project, 'writer'), 'utf8');
  await delay(300);
  assert.equal(await readFile(path.join(f.project, 'writer'), 'utf8'), before);
});

test('cancel after Job readiness never admits the actual command', async t => {
  const f = await fixture(t, writing);
  const record = f.operations.record;
  f.operations.record = async receipt => {
    await record(receipt);
    if (receipt.phase === 'owned') f.controller.abort(new Error('cancel before command'));
  };
  await assert.rejects(f.run(), /cancel before command/);
  assert.deepEqual(f.receipts.map(r => r.phase), ['intent', 'owned', 'settled']);
  await assert.rejects(readFile(path.join(f.project, 'started')), { code: 'ENOENT' });
});

test('root exit does not leave a detached descendant writing after settlement', async t => {
  const f = await fixture(t, `
    const {spawn}=require('node:child_process'),fs=require('node:fs');
    const c=spawn(process.execPath,['-e',${JSON.stringify(writing)}],{detached:true,stdio:'ignore'});
    c.unref();const timer=setInterval(()=>{if(fs.existsSync('started')){clearInterval(timer);process.exit(0)}},10);
  `);
  await f.run();
  const before = await readFile(path.join(f.project, 'writer'), 'utf8');
  await delay(300);
  assert.equal(await readFile(path.join(f.project, 'writer'), 'utf8'), before);
});

test('nonzero exit retains bounded binary-safe output and original command failure', async t => {
  const f = await fixture(t, `process.stdout.write(Buffer.alloc(20000,255));
    process.stderr.write('e'.repeat(2*1024*1024),()=>process.exit(7));`);
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'DEPLOYMENT_COMMAND_FAILED');
    assert.equal(error.result.exitCode, 7);
    assert.ok(Buffer.byteLength(error.result.stdout) <= 8192);
    assert.equal(Buffer.byteLength(error.result.stderr), 8192);
    return true;
  });
  assert.equal(f.receipts.at(-1).phase, 'settled');
});

test('argv remains literal and command input is captured before asynchronous preparation', async t => {
  const f = await fixture(t, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));',
    ['%PATH%', '$HOME', 'quotes " space', 'semi;colon']);
  const prepare = f.operations.prepare;
  f.operations.prepare = context => {
    const result = prepare(context);
    f.command.args[1] = 'process.exit(1)';
    return result;
  };
  assert.deepEqual(JSON.parse((await f.run()).stdout), ['%PATH%', '$HOME', 'quotes " space', 'semi;colon']);
});

test('wrong account session and missing explicit runtime are refused before command admission', async t => {
  const f = await fixture(t, writing);
  for (const mutation of [{ accountSid: 'S-1-5-18' }, { sessionId: -1 }, { pwsh: 'pwsh' }]) {
    await assert.rejects(prepareWindowsWorker({
      owner: f.owner, saved: f.saved, command: f.command, pwsh, ...f.runtime, ...mutation,
    }));
  }
  await assert.rejects(readFile(path.join(f.project, 'started')), { code: 'ENOENT' });
});

test('Node controller death terminates native handle owner and writers without authorizing reentry', {
  timeout: 60000,
}, async t => {
  const f = await fixture(t, writing);
  const childOwner = { ...f.owner, workerId: randomUUID() };
  const child = fork(new URL('./deployment-windows-controller-child.mjs', import.meta.url),
    [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Controller exit ${code}: ${stderr}`)));
  });
  child.send({ owner: childOwner, saved: f.saved, command: f.command,
    control: f.control, runtime: f.runtime, pwsh });
  const { owner } = await ready;
  await waitFile(path.join(f.project, 'started'));
  child.kill('SIGKILL');
  await exited;
  await delay(2000);
  const before = await readFile(path.join(f.project, 'writer'), 'utf8');
  await delay(400);
  assert.equal(await readFile(path.join(f.project, 'writer'), 'utf8'), before);
  assert.equal((await readWorkerJournal(f.control, owner)).at(-1).phase, 'admitted');
  await assert.rejects(createWorkerJournal(f.control, owner));
});

test('original native handle owner survives durable settlement and exits only during retirement', async t => {
  const f = await fixture(t, 'process.stdout.write("done");');
  const record = f.operations.record;
  let original;
  f.operations.record = async receipt => {
    await record(receipt);
    if (['owned', 'settled'].includes(receipt.phase)) {
      const owners = await nativeOwners(f);
      assert.equal(owners.length, 1);
      if (original) assert.deepEqual(owners[0], original);
      original = owners[0];
    }
  };
  await f.run();
  assert.deepEqual(await nativeOwners(f), []);
});

test('native owner death kills writers but remains blocked rather than claiming settlement', async t => {
  const f = await fixture(t, writing);
  const rejected = assert.rejects(f.run(), error => {
    assert.equal(error.recoveryAllowed, false);
    assert.equal(error.code, 'DEPLOYMENT_WORKER_UNSETTLED');
    return true;
  });
  await waitFile(path.join(f.project, 'started'));
  const owners = await nativeOwners(f);
  assert.equal(owners.length, 1);
  await killNative(owners[0]);
  await rejected;
  assert.equal(f.receipts.at(-1).phase, 'blocked');
  assert.ok(!f.receipts.some(receipt => receipt.phase === 'settled'));
  const before = await readFile(path.join(f.project, 'writer'), 'utf8');
  await delay(300);
  assert.equal(await readFile(path.join(f.project, 'writer'), 'utf8'), before);
});
