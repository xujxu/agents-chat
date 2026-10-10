param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scope = $watch = $null
$failure = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion -lt [version]'7.4') { throw 'Unsupported first receipt platform.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-first-receipt-publication.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'publication-open'
    $scope = Open-AgentsChatFirstCompletionProof -Control $Control -Recovery
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; control=$Control; project=$scope.Project
        controllerIdentity=$ControllerIdentity; value=(Assert-AgentsChatFirstReceiptPublication $scope)
        deploymentIdentity=$scope.DeploymentIdentity; acceptedAt=$scope.AcceptedState.updatedAt.GetString()
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method', 'service')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'publish', 'close') -or
            ($method -cne 'publish' -and $null -ne $request.service.GetString())) { throw 'Invalid first receipt request.' }
        $sequence = $id
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original first receipt actor changed.'
        }
        $stage = $method
        if ($method -ceq 'close') {
            Close-AgentsChatTaskCompletionProof $scope
            $scope = $null
            $value = 'close'
        } elseif ($method -ceq 'publish') {
            $value = Publish-AgentsChatFirstDeploymentReceipt $scope $request.service.GetString()
        } else { $value = Assert-AgentsChatFirstReceiptPublication $scope }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$value } |
            ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("First receipt publication refused: $stage. $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('First receipt publication cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('First receipt and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
