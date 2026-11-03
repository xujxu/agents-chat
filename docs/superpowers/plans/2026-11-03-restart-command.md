# Restart Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `scripts\restart.ps1`, a single command that restarts the Windows
Scheduled Task service so `shared\.env.local` changes take effect. Linux keeps
using `sudo systemctl restart agents-chat`.

**Architecture:** `restart.ps1` is a standalone PowerShell script.

- It reads the port and watchdog path from the task's action arguments.
- It stops the service the same way `scripts/deploy/service-windows.mjs`
  `stop()` does: disable the task, kill the watchdog process tree, stop the
  task, and free the port.
- It then enables and starts the task, and polls `/api/health`.

There is no Node or core changes. Spec:
`docs/superpowers/specs/2026-11-03-restart-command-design.md`.

**Tech Stack:** Windows PowerShell 5.1, ScheduledTasks and NetTCPIP cmdlets,
`taskkill.exe`.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `scripts/restart.ps1` | Create | Restart the Scheduled Task service and wait for health |
| `tests/deploy/e2e-windows.ps1` | Modify (new step 6, between steps 5 and 8) | E2E coverage for `restart.ps1` |
| `docs/update-windows.md` | Modify ("Change settings without updating", around line 85) | User docs |
| `docs/deploy-windows.md` | Modify (section 7, tunnel switch, around line 170; section 8, day-to-day commands, around line 190) | User docs |
| `README.md` | Modify (Windows command block, around line 150) | Command reference |

Facts the implementer needs:

- The task action arguments look like this. `install-scheduled-task.ps1:40`
  writes them:
  `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<root>\current\scripts\service-watchdog.ps1" -Tunnel DevTunnel -Port 3000`
- The watchdog (`scripts/service-watchdog.ps1`) launches `start.ps1` as a child
  process. `start.ps1` launches `node` and `devtunnel` as children. Killing the
  watchdog with `taskkill /T` therefore kills the whole tree.
- The watchdog logs to `<watchdog dir>\..\logs\service-watchdog.log`.
- Under Windows PowerShell 5.1 with `$ErrorActionPreference = 'Stop'`,
  redirecting a native command's stderr (`2>&1`) can throw
  `NativeCommandError`. Run `taskkill` through `cmd /c` with the redirection
  inside the cmd string.
- The E2E test runs only in CI (`.github/workflows/deploy.yml`, `windows-e2e`
  job). It needs an elevated shell and writes to `C:\e2e`. Do not run it on a
  developer machine.

---

### Task 1: E2E step for restart (test first)

**Files:**
- Modify: `tests/deploy/e2e-windows.ps1`. Insert the new step between the end of
  step 5 (the line
  `if ((Marker has "$Root\shared\.data\chats.db" m2) -eq 0) { Fail 'marker m2 should be gone after restore' }`)
  and `Step '8. -RemoveTask keeps data'`.

- [ ] **Step 1: Add the E2E step**

Insert this block after the step 5 marker line and before step 8:

```powershell

Step '6. restart.ps1 replaces the watchdog and the app comes back'
function Watchdogs {
    @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -match 'service-watchdog\.ps1' } |
        ForEach-Object { $_.ProcessId })
}
$before = Watchdogs
if (-not $before) { Fail 'no watchdog running before restart' }
& "$Src\scripts\restart.ps1" -WaitSeconds 180
if ($LASTEXITCODE -ne 0) { Fail "restart.ps1 exited $LASTEXITCODE" }
Wait-Version $C.BASE 60
$after = Watchdogs
if (-not $after) { Fail 'no watchdog running after restart' }
if ($after | Where-Object { $before -contains $_ }) { Fail "old watchdog still running: $before / $after" }
if ((Get-ScheduledTask -TaskName $Task).State -eq 'Disabled') { Fail 'task left disabled' }
```

- [ ] **Step 2: Confirm the step fails without the script**

Run:
`powershell -NoProfile -Command "& { & '.\scripts\restart.ps1' } 2>&1 | Select-Object -First 1"`

Expected: an error saying `.\scripts\restart.ps1` is not recognized. This
shows the new E2E step would fail until Task 2 is done.

- [ ] **Step 3: Parse-check the test file**

Run:
`powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path tests\deploy\e2e-windows.ps1), [ref]$null, [ref]$e) | Out-Null; $e.Count"`

Expected: `0`

- [ ] **Step 4: Commit**

```powershell
git add tests/deploy/e2e-windows.ps1
git commit -m "test(deploy): e2e step for restart.ps1`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `scripts/restart.ps1`

**Files:**
- Create: `scripts/restart.ps1`

- [ ] **Step 1: Write the script**

```powershell
# Restarts the Agents-Chat Scheduled Task so changes to shared\.env.local take effect.
# Run from an elevated PowerShell. On Linux use: sudo systemctl restart agents-chat
param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [int]$WaitSeconds = 60
)
$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'restart.ps1 must run from an elevated PowerShell.'
    exit 2
}
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Scheduled Task '$TaskName' not found."
    exit 2
}

# Port and watchdog path come from the installed task so they cannot drift.
$taskArgs = "$($task.Actions[0].Arguments)"
$port = if ($taskArgs -match '-Port\s+(\d+)') { [int]$Matches[1] } else { 3000 }
$watchdog = if ($taskArgs -match '-File\s+"([^"]+)"') { $Matches[1] } else { $null }

Write-Host "Stopping $TaskName (port $port)..."
Disable-ScheduledTask -TaskName $TaskName | Out-Null
if ($watchdog) {
    $needle = $watchdog.ToLower()
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
        Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) } |
        ForEach-Object { cmd.exe /c "taskkill /T /F /PID $($_.ProcessId) >nul 2>&1" }
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ } |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

Write-Host "Starting $TaskName..."
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName

if ($WaitSeconds -le 0) {
    Write-Host "Agents-Chat restart started (port $port)."
    exit 0
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -eq 200) {
            Write-Host "Agents-Chat restarted (port $port, healthy)."
            exit 0
        }
    } catch { }
    Start-Sleep -Seconds 2
}

$log = if ($watchdog) { Join-Path (Split-Path (Split-Path $watchdog)) 'logs\service-watchdog.log' } else { 'shared\logs\service-watchdog.log' }
Write-Host "Agents-Chat did not become healthy within $WaitSeconds s. The task keeps retrying; see $log"
exit 1
```

