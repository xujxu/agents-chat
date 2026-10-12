param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$proof = $watch = $null
$stage = 'bootstrap'
$failure = $null
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported stopped restore bridge platform.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'))
    . (Join-Path $PSScriptRoot 'windows-stopped-restore-proof.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'proof-open'
    $proof = Open-AgentsChatStoppedRestoreProof -Control $Control
    $observed = Assert-AgentsChatStoppedRestoreProof $proof
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        control=$Control; controllerIdentity=$ControllerIdentity; value=$observed
    } | ConvertTo-Json -Depth 4 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close')) {
            throw 'Invalid read-only stopped restore proof request.'
        }
        $sequence = $id
        $stage = 'controller'
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original stopped restore observer changed.'
        }
        $stage = $method
        if ($method -ceq 'close') {
            Close-AgentsChatTaskCompletionProof $proof
            $proof = $null
            $value = 'close'
        } else { $value = Assert-AgentsChatStoppedRestoreProof $proof }
        [Console]::Out.WriteLine((@{
            id=$id; type='reply'; value=$value
            processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        } | ConvertTo-Json -Depth 4 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Stopped restore bridge refused: $stage. $($failure.GetBaseException().Message)")
} finally {
    if ($proof) {
        try { Close-AgentsChatTaskCompletionProof $proof }
        catch {
            [Console]::Error.WriteLine('Stopped restore proof cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Stopped restore bridge and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
    if ($watch) {
        try { $watch.Dispose() }
        catch {
            [Console]::Error.WriteLine('Stopped restore observer cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Stopped restore watch and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
