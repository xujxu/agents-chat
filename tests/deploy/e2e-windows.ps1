# End-to-end deployment test on Windows with a Scheduled Task. Run elevated from the repo root (CI only).
$ErrorActionPreference = 'Stop'
$Src = (Get-Location).Path
$T = 'C:\e2e'
$Root = "$T\deploy"
$Old = "$T\old"
$Port = 3000
$Task = 'Agents-Chat-Startup'
New-Item -ItemType Directory -Force $T | Out-Null

function Step($m) { Write-Host "`n=== $m ===" }
function Dump {
    Get-Content "$Root\state.json" -ErrorAction SilentlyContinue
    Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue | Format-List TaskName, State, @{n='Args';e={$_.Actions[0].Arguments}}, @{n='Dir';e={$_.Actions[0].WorkingDirectory}}
    foreach ($log in 'service-watchdog.log', 'start-service-child.log', 'start-service-child.err.log', 'server-error.log') {
        foreach ($dir in "$Root\shared\logs", "$Old\logs") {
            if (Test-Path "$dir\$log") { Write-Host "--- $dir\$log"; Get-Content "$dir\$log" -Tail 40 }
        }
    }
}
function Fail($m) { Write-Host "FAIL: $m"; Dump; exit 1 }
function Version {
    try { (Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 5).version } catch { 'down' }
}
function Wait-Version($expected, $seconds = 600) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $v = Version
        if ("$v" -eq "$expected") { return }
        Start-Sleep 3
    }
    Fail "expected version $expected, got $(Version)"
}
function Marker { node "$Src\tests\deploy\marker.mjs" @args; $LASTEXITCODE }
function State { Get-Content "$Root\state.json" -Raw | ConvertFrom-Json }
function Invoke-Script($name, [int]$expect, [hashtable]$rest = @{}) {
    & "$Src\scripts\$name.ps1" -ProjectDir $Root @rest
    if ($LASTEXITCODE -ne $expect) { Fail "$name $($rest | ConvertTo-Json -Compress) exited $LASTEXITCODE (expected $expect)" }
}

Step 'fixtures: Node 24 as the machine default'
$nodeDir = Split-Path (Get-Command node).Source
robocopy $nodeDir 'C:\Program Files\nodejs' /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail 'copying Node.js failed' }

Step 'fixtures: bare origin and test commits'
$commits = & bash tests/deploy/make-commits.sh ($Src -replace '\\', '/') "$T/origin.git" "$T/work"
if ($LASTEXITCODE -ne 0) { Fail 'make-commits failed' }
$C = @{}
foreach ($line in $commits) { $k, $v = $line -split '=', 2; $C[$k] = $v }

Step 'fixtures: main-style checkout running as the Scheduled Task'
git clone -q "$T/origin.git" $Old
"NEXTAUTH_SECRET=e2e-secret`nNEXTAUTH_URL=http://localhost:$Port" | Set-Content "$Old\.env.local"
Push-Location $Old
npm ci --no-audit --no-fund *> "$T\old-npm.log"
if ($LASTEXITCODE -ne 0) { Get-Content "$T\old-npm.log" -Tail 50; Fail 'old npm ci' }
Pop-Location
& "$Old\scripts\install-scheduled-task.ps1" -ProjectDir $Old -LogonType S4U -TriggerType AtStartup -Tunnel None -Port $Port
Start-ScheduledTask -TaskName $Task
Wait-Version '' 900
Marker write "$Old\.data\chats.db" m1 | Out-Null
$oldStatus = git -C $Old status --porcelain

Step '1. migrate the existing checkout'
Invoke-Script deploy 0 @{ ImportFrom = $Old }
Wait-Version $C.BASE
if ((Marker has "$Root\shared\.data\chats.db" m1) -ne 0) { Fail 'marker m1 missing after migration' }
if ("$(git -C $Old status --porcelain)" -ne "$oldStatus") { Fail 'old checkout changed' }
$t = Get-ScheduledTask -TaskName $Task
if ($t.Principal.LogonType -ne 'S4U') { Fail "logon type not kept: $($t.Principal.LogonType)" }
if ($t.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskBootTrigger') { Fail 'trigger not kept' }
if ($t.Actions[0].Arguments -notmatch '-Tunnel None') { Fail "tunnel mode not kept: $($t.Actions[0].Arguments)" }
if ($t.Actions[0].WorkingDirectory -ne "$Root\current") { Fail "task not re-pointed: $($t.Actions[0].WorkingDirectory)" }
if (-not (Get-ChildItem "$Root\backups\migration-*\$Task.xml")) { Fail 'old task not backed up' }

Step '2. upgrade (reusing dependencies)'
Invoke-Script update 0 @{ Revision = $C.V2; NoInstall = $true }
Wait-Version $C.V2

Step '4. a failing health check rolls back code and data'
Invoke-Script update 1 @{ Revision = $C.UNHEALTHY; NoInstall = $true; WaitSeconds = 90 }
if ((State).lastResult.outcome -ne 'rolled-back') { Fail 'expected rolled-back' }
Wait-Version $C.V2
if ((Marker has "$Root\shared\.data\chats.db" m1) -ne 0) { Fail 'marker m1 missing after rollback' }

Step '5. restore the previous release and its data'
Marker write "$Root\shared\.data\chats.db" m2 | Out-Null
Invoke-Script restore 2
Invoke-Script restore 0 @{ AcceptDataLoss = $true }
Wait-Version $C.BASE
if ((Marker has "$Root\shared\.data\chats.db" m1) -ne 0) { Fail 'marker m1 missing after restore' }
if ((Marker has "$Root\shared\.data\chats.db" m2) -eq 0) { Fail 'marker m2 should be gone after restore' }

Step '8. -RemoveTask keeps data'
Invoke-Script deploy 0 @{ RemoveTask = $true }
if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Fail 'task still registered' }
if ((Version) -ne 'down') { Fail 'app still running after -RemoveTask' }
if (-not (Test-Path "$Root\shared\.data\chats.db")) { Fail 'data removed' }

Dump
Write-Host 'Windows deployment E2E passed.'
