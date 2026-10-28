function Invoke-AgentsChatRestartDirectoryProofFrames(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    $progress = @{
        Observe=${function:Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation}
        Pass=0
    }
    function Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation(
        [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
    ) {
        $observation = & ($progress.Observe) @PSBoundParameters
        $progress.Pass++
        if ($progress.Pass -gt 2) { throw 'Unexpected restart directory ancestor observation pass.' }
        [Console]::Out.WriteLine((@{
            type='restart-directory-proof'; stage=$(if ($progress.Pass -eq 1) { 'before' } else { 'after' })
            pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            control=$Context.Control; controllerIdentity=$ControllerIdentity; value=$observation
        } | ConvertTo-Json -Depth 12 -Compress))
        [Console]::Out.Flush()
        return $observation
    }
    $identity = New-AgentsChatStoppedHistoryHandoffRestartLockDirectory $Context $ControllerPid $ControllerIdentity
    if ($progress.Pass -ne 2) { throw 'Restart directory publication did not complete both ancestor observations.' }
    return $identity
}
