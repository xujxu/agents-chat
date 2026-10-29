. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-retirement.ps1')

function Remove-AgentsChatStoppedHistoryHandoffRestartLockOwner(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartOwnerRetirer') -or
        $Context.HistoryHandoffRestartOwnerRetirer -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartRetirementObserver') -or
        $Context.HistoryHandoffRestartRetirementObserver -ne $true) {
        throw 'Restart lock owner retirement requires its independent native role.'
    }
    try {
        $observed = Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation $Context $ControllerPid $ControllerIdentity
        $lock = $Context.HistoryHandoffRestartLock
        if ($lock.ContainsKey('OwnerRetired')) { return $observed }
        if ($observed.status -cne 'restart-lock-retirement-observed' -or $null -eq $lock.OwnerFile) {
            throw 'Restart lock owner is not its exact retained file.'
        }
        $owner = $lock.OwnerDescriptor
        $old = $lock.OwnerFile
        $old.Dispose()
        $null = $Context.Files.Remove($old)
        $lock.OwnerFile = $null
        $target = [Deployment.WindowsPrivateFile]::RetainForRetirement(
            (Join-Path $Context.Control 'lock\owner.json'), $owner.sha256, $owner.dev, $owner.ino, $owner.bytes)
        $Context.Files.Add($target)
        $target.Check()
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Restart lock owner retirement executor identity differs.'
        }
        $target.Delete()
        $null = $Context.Files.Remove($target)
        $lock.OwnerRetired = $true
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            $observed = Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation $Context $ControllerPid $ControllerIdentity
            if ($observed.status -cne 'restart-lock-retirement-owner-retired') {
                throw 'Restart lock owner retirement did not preserve its exact empty directory.'
            }
        }
        return $observed
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart lock owner retirement failed; retain evidence.', $_.Exception)
    }
}
