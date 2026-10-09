param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scope = $watch = $null
$failure = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported managed task observer.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-managed-task.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-admission.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'managed-task-open'
    $scope = Open-AgentsChatManagedTask $TaskName $Project
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; project=$Project; taskName=$TaskName
        accountSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
        controllerIdentity=$ControllerIdentity; value=(Assert-AgentsChatManagedTask $scope)
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $text = $line.GetAwaiter().GetResult()
        $document = [Text.Json.JsonDocument]::Parse($text)
        try { $method = $document.RootElement.GetProperty('method').GetString() }
        finally { $document.Dispose() }
        $fields = @('id', 'method')
        if ($method -ceq 'capture-admission') { $fields += @('control', 'lockSha256', 'stateSha256') }
        if ($method -ceq 'listener') { $fields += 'port' }
        $request = Read-AgentsChatMaintenanceFields $text $fields
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close', 'capture-admission', 'listener')) { throw 'Invalid managed task observation request.' }
        $sequence = $id
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original managed task observer changed.'
        }
        $stage = $method
        if ($method -ceq 'close') {
            Close-AgentsChatTaskCompletionProof $scope
            $scope = $null
            $value = 'close'
        } elseif ($method -ceq 'listener') {
            $value = Open-AgentsChatManagedTaskListener -Context $scope -Port $request.port.GetInt32()
        } elseif ($method -ceq 'capture-admission') {
            $value = New-AgentsChatManagedTaskAdmission -Context $scope -Control $request.control.GetString() `
                -LockSha256 $request.lockSha256.GetString() -StateSha256 $request.stateSha256.GetString() `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
        } else { $value = Assert-AgentsChatManagedTask $scope }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$value } |
            ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Managed task observation refused: $stage. $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Managed task observer cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Managed task observation and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
