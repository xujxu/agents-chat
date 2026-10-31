. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')

function Get-AgentsChatStoppedHistoryHandoffOwnerRecord(
    [string]$Project, [string]$PreviousOperationId, [string]$AttemptId,
    [string]$OperationId, [string]$Token, [string]$CreatedAt,
    [string]$PreviousUpdatedAt, [int]$ControllerPid, [string]$ControllerIdentity
) {
    foreach ($value in @($PreviousOperationId, $AttemptId, $OperationId, $Token)) {
        Assert-AgentsChatCompletionGuid $value
    }
    if (@($PreviousOperationId, $AttemptId, $OperationId | Select-Object -Unique).Count -ne 3 -or
        $Project -cnotmatch '^[A-Za-z]:\\' -or $Project.Length -gt 4096 -or
        $Project -match '[\x00\r\n]' -or [IO.Path]::GetFullPath($Project) -cne $Project -or
        $Project.Substring(3).Contains(':')) {
        throw 'Handoff prospective owner request differs.'
    }
    Assert-AgentsChatCompletionProcessIdentity $ControllerPid $ControllerIdentity
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $style = [Globalization.DateTimeStyles]::AssumeUniversal
    $created = [DateTimeOffset]::ParseExact($CreatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
    $previous = [DateTimeOffset]::ParseExact($PreviousUpdatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
    if ($created -lt $previous) { throw 'Handoff prospective owner timestamp is backdated.' }
    return [ordered]@{
        version=1; token=$Token; project=$Project; operationId=$OperationId
        pid=$ControllerPid; processIdentity=$ControllerIdentity; createdAt=$CreatedAt
    }
}

function New-AgentsChatStoppedHistoryHandoffOwner(
    [string]$Project, [string]$PreviousOperationId, [string]$AttemptId,
    [string]$OperationId, [string]$Token, [string]$CreatedAt,
    [string]$PreviousUpdatedAt, [int]$ControllerPid, [string]$ControllerIdentity
) {
    $owner = Get-AgentsChatStoppedHistoryHandoffOwnerRecord @PSBoundParameters
    foreach ($pass in (Get-AgentsChatVerificationPasses)) {
        try { $actual = [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) }
        catch {
            throw [InvalidOperationException]::new('Handoff prospective owner is unavailable.', $_.Exception)
        }
        if ($actual -cne $ControllerIdentity) { throw 'Handoff prospective owner identity differs.' }
    }
    return $owner
}

function Get-AgentsChatStoppedHistoryHandoffRetiredOwner(
    [string]$Project, [string]$PreviousOperationId, [string]$AttemptId,
    [string]$OperationId, [string]$Token, [string]$CreatedAt,
    [string]$PreviousUpdatedAt, [int]$ControllerPid, [string]$ControllerIdentity
) {
    $owner = Get-AgentsChatStoppedHistoryHandoffOwnerRecord @PSBoundParameters
    foreach ($pass in (Get-AgentsChatVerificationPasses)) {
        try { Assert-AgentsChatCompletionProcessAbsent $ControllerPid $ControllerIdentity }
        catch {
            throw [InvalidOperationException]::new('Handoff retired owner remains live or unverifiable.', $_.Exception)
        }
    }
    return $owner
}

# First-attempt handoff-aware admission observes from inside the exact live committed owner; every other
# observer requires the owner's death.
function Test-AgentsChatStoppedHistoryHandoffFirstOwnerAdmitter([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffFirstOwnerAdmitter')) { return $false }
    $admitter = $Context.HistoryHandoffFirstOwnerAdmitter
    if ($admitter -isnot [hashtable] -or $admitter.ControllerPid -isnot [int] -or
        $admitter.ControllerIdentity -isnot [string] -or $admitter.ControllerPid -eq $PID -or
        $Context.ContainsKey('HistoryHandoffLockPublisher') -or
        $Context.ContainsKey('HistoryHandoffRestartOwnerAdmitter') -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($admitter.ControllerPid) -cne $admitter.ControllerIdentity) {
        throw 'First-attempt owner admission requires the exact live committed owner.'
    }
    return $true
}

function Get-AgentsChatStoppedHistoryHandoffObservedOwner([hashtable]$Context, [hashtable]$Request) {
    if (Test-AgentsChatStoppedHistoryHandoffFirstOwnerAdmitter $Context) {
        $admitter = $Context.HistoryHandoffFirstOwnerAdmitter
        if ($Request.ControllerPid -ne $admitter.ControllerPid -or
            $Request.ControllerIdentity -cne $admitter.ControllerIdentity) {
            throw 'First-attempt owner admission owner differs.'
        }
        return New-AgentsChatStoppedHistoryHandoffOwner @Request
    }
    return Get-AgentsChatStoppedHistoryHandoffRetiredOwner @Request
}

function Assert-AgentsChatStoppedHistoryHandoffObservedCreator(
    [hashtable]$Context, $Creator, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not (Test-AgentsChatStoppedHistoryHandoffFirstOwnerAdmitter $Context)) {
        Assert-AgentsChatRetirementCreator $Creator $ControllerPid $ControllerIdentity
        return
    }
    $admitter = $Context.HistoryHandoffFirstOwnerAdmitter
    Assert-AgentsChatRetirementFields $Creator @('pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')
    if ($Creator.pid -isnot [int] -or $Creator.bridgePid -isnot [int] -or $Creator.pid -eq $Creator.bridgePid) {
        throw 'Invalid retirement creator.'
    }
    Assert-AgentsChatCompletionProcessIdentity $Creator.pid $Creator.processIdentity
    Assert-AgentsChatCompletionProcessIdentity $Creator.bridgePid $Creator.bridgeIdentity
    if ($ControllerPid -ne $admitter.ControllerPid -or $ControllerIdentity -cne $admitter.ControllerIdentity -or
        $Creator.pid -ne $ControllerPid -or $Creator.processIdentity -cne $ControllerIdentity -or
        $Creator.bridgePid -eq $PID -or
        $Creator.bridgeIdentity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        throw 'First-attempt owner admission creator differs from its live committed owner.'
    }
    Assert-AgentsChatCompletionProcessAbsent $Creator.bridgePid $Creator.bridgeIdentity
}