- [ ] **Step 2: Parse-check the script**

Run:
`powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path scripts\restart.ps1), [ref]$null, [ref]$e) | Out-Null; $e.Count"`

Expected: `0`

- [ ] **Step 3: Check the non-elevated guard**

Run from a normal, non-elevated shell:
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart.ps1; "exit=$LASTEXITCODE"`

Expected: `restart.ps1 must run from an elevated PowerShell.` and `exit=2`.

- [ ] **Step 4: Manually verify on the live deployment (elevated, with a UAC prompt)**

Run:

```powershell
Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',"& 'C:\Users\xujiang2\wa\src\agents-chat\scripts\restart.ps1' *> `"$env:TEMP\restart-check.log`"; `"exit=`$LASTEXITCODE`" | Add-Content `"$env:TEMP\restart-check.log`""
Get-Content "$env:TEMP\restart-check.log"
```

Expected:

- `Stopping Agents-Chat-Startup (port 3000)...`
- `Starting Agents-Chat-Startup...`
- `Agents-Chat restarted (port 3000, healthy).`
- `exit=0`

Then confirm that `Invoke-RestMethod https://agents-chat-3000.inc1.devtunnels.ms/api/health`
returns `ok`. Allow about 30 seconds for the tunnel.

- [ ] **Step 5: Commit**

```powershell
git add scripts/restart.ps1
git commit -m "feat(deploy): restart.ps1 to restart the Windows service`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Documentation

**Files:**
- Modify: `docs/update-windows.md` (around lines 85–95)
- Modify: `docs/deploy-windows.md` (around lines 168–175 and 186–193)
- Modify: `README.md` (Windows command block, around lines 147–150)

- [ ] **Step 1: `docs/update-windows.md`, "Change settings without updating"**

Replace:

````markdown
After editing `C:\agents-chat\shared\.env.local`, restart the app. Quick restart
(elevated PowerShell):

```powershell
Stop-ScheduledTask -TaskName Agents-Chat-Startup
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
Start-ScheduledTask -TaskName Agents-Chat-Startup
```
````

with:

````markdown
After editing `C:\agents-chat\shared\.env.local`, restart the app (elevated
PowerShell):

```powershell
C:\agents-chat\current\scripts\restart.ps1
```

It stops the Scheduled Task and everything it started (watchdog, app and
tunnel), starts it again, and waits up to 60 seconds for `/api/health`. The
exit code is 0 when the app is healthy, 1 when it is not healthy yet (check
`shared\logs\service-watchdog.log`), and 2 when the shell is not elevated or
the task is missing. Use `-WaitSeconds 0` to skip the wait and `-TaskName` for
a non-default task name.
````

Keep the "Or rebuild the running commit…" paragraph that follows.

- [ ] **Step 2: `docs/deploy-windows.md`, section 7 tunnel switch**

Replace:

```powershell
C:\agents-chat\current\scripts\install-scheduled-task.ps1 -Tunnel DevTunnel -Port 3000
Stop-ScheduledTask -TaskName Agents-Chat-Startup
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
Start-ScheduledTask -TaskName Agents-Chat-Startup
```

with:

```powershell
C:\agents-chat\current\scripts\install-scheduled-task.ps1 -Tunnel DevTunnel -Port 3000
C:\agents-chat\current\scripts\restart.ps1
```

- [ ] **Step 3: `docs/deploy-windows.md`, section 8 day-to-day commands**

In the code block, after the `restore.ps1` line, add:

```powershell
C:\agents-chat\current\scripts\restart.ps1                      # restart after editing shared\.env.local
```

- [ ] **Step 4: `README.md`, Windows command block**

Before the `# Rebuild the current commit, or remove the Scheduled Task` comment,
add:

```powershell
# Restart after editing shared\.env.local (Linux: sudo systemctl restart agents-chat)
C:\agents-chat\current\scripts\restart.ps1

```

In the Linux block that contains `sudo systemctl status agents-chat`, add this
line after it:

```bash
sudo systemctl restart agents-chat   # after editing shared/.env.local
```

- [ ] **Step 5: Check for leftover manual restart instructions**

Run:
`Select-String -Path docs\*.md,README.md -Pattern 'Stop-ScheduledTask'`

Expected: no matches. Line 171 of `docs/deploy-windows.md` was the tunnel
switch block replaced in Step 2.

- [ ] **Step 6: Commit**

```powershell
git add docs/update-windows.md docs/deploy-windows.md README.md
git commit -m "docs: document restart.ps1 and systemctl restart`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: CI verification

- [ ] **Step 1: Run the deploy unit tests (regression check)**

Run: `node --test tests/deploy/*.test.mjs`

Expected: all tests pass. No Node code changed.

- [ ] **Step 2: Push and watch the Windows E2E job**

```powershell
git push
gh run list --workflow deploy.yml --branch feat/simple-deploy --limit 1
gh run watch <run-id> --exit-status
```

Expected: the `windows-e2e` job passes and its log shows
`=== 6. restart.ps1 replaces the watchdog and the app comes back ===` followed by
`Agents-Chat restarted (port 3000, healthy).`
