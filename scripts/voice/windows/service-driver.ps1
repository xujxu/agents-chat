param(
    [ValidateSet('preflight','probe','cleanup')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Project
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Agents-Chat-Startup'
$Watchdog = Join-Path $Project 'scripts\service-watchdog.ps1'
function Get-Listeners {
    return @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}
function Get-OwnedTask {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ($task.Actions.Count -ne 1 -or $task.Actions[0].WorkingDirectory -ine $Project -or
        $task.Actions[0].Arguments.IndexOf($Watchdog, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Refusing foreign task configuration.'
    }
    if ($task.Actions[0].Arguments -notmatch '(?i)(?:^|\s)-NoTunnel(?:\s|$)') { throw 'Missing local task mode.' }
    return $task
}
function Get-OwnedWatchdogs {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq 'powershell.exe' -and $_.CommandLine -and
        $_.CommandLine.IndexOf($Watchdog, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}
function Stop-OwnedTree([int]$ProcessId) {
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId")) {
        Stop-OwnedTree ([int]$child.ProcessId)
    }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($process) { Stop-Process -Id $ProcessId -Force -ErrorAction Stop }
}
if ($Action -eq 'preflight') {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Task already exists.' }
    if ((Get-Listeners).Count) { throw 'App port already occupied.' }
    @{isolated=$true} | ConvertTo-Json -Compress
} elseif ($Action -eq 'probe') {
    $task = Get-OwnedTask
    if ($task.State -ne 'Running') { throw 'Task is not running.' }
    $watchdogs = @(Get-OwnedWatchdogs)
    if ($watchdogs.Count -ne 1) { throw 'Expected one owned watchdog.' }
    $watchdogPid = [int]$watchdogs[0].ProcessId
    $listeners = @(Get-Listeners)
    if ($listeners.Count -ne 1) { throw 'Expected one app listener.' }
    $listenerPid = [int]$listeners[0]
    $cursor = $listenerPid
    $ancestry = @()
    while ($cursor -and $cursor -ne $watchdogPid -and $ancestry.Count -lt 20) {
        $ancestry += $cursor
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor"
        if (-not $process) { throw 'App process disappeared.' }
        $cursor = [int]$process.ParentProcessId
    }
    if ($cursor -ne $watchdogPid) { throw 'Listener is not a task-owned descendant.' }
    $principal = $task.Principal.UserId
    $sid = if ($principal -match '^S-1-') { $principal } else {
        ([Security.Principal.NTAccount]::new($principal)).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    if ($sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Unexpected task account.' }
    foreach ($scope in @('User','Machine')) {
        foreach ($key in @('GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN')) {
            if ([Environment]::GetEnvironmentVariable($key, $scope)) { throw 'Persisted GitHub credential in task environment.' }
        }
    }
    $log = [IO.File]::ReadAllText((Join-Path $Project 'logs\service-watchdog.log'))
    if (-not $log.Contains('Acquisition token variables removed from application launch environment.')) {
        throw 'No token-isolated app launch evidence.'
    }
    $temporary = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory |
        Where-Object { $_.Name.StartsWith('agents-chat-voice-') } | Select-Object -ExpandProperty Name | Sort-Object)
    @{
        manager='scheduled-task'; project=$Project; active=$true; owned=$true
        pid=$watchdogPid; listenerPid=$listenerPid; identity=$sid
        activation=("$watchdogPid/" + $watchdogs[0].CreationDate.ToUniversalTime().ToString('o'))
        credentialsAbsent=$true; temporaryDirectories=$temporary
        credentialEvidence='No persisted User/Machine tokens; watchdog clears process tokens before app launch (not a remote PEB inspection)'
        logonType=$task.Principal.LogonType.ToString(); arguments=$task.Actions[0].Arguments
        ancestry=$ancestry
    } | ConvertTo-Json -Depth 5 -Compress
} else {
    $receipt = [IO.File]::ReadAllText((Join-Path $Project '.service-e2e-owner.json')) | ConvertFrom-Json
    if ($receipt.project -ine $Project) { throw 'Missing ownership receipt.' }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $null = Get-OwnedTask
        $watchdogs = @(Get-OwnedWatchdogs)
        New-Item -ItemType File -Path (Join-Path $Project '.service-stop') -Force | Out-Null
        foreach ($watchdog in $watchdogs) { Stop-OwnedTree ([int]$watchdog.ProcessId) }
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    }
    if ((Get-Listeners).Count) { throw 'Owned app listener remains after cleanup.' }
    @{removed=$true;portClosed=$true} | ConvertTo-Json -Compress
}
