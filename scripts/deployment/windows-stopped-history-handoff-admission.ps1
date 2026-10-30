. (Join-Path $PSScriptRoot 'windows-inactive-worker-cleanup.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-successor-abandoned-observation.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-observation.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-state-observation.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-state-observation.ps1')

# The first-attempt shape admits its live committed owner; the restart shape admits its live restart owner.
function Test-AgentsChatStoppedHistoryHandoffFirstAdmissionProof([hashtable]$Proof) {
    $first = $Proof.ContainsKey('HistoryHandoffFirstOwnerAdmitter')
    if ($first -eq $Proof.ContainsKey('HistoryHandoffRestartOwnerAdmitter')) {
        throw 'Handoff-aware admission proof role differs.'
    }
    if ($first) { $null = Test-AgentsChatStoppedHistoryHandoffFirstOwnerAdmitter $Proof }
    elseif ($Proof.HistoryHandoffRestartOwnerAdmitter -ne $true) { throw 'Handoff-aware admission proof role differs.' }
    return $first
}

function Get-AgentsChatStoppedHistoryHandoffAdmissionOwner([hashtable]$Proof) {
    if (Test-AgentsChatStoppedHistoryHandoffFirstAdmissionProof $Proof) {
        $observed = $Proof.HistoryHandoffObservedCommit
        return @{ ControllerPid=$observed.ControllerPid; ControllerIdentity=$observed.ControllerIdentity }
    }
    return $Proof.HistoryHandoffRestartPrepared.Request
}

function Get-AgentsChatStoppedHistoryHandoffAdmissionObservation(
    [hashtable]$Proof, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (Test-AgentsChatStoppedHistoryHandoffFirstAdmissionProof $Proof) {
        return Get-AgentsChatStoppedHistoryHandoffStateObservation $Proof $ControllerPid $ControllerIdentity
    }
    return Get-AgentsChatStoppedHistoryHandoffRestartStateObservation $Proof $ControllerPid $ControllerIdentity
}

function Assert-AgentsChatStoppedHistoryHandoffAdmissionProof(
    [hashtable]$Proof, [int]$ControllerPid, [string]$ControllerIdentity, [string]$LockSha256, [string]$StateSha256
) {
    $observation = Get-AgentsChatStoppedHistoryHandoffAdmissionObservation $Proof $ControllerPid $ControllerIdentity
    $owner = Get-AgentsChatStoppedHistoryHandoffAdmissionOwner $Proof
    if ($owner.ControllerPid -ne $ControllerPid -or $owner.ControllerIdentity -cne $ControllerIdentity -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity -or
        $observation.lock.sha256 -cne $LockSha256 -or $observation.state.sha256 -cne $StateSha256 -or
        $observation.runtimeAuthority -ne $false -or $observation.lockAuthority -ne $false -or
        $observation.taskAuthority -ne $false) {
        throw 'Handoff-aware admission differs from its exact live owner written preflight.'
    }
}

# After publication the new task-maintenance entry is outside the stopped cleanup inventory, so only the
# proof's retained exact handles and the live owner are rechecked.
function Assert-AgentsChatStoppedHistoryHandoffAdmissionProofRetained(
    [hashtable]$Proof, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if ($Proof.Closed -or $Proof.Poisoned -or $Proof.Files.Count -lt 1) {
        throw 'Handoff-aware admission proof is no longer retained.'
    }
    foreach ($file in $Proof.Files) {
        if ($null -ne $file.PSObject.Methods['Check']) { $file.Check() }
    }
    $owner = Get-AgentsChatStoppedHistoryHandoffAdmissionOwner $Proof
    if ($owner.ControllerPid -ne $ControllerPid -or $owner.ControllerIdentity -cne $ControllerIdentity -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Handoff-aware admission owner changed after publication.'
    }
}

