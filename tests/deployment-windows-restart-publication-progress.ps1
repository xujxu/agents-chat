function Invoke-AgentsChatRestartPublicationProofFrames(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [ValidateSet('directory', 'owner', 'committed')][string]$Publication
) {
    $progress = @{
        Observe=${function:Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation}
        Pass=0; Publication=$Publication
    }
    function Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation(
        [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
    ) {
        $observation = & ($progress.Observe) @PSBoundParameters
        $progress.Pass++
        if ($progress.Pass -gt 2) { throw 'Unexpected restart publication ancestor observation pass.' }
        [Console]::Out.WriteLine((@{
            type="restart-$($progress.Publication)-proof"; stage=$(if ($progress.Pass -eq 1) { 'before' } else { 'after' })
            pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            control=$Context.Control; controllerIdentity=$ControllerIdentity; value=$observation
        } | ConvertTo-Json -Depth 12 -Compress))
        [Console]::Out.Flush()
        return $observation
    }
    $result = switch -CaseSensitive ($Publication) {
        'directory' { New-AgentsChatStoppedHistoryHandoffRestartLockDirectory $Context $ControllerPid $ControllerIdentity }
        'owner' { Publish-AgentsChatStoppedHistoryHandoffRestartLockOwner $Context $ControllerPid $ControllerIdentity }
        'committed' { Complete-AgentsChatStoppedHistoryHandoffRestartCommit $Context $ControllerPid $ControllerIdentity }
    }
    if ($progress.Pass -ne 2) { throw 'Restart publication did not complete both ancestor observations.' }
    return $result
}
