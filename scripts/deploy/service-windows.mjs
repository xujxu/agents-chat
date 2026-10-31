// Windows Scheduled Task adapter (driven through Windows PowerShell).
import fs from 'node:fs';
import path from 'node:path';
import { DeployError } from './state.mjs';
import { run } from './fsops.mjs';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;

function ps(script, { allowFail = false } = {}) {
  const res = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`],
  { capture: true, allowFail, step: 'service' });
  return res.stdout?.trim() ?? '';
}

export function createWindowsService({ name = 'Agents-Chat-Startup', root }) {
  const current = path.join(root, 'current');
  const task = `Get-ScheduledTask -TaskName ${q(name)}`;

  return {
    name,
    exists: () => ps(`[bool](Get-ScheduledTask -TaskName ${q(name)} -ErrorAction SilentlyContinue)`) === 'True',

    // Current task settings, so re-registration can keep them.
    settings() {
      const raw = ps(`$t = ${task}; [pscustomobject]@{
        userId = $t.Principal.UserId; logonType = $t.Principal.LogonType.ToString();
        trigger = $t.Triggers[0].CimClass.CimClassName; arguments = $t.Actions[0].Arguments;
        workingDirectory = $t.Actions[0].WorkingDirectory } | ConvertTo-Json -Compress`);
      const t = JSON.parse(raw);
      const arg = (re, fallback) => t.arguments?.match(re)?.[1] ?? fallback;
      return {
        userId: t.userId,
        logonType: t.logonType,
        triggerType: t.trigger === 'MSFT_TaskBootTrigger' ? 'AtStartup' : 'AtLogOn',
        tunnel: arg(/-Tunnel\s+(\w+)/i, 'DevTunnel'),
        port: Number(arg(/-Port\s+(\d+)/i, 3000)),
        watchdog: arg(/-File\s+"([^"]+)"/i, null),
        workingDirectory: t.workingDirectory,
      };
    },

    pointsInto(dir) {
      const wd = this.settings().workingDirectory;
      return Boolean(wd) && path.resolve(wd).toLowerCase() === path.resolve(dir).toLowerCase();
    },

    install({ userId, logonType, triggerType, tunnel, port }) {
      if (!['Interactive', 'S4U'].includes(logonType)) {
        throw new DeployError(`Unsupported task logon type ${logonType}; use Interactive or S4U.`, 2, 'preflight');
      }
      const script = path.join(current, 'scripts', 'install-scheduled-task.ps1');
      ps(`& ${q(script)} -TaskName ${q(name)} -ProjectDir ${q(current)} ${userId ? `-UserId ${q(userId)}` : ''} ` +
        `-LogonType ${q(logonType)} -TriggerType ${q(triggerType)} -Tunnel ${q(tunnel)} -Port ${Number(port)} | Out-Null; ` +
        `Disable-ScheduledTask -TaskName ${q(name)} | Out-Null`);
    },

    adopt(options) {
      this.install(options);
    },

    backup(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.xml`), ps(`Export-ScheduledTask -TaskName ${q(name)}`), 'utf8');
    },

    restore(dir) {
      const xml = path.join(dir, `${name}.xml`);
      ps(`Register-ScheduledTask -TaskName ${q(name)} -Xml (Get-Content -Raw ${q(xml)}) -Force | Out-Null`);
    },

    remove() {
      this.stop();
      ps(`Unregister-ScheduledTask -TaskName ${q(name)} -Confirm:$false`);
    },

    // Disable triggers, kill the watchdog tree for this task, stop the task, free the port.
    stop() {
      const { watchdog, port } = this.settings();
      ps(`Disable-ScheduledTask -TaskName ${q(name)} | Out-Null
        $w = ${q(watchdog ?? '')}
        if ($w) {
          Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($w.ToLower()) } |
            ForEach-Object { & taskkill.exe /T /F /PID $_.ProcessId 2>&1 | Out-Null }
        }
        Stop-ScheduledTask -TaskName ${q(name)} -ErrorAction SilentlyContinue
        Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue |
          Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ } |
          ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`);
    },

    start() {
      ps(`Enable-ScheduledTask -TaskName ${q(name)} | Out-Null; Start-ScheduledTask -TaskName ${q(name)}`);
    },
  };
}
