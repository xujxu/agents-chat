. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-retirement-owner.ps1')

function Remove-AgentsChatStoppedHistoryHandoffRestartLockDirectory(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartDirectoryRetirer') -or
        $Context.HistoryHandoffRestartDirectoryRetirer -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartRetirementObserver') -or
        $Context.HistoryHandoffRestartRetirementObserver -ne $true) {
        throw 'Restart lock directory retirement requires its independent native role.'
    }
    try {
        $observed = Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation $Context $ControllerPid $ControllerIdentity
        $lock = $Context.HistoryHandoffRestartLock
        if ($lock.ContainsKey('DirectoryRetired')) { return $observed }
        if ($observed.status -cne 'restart-lock-retirement-owner-retired' -or $null -eq $lock.Directory) {
            throw 'Restart lock directory is not its exact owner-retired directory.'
        }
        $old = $lock.Directory
        $old.Dispose()
        $null = $Context.Files.Remove($old)
        $lock.Directory = $null
        $target = [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement(
            (Join-Path $Context.Control 'lock'), $lock.DirectoryIdentity.dev, $lock.DirectoryIdentity.ino)
        $Context.Files.Add($target)
        $target.Check()
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Restart lock directory retirement executor identity differs.'
        }
        $target.Delete()
        $null = $Context.Files.Remove($target)
        $lock.DirectoryRetired = $true
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            $observed = Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation $Context $ControllerPid $ControllerIdentity
            if ($observed.status -cne 'restart-lock-retirement-directory-retired') {
                throw 'Restart lock directory retirement did not preserve its exact absent stage.'
            }
        }
        return $observed
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart lock directory retirement failed; retain evidence.', $_.Exception)
    }
}
