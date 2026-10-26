. (Join-Path $PSScriptRoot 'windows-task-completion-records.ps1')

function New-AgentsChatStoppedHistoryHandoffOwner(
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
    foreach ($pass in @(1, 2)) {
        try { $actual = [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) }
        catch {
            throw [InvalidOperationException]::new('Handoff prospective owner is unavailable.', $_.Exception)
        }
        if ($actual -cne $ControllerIdentity) { throw 'Handoff prospective owner identity differs.' }
    }
    return [ordered]@{
        version=1; token=$Token; project=$Project; operationId=$OperationId
        pid=$ControllerPid; processIdentity=$ControllerIdentity; createdAt=$CreatedAt
    }
}
