. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock-retirement-observation.ps1')

function Remove-AgentsChatStoppedHistoryHandoffLockOwner(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffLockRetirementExecutor') -or
        $Context.HistoryHandoffLockRetirementExecutor -ne $true) {
        throw 'Handoff owner retirement requires its independent native role.'
    }
    try {
        $observed = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
        $lock = $Context.HistoryHandoffLock
        if ($lock.OwnerRetired) { return $observed }
        if ($null -ne $lock.OwnerRetirement -or $null -eq $lock.OwnerFile) {
            throw 'Handoff owner is not its exact retained file.'
        }
        $descriptor = Get-AgentsChatStoppedHistoryHandoffLockOwnerDescriptor $Context
        $old = $lock.OwnerFile
        $old.Dispose()
        $null = $Context.Files.Remove($old)
        $lock.OwnerFile = $null
        $target = [Deployment.WindowsPrivateFile]::RetainForRetirement(
            (Join-Path $Context.Control 'lock\owner.json'),
            $descriptor.sha256, $descriptor.dev, $descriptor.ino, $descriptor.bytes)
        $Context.Files.Add($target)
        $lock.OwnerRetirement = $target
        $null = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
        $target.Check()
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Handoff owner retirement executor identity differs.'
        }
        $target.Delete()
        $null = $Context.Files.Remove($target)
        $lock.OwnerRetirement = $null
        $lock.OwnerRetired = $true
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            $observed = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
            if ($observed.status -cne 'lock-retirement-owner-retired') {
                throw 'Handoff owner retirement did not preserve its exact empty directory.'
            }
        }
        return $observed
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff owner retirement failed; retain evidence.', $_.Exception)
    }
}
