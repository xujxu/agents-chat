import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { acceptOperation } from './deployment-fixture.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

const [control, project, source, runtimeJson] = process.argv.slice(2);
try {
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
  const runtime = runtimeJson ? JSON.parse(runtimeJson) : null;
  if (runtime && process.platform === 'win32') {
    const script = `
      $ErrorActionPreference='Stop'
      $root='${control.replaceAll("'", "''")}'
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach($entry in @((Get-Item -LiteralPath $root)) + @(Get-ChildItem -LiteralPath $root -Recurse)){
        $acl=Get-Acl -LiteralPath $entry.FullName
        $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
        foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
        foreach($s in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
          if($entry.PSIsContainer){
            $rule=[Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
          }else{$rule=[Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow')}
          $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $entry.FullName -AclObject $acl
      }
    `;
    await promisify(execFile)(runtime.pwsh,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 30000, maxBuffer: 4096 });
  }
  const operation = await createWorkerOperation({ control, lock, saved });
  if (runtime) {
    await operation.run({
      workerId: randomUUID(), runtime,
      command: { file: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync("native-completed","yes")'],
        cwd: project, env: Object.fromEntries(Object.entries(process.env)
          .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) },
    });
  }
  await operation.seal();
  await acceptOperation(control, lock);
  const unlink = fs.unlink;
  fs.unlink = async file => {
    await unlink(file);
    if (path.dirname(file) === saved.directory) {
      process.send({ lock, saved });
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  };
  syncBuiltinESMExports();
  await operation.retire();
  throw new Error('Retirement crash fixture unexpectedly completed.');
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
}
