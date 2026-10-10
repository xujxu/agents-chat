param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][int]$OwnerPid,
    [Parameter(Mandatory)][string]$OwnerIdentity,
    [Parameter(Mandatory)][guid]$Generation,
    [ValidateSet('Inspect', 'Stop', 'KillPublisher', 'AwaitStopped')][string]$Mode = 'Inspect',
    [int]$PublisherPid = 0,
    [string]$PublisherIdentity = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @(
    (Join-Path $source 'WindowsWorkerJob.cs'), (Join-Path $source 'WindowsRuntimeDomain.cs'),
    (Join-Path $source 'WindowsRuntimePipe.cs'), (Join-Path $source 'WindowsRuntimeControl.cs'))
. (Join-Path $source 'windows-task-owner-binding.ps1')
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$task = $scheduler.GetFolder('\').GetTask($TaskName)
if ($Mode -cin @('Stop', 'AwaitStopped') -and $PublisherPid -gt 0) {
    $publisher = $null
    try { $publisher = [Diagnostics.Process]::GetProcessById($PublisherPid) }
    catch { if ($_.Exception.GetBaseException() -isnot [ArgumentException]) { throw } }
    if ($null -ne $publisher) {
        try {
            $null = $publisher.Handle
            if ("$PublisherPid`:$($publisher.StartTime.ToUniversalTime().Ticks)" -ceq $PublisherIdentity -and
                -not $publisher.WaitForExit(15000)) { throw 'Original first publisher did not exit after actor death.' }
        } finally { $publisher.Dispose() }
    }
}
if ($Mode -ceq 'AwaitStopped') {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($task.GetInstances(0).Count -ne 0) {
        if ($deadline.ElapsedMilliseconds -ge 30000) { throw 'Guarded first runtime survived original actor death.' }
        Start-Sleep -Milliseconds 100
    }
}
if ($Mode -cin @('Stop', 'AwaitStopped') -and $task.GetInstances(0).Count -eq 0) {
    $identity = $null
    try { $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($OwnerPid) }
    catch { if ($_.Exception.GetBaseException() -isnot [ArgumentException]) { throw } }
    if ($identity -ceq $OwnerIdentity) {
        throw 'Original owner is still running without its task instance.'
    }
    [Console]::Out.WriteLine((@{
        status='already-stopped'; enabled=[bool]$task.Enabled; instances=0
    } | ConvertTo-Json -Compress))
    exit 0
}
$binding = Get-AgentsChatTaskOwnerBinding -TaskName $TaskName -OwnerPid $OwnerPid `
    -OwnerIdentity $OwnerIdentity -Definition ([string]$task.Xml) `
    -SecurityDescriptor ([string]$task.GetSecurityDescriptor(7))
if ($Mode -ceq 'KillPublisher') {
    if ($PublisherPid -lt 1 -or $PublisherIdentity -cnotmatch "^$PublisherPid`:[1-9][0-9]*$") {
        throw 'An explicit original publisher identity is required.'
    }
    $publisher = [Diagnostics.Process]::GetProcessById($PublisherPid)
    try {
        $null = $publisher.Handle
        if ($publisher.HasExited -or "$PublisherPid`:$($publisher.StartTime.ToUniversalTime().Ticks)" -cne $PublisherIdentity -or
            $publisher.MainModule.FileName -ine [string]$task.Definition.Actions.Item(1).Path) {
            throw 'Original first publisher identity or image differs.'
        }
        $publisher.Kill()
        if (-not $publisher.WaitForExit(15000)) { throw 'Original first publisher did not terminate.' }
        [Console]::Out.WriteLine('{"status":"publisher-terminated"}')
    } finally { $publisher.Dispose() }
    exit 0
}
if ($Mode -ceq 'Inspect') {
    $triggers = @(for ($index = 1; $index -le $task.Definition.Triggers.Count; $index++) {
        $trigger = $task.Definition.Triggers.Item($index)
        @{ type=[int]$trigger.Type; enabled=[bool]$trigger.Enabled }
    })
    $lease = [Deployment.WindowsRuntimeControl]::Exchange($Generation, $OwnerPid, $OwnerIdentity, 'lease', 15000)
    $domain = [Deployment.WindowsRuntimeControl]::Exchange($Generation, $OwnerPid, $OwnerIdentity, 'observe', 15000) | ConvertFrom-Json
    [Console]::Out.WriteLine((@{
        binding=$binding; lease=$lease; domain=$domain; definition=[string]$task.Xml
        securityDescriptor=[string]$task.GetSecurityDescriptor(7)
        triggers=$triggers
        restart=@{
            count=[int]$task.Definition.Settings.RestartCount
            intervalSeconds=[Xml.XmlConvert]::ToTimeSpan([string]$task.Definition.Settings.RestartInterval).TotalSeconds
        }
    } | ConvertTo-Json -Depth 5 -Compress))
} else {
    $task.Enabled = $false
    $owner = [Diagnostics.Process]::GetProcessById($OwnerPid)
    try {
        $null = $owner.Handle
        $stopped = [Deployment.WindowsRuntimeControl]::Exchange($Generation, $OwnerPid, $OwnerIdentity, 'stop', 15000) | ConvertFrom-Json
        if (-not $stopped.quiescent -or $stopped.phase -cne 'stopped' -or $stopped.members.Count -ne 0) {
            throw 'Original first-runtime test Job did not settle.'
        }
        if ([Deployment.WindowsRuntimeControl]::Exchange($Generation, $OwnerPid, $OwnerIdentity, 'retire', 15000) -cne 'retired' -or
            -not $owner.WaitForExit(15000) -or $owner.ExitCode -ne 0) { throw 'Original first-runtime test owner did not retire.' }
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        while ($task.GetInstances(0).Count -ne 0) {
            if ($deadline.ElapsedMilliseconds -gt 15000) { throw 'Original test task instance did not settle.' }
            Start-Sleep -Milliseconds 100
        }
        [Console]::Out.WriteLine('{"status":"stopped"}')
    } finally { $owner.Dispose() }
}
