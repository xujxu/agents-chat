import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectWindowsTaskDefinition } from '../scripts/deployment/windows-task-inspection.mjs';

const execute = promisify(execFile);
const native = { skip: process.platform !== 'win32' };
const ps = async (code, args = []) => {
  const file = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execute(file, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop'\n$args=@(${args.map(arg => `'${arg.replaceAll("'", "''")}'`).join(',')})\n${code}`,
      'utf16le').toString('base64')], { timeout: 30000, maxBuffer: 65536 });
};

async function fixture(t, { disabled = false } = {}) {
  const taskName = `Agents-Chat-Test-${randomUUID()}`;
  t.after(async () => {
    await ps(`
      $task=Get-ScheduledTask -TaskName $args[0] -ErrorAction SilentlyContinue
      if ($task) {
        Stop-ScheduledTask -TaskName $args[0] -ErrorAction Stop
        Unregister-ScheduledTask -TaskName $args[0] -Confirm:$false -ErrorAction Stop
      }
    `, [taskName]);
  });
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'project with spaces');
  await mkdir(path.join(project, 'scripts'), { recursive: true });
  const watchdog = path.join(project, 'scripts', 'service-watchdog.ps1');
  await writeFile(watchdog, 'param([switch]$NoTunnel)\nStart-Sleep -Seconds 30\n');
  const input = { taskName, project: await realpath(project), watchdog: await realpath(watchdog) };
  await ps(`
    $exe=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    $action=New-ScheduledTaskAction -Execute $exe -Argument ("-NoProfile -ExecutionPolicy Bypass -File \`""+$args[2]+"\`" -NoTunnel") -WorkingDirectory $args[1]
    $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
    $trigger=New-ScheduledTaskTrigger -AtStartup
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $args[0] -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
    if ($args[3] -eq 'disabled') { Disable-ScheduledTask -TaskName $args[0] | Out-Null }
  `, [taskName, input.project, input.watchdog, disabled ? 'disabled' : 'ready']);
  return input;
}

for (const disabled of [false, true]) {
  test(`Windows task definition observes ${disabled ? 'disabled' : 'ready'} policy without granting process ownership`, native, async t => {
    const input = await fixture(t, { disabled });
    const before = (await ps('Export-ScheduledTask -TaskName $args[0]', [input.taskName])).stdout;
    const observed = await inspectWindowsTaskDefinition(input);
    assert.equal(observed.status, 'definition-observed');
    assert.equal(observed.runtimeAuthority, false);
    assert.equal(observed.identity.taskName, input.taskName);
    assert.equal(observed.identity.taskPath, '\\');
    assert.equal(observed.identity.enabled, !disabled);
    assert.equal(observed.identity.state, disabled ? 'Disabled' : 'Ready');
    assert.deepEqual(observed.identity.instances, []);
    assert.match(observed.identity.principalSid, /^S-1-/);
    assert.equal(observed.identity.options.TaskLogonType, 'S4U');
    assert.equal(observed.identity.options.TaskTriggerType, 'AtStartup');
    assert.equal(observed.identity.options.NoTunnel, true);
    assert.throws(() => { observed.identity.options.NoTunnel = false; }, TypeError);
    await observed.check();
    assert.equal((await ps('Export-ScheduledTask -TaskName $args[0]', [input.taskName])).stdout, before);
  });
}

test('Windows definition authority refuses description changes instead of silently refreshing', native, async t => {
  const input = await fixture(t);
  const observed = await inspectWindowsTaskDefinition(input);
  await ps('Set-ScheduledTask -TaskName $args[0] -Description "changed fixture definition" | Out-Null', [input.taskName]);
  await assert.rejects(observed.check(), { code: 'DEPLOYMENT_WINDOWS_TASK_CHANGED' });
});

test('Windows definition observation refuses foreign actions, missing tasks and unsupported task names', native, async t => {
  const input = await fixture(t);
  const observed = await inspectWindowsTaskDefinition(input);
  await ps(`
    $action=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit 0' -WorkingDirectory $args[1]
    Set-ScheduledTask -TaskName $args[0] -Action $action | Out-Null
  `, [input.taskName, input.project]);
  await assert.rejects(inspectWindowsTaskDefinition(input), { code: 'DEPLOYMENT_WINDOWS_TASK_UNSUPPORTED' });
  await assert.rejects(observed.check(), { code: 'DEPLOYMENT_WINDOWS_TASK_CHANGED' });
  await assert.rejects(inspectWindowsTaskDefinition({ ...input, taskName: `${input.taskName}-missing` }),
    { code: 'DEPLOYMENT_WINDOWS_TASK_UNSUPPORTED' });
  for (const taskName of ['..\\foreign', '\\subfolder\\task', '', 'task\nname']) {
    await assert.rejects(inspectWindowsTaskDefinition({ ...input, taskName }),
      { code: 'DEPLOYMENT_WINDOWS_TASK_UNSUPPORTED' });
  }
});

test('Windows task observation detects actual task startup and never equates scheduler state to application health', native, async t => {
  const input = await fixture(t);
  const observed = await inspectWindowsTaskDefinition(input);
  await ps(`
    Start-ScheduledTask -TaskName $args[0]
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    while ((Get-ScheduledTask -TaskName $args[0]).State -ne 'Running') {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Inert Scheduled Task did not start' }
      Start-Sleep -Milliseconds 100
    }
  `, [input.taskName]);
  await assert.rejects(observed.check(), { code: 'DEPLOYMENT_WINDOWS_TASK_CHANGED' });
});

test('cancelled Windows task observation preserves the supplied reason before native work', native, async t => {
  const input = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('cancelled task observation');
  controller.abort(reason);
  await assert.rejects(inspectWindowsTaskDefinition({ ...input, signal: controller.signal }), error => error === reason);
});
