import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { acquireLock, releaseLock } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation, readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { readWorkerJournal } from '../scripts/deployment/worker-journal.mjs';

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
  return { project, control, lock, saved, operation, run };
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
