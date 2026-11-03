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