function Open-AgentsChatStoppedHistoryHandoffOwnerProof(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity, $Handoff
) {
    if ($Handoff -isnot [Collections.IDictionary]) { throw 'Handoff-aware admission evidence is required.' }
    if ($Handoff.Contains('stateIntent')) {
        Assert-AgentsChatRetirementFields $Handoff @('attemptId', 'prepared', 'committed', 'stateIntent', 'state')
        if ($Handoff.attemptId -isnot [string]) { throw 'Handoff-aware admission attempt differs.' }
        return Open-AgentsChatStoppedHistoryHandoffStateObservation $Control $ControllerPid $ControllerIdentity `
            $Handoff.attemptId $Handoff.prepared $Handoff.committed $Handoff.stateIntent $Handoff.state -OwnerAdmission
    }
    Assert-AgentsChatRetirementFields $Handoff @(
        'attemptId', 'prepared', 'committed', 'retirement', 'terminal', 'successor', 'abandoned',
        'restart', 'restartCommitted', 'restartStateIntent', 'restartState'
    )
    if ($Handoff.attemptId -isnot [string]) { throw 'Handoff-aware admission attempt differs.' }
    return Open-AgentsChatStoppedHistoryHandoffRestartStateObservation $Control $ControllerPid $ControllerIdentity `
        $Handoff.attemptId $Handoff.prepared $Handoff.committed $Handoff.retirement $Handoff.terminal `
        $Handoff.successor $Handoff.abandoned $Handoff.restart $Handoff.restartCommitted `
        $Handoff.restartStateIntent $Handoff.restartState -OwnerAdmission
}

# Returns the inactive observation bound into the proved prepared record. A released rollback records its
# relocated physical bundle there, while the unchanged task action still names the emptied original bundle.
function Get-AgentsChatStoppedHistoryHandoffProvedObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity, $Handoff
) {
    $proof = $null
    $failure = $null
    try {
        $proof = Open-AgentsChatStoppedHistoryHandoffOwnerProof $Control $ControllerPid $ControllerIdentity $Handoff
        $null = Get-AgentsChatStoppedHistoryHandoffAdmissionObservation $proof $ControllerPid $ControllerIdentity
        $owner = Get-AgentsChatStoppedHistoryHandoffAdmissionOwner $proof
        if ($owner.ControllerPid -ne $ControllerPid -or $owner.ControllerIdentity -cne $ControllerIdentity) {
            throw 'Handoff-aware inspection requires its exact live owner.'
        }
        $prepared = $proof.HistoryHandoffObservedCommit.Prepared
        $prepared.Check()
        $record = Read-AgentsChatRetirementJson ($prepared.ReadText()) -AllowNull
        if ($record -isnot [Collections.IDictionary] -or $record.observation -isnot [Collections.IDictionary]) {
            throw 'Handoff-aware inspection observation differs.'
        }
        $prepared.Check()
        return $record.observation
    } catch {
        $failure = [InvalidOperationException]::new('Handoff-aware inspection verification failed; retain evidence.', $_.Exception)
        throw $failure
    } finally {
        if ($proof) {
            try { Close-AgentsChatTaskCompletionProof $proof }
            catch {
                if ($failure) { throw [AggregateException]::new('Handoff-aware inspection proof and close failed.', [Exception[]]@($failure, $_.Exception)) }
                throw
            }
        }
    }
}

function Open-AgentsChatStoppedHistoryHandoffAdmissionProof(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$LockSha256, [string]$StateSha256, $Handoff
) {
    $proof = $null
    try {
        $proof = Open-AgentsChatStoppedHistoryHandoffOwnerProof $Control $ControllerPid $ControllerIdentity $Handoff
        Assert-AgentsChatStoppedHistoryHandoffAdmissionProof $proof $ControllerPid $ControllerIdentity $LockSha256 $StateSha256
        return $proof
    } catch {
        $failure = $_.Exception
        if ($proof) {
            try { Close-AgentsChatTaskCompletionProof $proof }
            catch { $failure = [AggregateException]::new('Handoff-aware admission proof open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        }
        throw [InvalidOperationException]::new('Handoff-aware admission verification failed; retain evidence.', $failure)
    }
}
