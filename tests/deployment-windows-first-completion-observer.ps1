param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][int]$OwnerPid,
    [Parameter(Mandatory)][string]$OwnerIdentity,
    [Parameter(Mandatory)][guid]$Generation,
    [ValidateSet('Inspect', 'Stop')][string]$Mode = 'Inspect'
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
if ($Mode -ceq 'Stop' -and $task.GetInstances(0).Count -eq 0) {
    $identity = $null
    try { $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($OwnerPid) }
    catch { if ($_.Exception.GetBaseException() -isnot [ArgumentException]) { throw } }
    if ($identity -ceq $OwnerIdentity) {
        throw 'Original owner is still running without its task instance.'
    }
    [Console]::Out.WriteLine('{"status":"already-stopped"}')
    exit 0
}
$binding = Get-AgentsChatTaskOwnerBinding -TaskName $TaskName -OwnerPid $OwnerPid `
    -OwnerIdentity $OwnerIdentity -Definition ([string]$task.Xml) `
    -SecurityDescriptor ([string]$task.GetSecurityDescriptor(7))
if ($Mode -ceq 'Inspect') {
    $lease = [Deployment.WindowsRuntimeControl]::Exchange($Generation, $OwnerPid, $OwnerIdentity, 'lease', 15000)
    $domain = [Deployment.WindowsRuntimeControl]::Exchange($Generation, $OwnerPid, $OwnerIdentity, 'observe', 15000) | ConvertFrom-Json
    [Console]::Out.WriteLine((@{
        binding=$binding; lease=$lease; domain=$domain; definition=[string]$task.Xml
        securityDescriptor=[string]$task.GetSecurityDescriptor(7)
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
