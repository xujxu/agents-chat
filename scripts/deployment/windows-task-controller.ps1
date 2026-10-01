param(
    [Parameter(Mandatory)][string]$Admission,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$retained = $null
$context = $null
$watch = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported bridge platform.' }
    Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwner($ControllerPid, $ControllerIdentity)
    $retained = [Deployment.WindowsPrivateFile]::Open($Admission, $Sha256)
    $fields = Read-AgentsChatMaintenanceFields ($retained.ReadText()) @(
        'version', 'operationId', 'controllerPid', 'controllerIdentity', 'taskName', 'definition',
        'securityDescriptor', 'configuration', 'configurationSha256', 'readySha256',
        'ownerPid', 'ownerIdentity', 'generation', 'instanceGuid')
    if ($fields.controllerPid.GetInt32() -ne $ControllerPid -or
        $fields.controllerIdentity.GetString() -cne $ControllerIdentity) { throw 'Original controller differs.' }
    $stage = 'stop'
    $context = Stop-AgentsChatManagedTask -Admission $Admission -Sha256 $Sha256
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        admissionSha256=$Sha256; stopped=$true; inhibited=$true
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        if (-not $line.Wait(1800000)) { throw 'Controller request timed out.' }
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close')) { throw 'Invalid controller request.' }
        $sequence = $id
        $stage = 'check'
        $retained.Check()
        $null = Assert-AgentsChatTaskStopped -Context $context
        if ($method -ceq 'close') {
            $stage = 'close'
            Close-AgentsChatTaskMaintenance -Context $context
            $context = $null
            $retained.Dispose()
            $retained = $null
        }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; value=$method } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { return }
    }
} catch {
    [Console]::Error.WriteLine("Task controller refused: $stage.")
    exit 1
} finally {
    if ($context) { Close-AgentsChatTaskMaintenance -Context $context }
    if ($retained) { $retained.Dispose() }
    if ($watch) { $watch.Dispose() }
}
