. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-lock.ps1')

function Publish-AgentsChatStoppedHistoryHandoffRestartLockOwner(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartOwnerPublisher') -or
        $Context.HistoryHandoffRestartOwnerPublisher -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver')) {
        throw 'Restart owner publication requires its independent native role.'
    }
    try {
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        $lock = $Context.HistoryHandoffRestartLock
        if ($lock.ContainsKey('OwnerFile') -or $lock.ContainsKey('OwnerDescriptor')) {
            throw 'Restart lock owner already retained.'
        }
        $observed = $Context.HistoryHandoffObservedCommit
        if ($ControllerPid -ne $observed.ControllerPid -or
            $ControllerIdentity -cne $observed.ControllerIdentity) {
            throw 'Restart owner controller differs.'
        }
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        $request = $Context.HistoryHandoffRestartPrepared.Request
        $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        $file = [Deployment.WindowsPrivateFile]::Publish(
            (Join-Path $Context.Control 'lock\owner.json'), ($record.newOwner | ConvertTo-Json -Compress))
        $Context.Files.Add($file)
        $lock.OwnerFile = $file
        $lock.OwnerDescriptor = Get-AgentsChatStoppedHandoffDescriptor $file 'lock\owner.json'
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        return $lock.OwnerDescriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart owner publication failed; retain evidence.', $_.Exception)
    }
}
