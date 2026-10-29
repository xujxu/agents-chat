. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock-retirement-observation.ps1')

function Remove-AgentsChatStoppedHistoryHandoffLockDirectory(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffLockDirectoryRetirementExecutor') -or
        $Context.HistoryHandoffLockDirectoryRetirementExecutor -ne $true) {
        throw 'Handoff directory retirement requires its independent native role.'
    }
    try {
        $observed = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
        $lock = $Context.HistoryHandoffLock
        if ($lock.DirectoryRetired) { return $observed }
        if (-not $lock.OwnerRetired -or $null -ne $lock.OwnerFile -or
            $null -ne $lock.OwnerRetirement -or $null -ne $lock.DirectoryRetirement) {
            throw 'Handoff directory is not its exact owner-retired directory.'
        }
        $old = $lock.Directory
        $old.Dispose()
        $null = $Context.Files.Remove($old)
        $lock.Directory = $null
        $target = [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement(
            (Join-Path $Context.Control 'lock'), $lock.DirectoryIdentity.dev, $lock.DirectoryIdentity.ino)
        $Context.Files.Add($target)
        $lock.DirectoryRetirement = $target
        $null = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
        $target.Check()
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Handoff directory retirement executor identity differs.'
        }
        $target.Delete()
        $null = $Context.Files.Remove($target)
        $lock.DirectoryRetirement = $null
        $lock.DirectoryRetired = $true
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            $observed = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
            if ($observed.status -cne 'lock-retirement-directory-retired') {
                throw 'Handoff directory retirement did not preserve its exact absent stage.'
            }
        }
        return $observed
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff directory retirement failed; retain evidence.', $_.Exception)
    }
}
