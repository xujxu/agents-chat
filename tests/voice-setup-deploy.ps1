param([Parameter(Mandatory=$true)][string]$ProjectDir, [Parameter(Mandatory=$true)][string]$Scenario)
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $ProjectDir '.env.local'
$original = [IO.File]::ReadAllBytes($envFile)
$global:Starts = 0
$global:Stops = 0
$global:PromptCount = 0
$global:Pulls = 0
$global:RegistrationUser = $null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$global:FakeTask = [pscustomobject]@{
    Principal = [pscustomobject]@{UserId=$sid; LogonType='Interactive'}
    Actions = @([pscustomobject]@{Execute='old.exe'; Arguments=''; WorkingDirectory=$ProjectDir})
    Triggers = @([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskLogonTrigger'}})
    State = 'Ready'
}
function npm { $global:LASTEXITCODE = 0 }
function git {
    $global:Pulls++
    $file = Join-Path $ProjectDir 'scripts\deploy.ps1'
    $source = [IO.File]::ReadAllText($file)
    $source = $source.Replace("Write-Step 'Installing npm dependencies...'",
        "[IO.File]::WriteAllText((Join-Path `$ProjectDir 'fresh-entry.txt'), 'yes'); Write-Step 'Installing npm dependencies...'")
    [IO.File]::WriteAllText($file, $source)
    $global:LASTEXITCODE = 0
}
function Get-ScheduledTask { return $global:FakeTask }
function Get-ScheduledTaskInfo { return [pscustomobject]@{LastRunTime=[datetime]::MinValue;LastTaskResult=0} }
function Stop-ScheduledTask { $global:Stops++; $global:FakeTask.State='Ready' }
function Start-ScheduledTask { $global:Starts++; $global:FakeTask.State='Running' }
function Unregister-ScheduledTask { throw 'Task must not be deleted before replacement.' }
function Get-NetTCPConnection { return @() }
function Stop-Process { throw 'Test must not stop real processes.' }
function Start-Sleep {}
function Invoke-WebRequest {
    if ($Scenario -in @('recover', 'tamper') -and $global:Starts -eq 1) {
        if ($Scenario -eq 'tamper') { [IO.File]::WriteAllText($envFile, "VOICE_ENABLED=0`nEDIT=admin`n") }
        return [pscustomobject]@{StatusCode=500}
    }
    return [pscustomobject]@{StatusCode=200}
}
function Read-Host { $global:PromptCount++; return '' }

$installer = @'
param($TaskName, $ProjectDir, $UserId, $LogonType, $TriggerType)
$global:RegistrationUser = $UserId
$global:LASTEXITCODE = 0
'@
[IO.File]::WriteAllText((Join-Path $ProjectDir 'scripts\install-scheduled-task.ps1'), $installer)

if ($Scenario -eq 'menu') {
    . (Join-Path $ProjectDir 'scripts\voice\windows\configure.ps1')
    Invoke-VoiceConfiguration -ProjectDir $ProjectDir -Interactive $true
    Invoke-VoiceConfiguration -ProjectDir $ProjectDir -Interactive $true
    if ($global:PromptCount -ne 2) { throw 'Interactive upgrades did not both prompt.' }
    Invoke-VoiceConfiguration -ProjectDir $ProjectDir -NonInteractive -Interactive $true
    if ($global:PromptCount -ne 2) { throw 'Unattended upgrade prompted.' }
} else {
    $arguments = @{ProjectDir=$ProjectDir;SkipGitPull=$true;WaitSeconds=1;NonInteractive=$true}
    if ($Scenario -eq 'reentry') {
        [IO.File]::WriteAllText((Join-Path $ProjectDir '.git'), 'fixture')
        $arguments.Remove('SkipGitPull')
    }
    if ($Scenario -in @('disable', 'recover', 'tamper', 'no-wait')) { $arguments.VoiceModel='disabled' }
    if ($Scenario -eq 'no-wait') { $arguments.NoWait=$true }
    $failed = $false
    try { & (Join-Path $ProjectDir 'scripts\deploy.ps1') @arguments }
    catch { $failed = $true }
    if ($failed -ne ($Scenario -in @('recover', 'tamper', 'no-wait'))) { throw "Unexpected deployment outcome: $Scenario" }
    if ($Scenario -eq 'no-wait') {
        if ($global:Starts -or $global:Stops) { throw 'NoWait voice change touched the running task.' }
    } else {
        if ($global:RegistrationUser -ne $sid) { throw 'Task identity was not preserved.' }
        if ($global:Starts -lt 1) { throw 'Deployment never activated.' }
    }
    if ($Scenario -eq 'recover' -and $global:Starts -ne 2) { throw 'Recovery did not restart the prior configuration.' }
    if ($Scenario -eq 'reentry' -and ($global:Pulls -ne 1 -or -not [IO.File]::Exists((Join-Path $ProjectDir 'fresh-entry.txt')))) {
        throw 'Upgrade did not re-enter freshly pulled script exactly once.'
    }
}
$current = [IO.File]::ReadAllBytes($envFile)
if ($Scenario -eq 'disable') {
    if ([IO.File]::ReadAllText($envFile) -notmatch 'VOICE_ENABLED=0') { throw 'Explicit disable was not persisted.' }
} elseif ($Scenario -eq 'tamper') {
    if ([IO.File]::ReadAllText($envFile) -notmatch 'EDIT=admin') { throw 'Admin edit was overwritten.' }
} elseif ([Convert]::ToBase64String($current) -ne [Convert]::ToBase64String($original)) { throw 'Prior configuration bytes were changed.' }
$receipts = @([IO.Directory]::GetFiles($ProjectDir, '.voice-setup-receipt.*'))
if (($Scenario -eq 'tamper' -and $receipts.Count -ne 1) -or ($Scenario -ne 'tamper' -and $receipts.Count -ne 0)) {
    throw 'Unexpected retained recovery receipts.'
}
Write-Host "Windows deployment scenario passed: $Scenario"
