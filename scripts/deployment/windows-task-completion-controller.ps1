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
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported proof bridge platform.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-retirement-intent.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-retirement-checkpoint.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'proof-open'
    $proof = Open-AgentsChatTaskCompletionProof -Control $Control
    $observed = Assert-AgentsChatTaskCompletionProof -Context $proof
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        control=$Control; controllerIdentity=$ControllerIdentity; value=$observed
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @(
            'check', 'close', 'prepare-retirement', 'prepare-retirement-checkpoint')) {
            throw 'Invalid completed-task proof request.'
        }
        $sequence = $id
        $stage = 'controller'
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original completed-task proof controller changed.'
        }
        $stage = $method
        if ($method -ceq 'close') {
            Close-AgentsChatTaskCompletionProof -Context $proof
            $proof = $null
            $value = 'close'
        } elseif ($method -ceq 'prepare-retirement') {
            $value = Prepare-AgentsChatTaskRetirement -Context $proof `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
        } elseif ($method -ceq 'prepare-retirement-checkpoint') {
            $value = Prepare-AgentsChatTaskRetirementCheckpoint -Context $proof `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
        } else { $value = Assert-AgentsChatTaskCompletionProof -Context $proof }
        [Console]::Out.WriteLine((@{
            id=$id; type='reply'; value=$value
            processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        } | ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Completed-task proof refused: $stage. $($failure.GetBaseException().Message)")
} finally {
    if ($proof) {
        try { Close-AgentsChatTaskCompletionProof -Context $proof }
        catch {
            [Console]::Error.WriteLine('Completed-task proof cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Proof and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
    if ($watch) {
        try { $watch.Dispose() }
        catch {
            [Console]::Error.WriteLine('Completed-task proof owner watch cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Proof and owner watch cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
