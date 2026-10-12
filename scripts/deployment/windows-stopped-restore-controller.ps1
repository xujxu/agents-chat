param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [switch]$Recovery,
    [switch]$ColdActivation,
    [switch]$ColdPolicyRecovery,
    [switch]$ColdCompletion,
    [switch]$ColdCompletionRecovery,
    [string]$OwnerSha256,
    [string]$ReceiptSha256,
    [string]$IntentSha256,
    [string]$HistorySha256,
    [string]$PolicySha256,
    [string]$CompletionSha256
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
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-stopped-restore-proof.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'proof-open'
    if ($ColdActivation) {
        if (-not $Recovery -or
            @(@($OwnerSha256, $ReceiptSha256, $IntentSha256, $HistorySha256) | Where-Object { $_ -cnotmatch '^[a-f0-9]{64}$' }).Count -or
            ($ColdPolicyRecovery -and $PolicySha256 -cnotmatch '^[a-f0-9]{64}$') -or
            (-not $ColdPolicyRecovery -and $PolicySha256) -or
            ($ColdCompletion -and ($ColdPolicyRecovery -or $CompletionSha256 -cnotmatch '^[a-f0-9]{64}$')) -or
            ($ColdCompletionRecovery -and -not $ColdCompletion) -or
            (-not $ColdCompletion -and $CompletionSha256)) {
            throw 'Cold observation requires explicit original evidence digests.'
        }
        . (Join-Path $PSScriptRoot 'windows-cold-activation-recovery-proof.ps1')
        . (Join-Path $PSScriptRoot 'windows-cold-policy-recovery.ps1')
        . (Join-Path $PSScriptRoot 'windows-cold-policy-archive.ps1')
        if ($ColdCompletion) {
            . (Join-Path $PSScriptRoot 'windows-cold-completion-proof.ps1')
            if ($ColdCompletionRecovery) {
                . (Join-Path $PSScriptRoot 'windows-cold-completion-recovery.ps1')
                . (Join-Path $PSScriptRoot 'windows-cold-terminal-intent.ps1')
                $proof = Open-AgentsChatColdCompletionRecovery $Control $OwnerSha256 $ReceiptSha256 `
                    $IntentSha256 $HistorySha256 $CompletionSha256
            } else {
                $proof = Open-AgentsChatColdCompletionProof $Control $OwnerSha256 $ReceiptSha256 `
                    $IntentSha256 $HistorySha256 $CompletionSha256
            }
            $observed = Assert-AgentsChatColdCompletionProof $proof
        } else {
            $proof = Open-AgentsChatColdActivationRecoveryProof $Control $OwnerSha256 $ReceiptSha256 $IntentSha256 $HistorySha256 `
                -PolicyRecovery:$ColdPolicyRecovery -PolicySha256 $PolicySha256 `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
            $observed = Assert-AgentsChatColdActivationRecoveryProof $proof
        }
    } else {
        if ($OwnerSha256 -or $ReceiptSha256 -or $IntentSha256 -or $HistorySha256 -or $ColdPolicyRecovery -or
            $PolicySha256 -or $ColdCompletion -or $CompletionSha256 -or $ColdCompletionRecovery) {
            throw 'Stopped observation cannot accept cold activation digests.'
        }
        $proof = Open-AgentsChatStoppedRestoreProof -Control $Control -Recovery:$Recovery
        $observed = Assert-AgentsChatStoppedRestoreProof $proof
    }
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
        $methods = @('check', 'close')
        if ($ColdPolicyRecovery) { $methods += @('advance', 'archive') }
        if ($ColdCompletionRecovery) { $methods += @('advance', 'prepare-terminal') }
        if ($id -ne $sequence + 1 -or $method -cnotin $methods) {
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
        } elseif ($method -ceq 'archive') { $value = Archive-AgentsChatColdPolicyJournal $proof }
        elseif ($method -ceq 'prepare-terminal') {
            $value = Prepare-AgentsChatColdTerminalRestore $proof $ControllerPid $ControllerIdentity
        }
        elseif ($method -ceq 'advance' -and $ColdCompletionRecovery) { $value = Advance-AgentsChatColdCompletionRecovery $proof }
        elseif ($method -ceq 'advance') { $value = Advance-AgentsChatColdPolicyRecovery $proof }
        elseif ($ColdCompletion) { $value = Assert-AgentsChatColdCompletionProof $proof }
        elseif ($ColdActivation) { $value = Assert-AgentsChatColdActivationRecoveryProof $proof }
        else { $value = Assert-AgentsChatStoppedRestoreProof $proof }
        [Console]::Out.WriteLine((@{
            id=$id; type='reply'; value=$value
            processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        } | ConvertTo-Json -Depth 4 -Compress))
        [Console]::Out.Flush()
        if ($method -cin @('close', 'archive')) { break }
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
