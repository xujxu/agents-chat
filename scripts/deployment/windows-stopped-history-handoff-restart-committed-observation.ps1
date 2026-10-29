. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-commit.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-observation.ps1')

function Open-AgentsChatStoppedHistoryHandoffRestartLockObservation(
    [hashtable]$Context, $Descriptor, [string]$Name, [switch]$RetirementRequested
) {
    if (-not $Context.ContainsKey('HistoryHandoffLockObserver') -or
        $Context.HistoryHandoffLockObserver -ne $true -or
        -not $Context.HistoryHandoffLock.DirectoryRetired -or
        $Context.ContainsKey('HistoryHandoffRestartLock') -or
        $Context.ContainsKey('HistoryHandoffRestartLockPublisher') -or
        $Context.ContainsKey('HistoryHandoffRestartOwnerPublisher') -or
        $Context.ContainsKey('HistoryHandoffRestartCommitter') -or
        $Context.ContainsKey('HistoryHandoffRestartCommitted')) {
        throw 'Restart lock observation bootstrap differs.'
    }
    $file = Open-AgentsChatRetirementFile $Context $Descriptor $Name
    $record = Read-AgentsChatRetirementJson ($file.ReadText()) -AllowNull
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'newOwner', 'lockIdentity', 'lock', 'creator', 'committedAt'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-restart-committed' -or
        $Name -cne "inactive-handoff-$($record.attemptId)-committed.json") {
        throw 'Restart committed observation scope differs.'
    }
    Assert-AgentsChatRetirementIdentity $record.lockIdentity
    Assert-AgentsChatRetirementDescriptor $record.lock 'lock\owner.json' 65536
    if ($record.committedAt -isnot [string]) { throw 'Restart committed timestamp differs.' }
    $retiredOwner = [ordered]@{
        path=$record.lock.path; dev=$record.lock.dev; ino=$record.lock.ino
        bytes=$record.lock.bytes; sha256=$record.lock.sha256
    }
    $root = @(Get-ChildItem -LiteralPath $Context.Control -Force | Where-Object { $_.Name -ieq 'lock' })
    if ($RetirementRequested -and $root.Count -eq 0) {
        # An absent or owner-retired directory stays provisional until the exact retirement intent is bound.
        $Context.HistoryHandoffRestartLock = @{
            Directory=$null; DirectoryIdentity=[ordered]@{ dev=$record.lockIdentity.dev; ino=$record.lockIdentity.ino }
            OwnerFile=$null; OwnerRetired=$true; DirectoryRetired=$true; OwnerDescriptor=$retiredOwner
        }
        $Context.HistoryHandoffRestartOwnerRetiredPending = $true
    } else {
        $directory = [Deployment.WindowsPrivateFile]::OpenDirectory((Join-Path $Context.Control 'lock'))
        $Context.Files.Add($directory)
        $identity = $directory.CaptureIdentity()
        if ($identity.Dev -cne $record.lockIdentity.dev -or $identity.Ino -cne $record.lockIdentity.ino) {
            throw 'Restart lock directory identity differs.'
        }
        if ($RetirementRequested -and @(Get-ChildItem -LiteralPath (Join-Path $Context.Control 'lock') -Force).Count -eq 0) {
            $Context.HistoryHandoffRestartLock = @{
                Directory=$directory; DirectoryIdentity=[ordered]@{ dev=$identity.Dev; ino=$identity.Ino }
                OwnerFile=$null; OwnerRetired=$true; OwnerDescriptor=$retiredOwner
            }
            $Context.HistoryHandoffRestartOwnerRetiredPending = $true
        } else {
            $owner = Open-AgentsChatRetirementFile $Context $record.lock 'lock\owner.json'
            $Context.HistoryHandoffRestartLock = @{
                Directory=$directory; DirectoryIdentity=[ordered]@{ dev=$identity.Dev; ino=$identity.Ino }
                OwnerFile=$owner; OwnerDescriptor=(Get-AgentsChatStoppedHandoffDescriptor $owner 'lock\owner.json')
            }
        }
    }
    $Context.HistoryHandoffRestartLockObserver = $true
    $Context.HistoryHandoffRestartCommittedPending = @{
        File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $Name)
        Creator=$record.creator; CommittedAt=$record.committedAt
    }
    Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
}

function Initialize-AgentsChatStoppedHistoryHandoffRestartCommittedObservation([hashtable]$Context, $Descriptor) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartObserver') -or
        $Context.HistoryHandoffRestartObserver -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartLockObserver') -or
        -not $Context.ContainsKey('HistoryHandoffRestartCommittedPending') -or
        $Context.ContainsKey('HistoryHandoffRestartCommitted') -or
        $Context.ContainsKey('HistoryHandoffRestartCommitter')) {
        throw 'Restart committed observation bootstrap differs.'
    }
    $pending = $Context.HistoryHandoffRestartCommittedPending
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-committed.json"
    Assert-AgentsChatRetirementDescriptor $Descriptor $name 65536
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($pending.Descriptor[$field] -cne $Descriptor[$field]) { throw 'Restart committed descriptor differs.' }
    }
    $null = $Context.Remove('HistoryHandoffRestartCommittedPending')
    $Context.HistoryHandoffRestartCommitted = $pending
    $Context.HistoryHandoffRestartCommittedObserver = $true
    Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
}

function Get-AgentsChatStoppedHistoryHandoffRestartCommittedObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        if (-not $Context.ContainsKey('HistoryHandoffRestartCommittedObserver') -or
            $Context.HistoryHandoffRestartCommittedObserver -ne $true -or
            -not $Context.ContainsKey('HistoryHandoffRestartLockObserver') -or
            $Context.HistoryHandoffRestartLockObserver -ne $true -or
            $Context.ContainsKey('HistoryHandoffRestartCommitter') -or
            $Context.ContainsKey('HistoryHandoffRestartLockPublisher') -or
            $Context.ContainsKey('HistoryHandoffRestartOwnerPublisher') -or
            $Context.ContainsKey('HistoryHandoffRestartStateIntender') -or
            $Context.ContainsKey('HistoryHandoffRestartStateWriter')) {
            throw 'Restart committed observation requires its independent native role.'
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
        $observed = Get-AgentsChatStoppedHistoryHandoffRestartPreparedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
        $lock = $Context.HistoryHandoffRestartLock
        return [ordered]@{
            status='restart-committed-observed'; attemptId=$observed.attemptId
            previousAttemptId=$observed.previousAttemptId; previousOperationId=$observed.previousOperationId
            project=$observed.project; prepared=$observed.prepared
            committed=$Context.HistoryHandoffRestartCommitted.Descriptor
            lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor
            runtimeAuthority=$false; lockAuthority=$false; taskAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart committed observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffRestartCommittedObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement, $Terminal, $Successor, $Abandoned, $Restart,
    $RestartCommitted
) {
    try {
        if ($null -eq $RestartCommitted) { throw 'Restart committed descriptor is required.' }
        return Open-AgentsChatStoppedHistoryHandoffRestartObservation $Control $ControllerPid $ControllerIdentity `
            $AttemptId $Prepared $Committed $Retirement $Terminal $Successor $Abandoned $Restart $RestartCommitted
    } catch {
        throw [InvalidOperationException]::new('Restart committed observation failed; retain evidence.', $_.Exception)
    }
}
