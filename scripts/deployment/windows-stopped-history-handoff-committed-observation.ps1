. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-observation.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock.ps1')

function Initialize-AgentsChatStoppedHistoryHandoffCommittedObservation([hashtable]$Context, $Request) {
    $hasRetirement = $Request -is [Collections.IDictionary] -and $Request.Contains('retirement')
    $fields = @('attemptId', 'prepared', 'committed', 'controllerPid', 'controllerIdentity')
    if ($hasRetirement) { $fields += 'retirement' }
    Assert-AgentsChatRetirementFields $Request $fields
    Assert-AgentsChatCompletionGuid $Request.attemptId
    Assert-AgentsChatCompletionProcessIdentity $Request.controllerPid $Request.controllerIdentity
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($Request.controllerPid) -cne $Request.controllerIdentity -or
        -not $Context.ContainsKey('HistoryRecord') -or $Context.ContainsKey('HistoryWriter') -or
        $Context.ContainsKey('HistoryHandoffLock') -or $Context.ContainsKey('HistoryHandoffLockPublisher')) {
        throw 'Committed handoff observation bootstrap differs.'
    }
    $preparedName = "inactive-handoff-$($Request.attemptId)-prepared.json"
    $committedName = "inactive-handoff-$($Request.attemptId)-committed.json"
    Assert-AgentsChatRetirementDescriptor $Request.prepared $preparedName 1048576
    Assert-AgentsChatRetirementDescriptor $Request.committed $committedName 65536
    $names = @($preparedName, $committedName)
    if ($hasRetirement) {
        $retirementName = "inactive-handoff-$($Request.attemptId)-lock-retirement.json"
        Assert-AgentsChatRetirementDescriptor $Request.retirement $retirementName 65536
        $names += $retirementName
    }
    Assert-AgentsChatStoppedHistoryHandoffNamespace $Context $names
    $prepared = Open-AgentsChatRetirementFile $Context $Request.prepared $preparedName
    $committed = Open-AgentsChatRetirementFile $Context $Request.committed $committedName
    $record = Read-AgentsChatRetirementJson ($committed.ReadText())
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'newOwner', 'lockIdentity', 'lock', 'creator', 'committedAt'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-committed' -or
        $record.attemptId -cne $Request.attemptId -or $record.control -cne $Context.Control -or
        $record.project -cne $Context.Project -or $record.previousOperationId -cne $Context.OperationId) {
        throw 'Committed handoff scope differs.'
    }
    Assert-AgentsChatRetirementDescriptor $record.prepared $preparedName 1048576
    $preparedDescriptor = Get-AgentsChatStoppedHandoffDescriptor $prepared $preparedName 1048576
    foreach ($name in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($record.prepared[$name] -cne $preparedDescriptor[$name]) { throw 'Committed prepared descriptor differs.' }
    }
    Assert-AgentsChatRetirementFields $record.newOwner @(
        'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt'
    )
    if ($record.newOwner.pid -isnot [int]) { throw 'Committed owner PID differs.' }
    $ownerRequest = @{
        Project=$Context.Project; PreviousOperationId=$Context.OperationId; AttemptId=$Request.attemptId
        OperationId=$record.newOwner.operationId; Token=$record.newOwner.token; CreatedAt=$record.newOwner.createdAt
        PreviousUpdatedAt=(Get-AgentsChatStoppedHistoryHandoffStateUpdatedAt $Context)
        ControllerPid=$record.newOwner.pid; ControllerIdentity=$record.newOwner.processIdentity
    }
    $owner = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @ownerRequest
    Assert-AgentsChatRetirementCreator $record.creator $Request.controllerPid $Request.controllerIdentity
    if ($record.creator.pid -ne $owner.pid -or $record.creator.processIdentity -cne $owner.processIdentity) {
        throw 'Committed creator differs from its original owner.'
    }
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $style = [Globalization.DateTimeStyles]::AssumeUniversal
    $timestamp = [DateTimeOffset]::ParseExact($record.committedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
    $created = [DateTimeOffset]::ParseExact($owner.createdAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
    if ($timestamp -lt $created -or
        $timestamp.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $culture) -cne $record.committedAt) {
        throw 'Committed timestamp differs.'
    }
    Assert-AgentsChatRetirementIdentity $record.lockIdentity
    Assert-AgentsChatRetirementDescriptor $record.lock 'lock\owner.json' 65536
    $directory = $null
    $directoryRetired = $hasRetirement -and -not (Test-Path -LiteralPath (Join-Path $Context.Control 'lock'))
    $directoryIdentity = $record.lockIdentity
    if (-not $directoryRetired) {
        $directory = [Deployment.WindowsPrivateFile]::OpenDirectory((Join-Path $Context.Control 'lock'))
        $Context.Files.Add($directory)
        $identity = $directory.CaptureIdentity()
        if ($identity.Dev -cne $record.lockIdentity.dev -or $identity.Ino -cne $record.lockIdentity.ino) {
            throw 'Committed lock directory identity differs.'
        }
        $directoryIdentity = [ordered]@{ dev=$identity.Dev; ino=$identity.Ino }
    }
    $ownerText = $owner | ConvertTo-Json -Compress
    $ownerFile = $null
    $ownerRetired = $directoryRetired -or
        ($hasRetirement -and -not (Test-Path -LiteralPath (Join-Path $Context.Control 'lock\owner.json')))
    if ($ownerRetired) {
        if (-not $directoryRetired -and
            @(Get-ChildItem -LiteralPath (Join-Path $Context.Control 'lock') -Force).Count) {
            throw 'Retired owner directory has unexpected children.'
        }
        $ownerDescriptor = $record.lock
    } else {
        $ownerFile = Open-AgentsChatRetirementFile $Context $record.lock 'lock\owner.json'
        if ($ownerFile.ReadText() -cne $ownerText) { throw 'Committed lock owner bytes differ.' }
        $ownerDescriptor = Get-AgentsChatStoppedHandoffDescriptor $ownerFile 'lock\owner.json'
    }
    $Context.HistoryHandoffLock = @{
        Directory=$directory; DirectoryIdentity=$directoryIdentity
        OwnerRequest=$ownerRequest; OwnerText=$ownerText; OwnerFile=$ownerFile
        OwnerDescriptor=$ownerDescriptor; OwnerRetirement=$null; OwnerRetired=$ownerRetired
        DirectoryRetirement=$null; DirectoryRetired=$directoryRetired
    }
    $Context.HistoryHandoffObservedCommit = @{
        AttemptId=$Request.attemptId; PreparedName=$preparedName; CommittedName=$committedName
        Prepared=$prepared; Committed=$committed
        PreparedDescriptor=$preparedDescriptor
        CommittedDescriptor=(Get-AgentsChatStoppedHandoffDescriptor $committed $committedName)
        Creator=$record.creator; CommittedAt=$record.committedAt
        ControllerPid=$Request.controllerPid; ControllerIdentity=$Request.controllerIdentity
    }
    $Context.HistoryHandoffLockObserver = $true
    if ($hasRetirement) {
        Initialize-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $Request.retirement
    }
}

function Get-AgentsChatStoppedHistoryHandoffCommittedNamespace([hashtable]$Context) {
    $retained = $Context.HistoryHandoffObservedCommit
    $names = @($retained.PreparedName, $retained.CommittedName)
    if ($Context.ContainsKey('HistoryHandoffLockRetirementIntent')) {
        Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent $Context
        $names += $Context.HistoryHandoffLockRetirementIntent.Descriptor.path
    }
    return $names
}

function Get-AgentsChatStoppedHistoryHandoffCommittedObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        if (-not $Context.ContainsKey('HistoryHandoffLockObserver') -or
            $Context.HistoryHandoffLockObserver -ne $true -or
            -not $Context.ContainsKey('HistoryHandoffObservedCommit')) {
            throw 'Committed observation requires its independent native role.'
        }
        $retained = $Context.HistoryHandoffObservedCommit
        if ($retained.ControllerPid -ne $ControllerPid -or $retained.ControllerIdentity -cne $ControllerIdentity) {
            throw 'Committed observer controller differs.'
        }
        foreach ($pass in @(1, 2)) {
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
                throw 'Committed observer identity differs.'
            }
            $names = Get-AgentsChatStoppedHistoryHandoffCommittedNamespace $Context
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context $names
            Assert-AgentsChatStoppedHistoryHandoffRetiredPreparedBinding $Context $retained.Prepared $retained.AttemptId `
                $ControllerPid $ControllerIdentity
            Assert-AgentsChatRetirementCreator $retained.Creator $ControllerPid $ControllerIdentity
            $lock = $Context.HistoryHandoffLock
            $request = $lock.OwnerRequest
            $owner = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request
            $record = [ordered]@{
                version=1; phase='stopped-history-handoff-committed'; attemptId=$retained.AttemptId
                control=$Context.Control; project=$Context.Project
                controlIdentity=$Context.HistoryRecord.controlIdentity
                previousOperationId=$Context.OperationId
                prepared=(Get-AgentsChatStoppedHandoffDescriptor $retained.Prepared $retained.PreparedName 1048576)
                newOwner=$owner; lockIdentity=$lock.DirectoryIdentity
                lock=(Get-AgentsChatStoppedHistoryHandoffLockOwnerDescriptor $Context)
                creator=$retained.Creator; committedAt=$retained.CommittedAt
            }
            $actual = $expected = $null
            try {
                $retained.Committed.Check()
                $actual = [Text.Json.JsonDocument]::Parse($retained.Committed.ReadText())
                $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 8 -Compress))
                Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
            } finally {
                if ($actual) { $actual.Dispose() }
                if ($expected) { $expected.Dispose() }
            }
            foreach ($pair in @(
                @($retained.Prepared, $retained.PreparedDescriptor, 1048576),
                @($retained.Committed, $retained.CommittedDescriptor, 65536)
            )) {
                $descriptor = Get-AgentsChatStoppedHandoffDescriptor $pair[0] $pair[1].path $pair[2]
                foreach ($name in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
                    if ($descriptor[$name] -cne $pair[1][$name]) { throw 'Committed retained file descriptor differs.' }
                }
            }
            Assert-AgentsChatStoppedHistoryHandoffLock $Context
            $null = Assert-AgentsChatStoppedWorkerCleanup $Context
            $names = Get-AgentsChatStoppedHistoryHandoffCommittedNamespace $Context
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context $names
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
                throw 'Committed observer changed during observation.'
            }
        }
        return [ordered]@{
            status='committed-handoff-observed'; attemptId=$retained.AttemptId
            previousOperationId=$Context.OperationId; project=$Context.Project
            prepared=$retained.PreparedDescriptor; committed=$retained.CommittedDescriptor
            lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor
            runtimeAuthority=$false; lockAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Committed handoff observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffCommittedObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement
) {
    $scope = $null
    try {
        $request = @{
            attemptId=$AttemptId; prepared=$Prepared; committed=$Committed
            controllerPid=$ControllerPid; controllerIdentity=$ControllerIdentity
        }
        if ($null -ne $Retirement) { $request.retirement = $Retirement }
        $scope = Open-AgentsChatStoppedWorkerCleanup $Control -HistoryArchive -HistoryHandoffObservation $request
        $null = Get-AgentsChatStoppedHistoryHandoffCommittedObservation $scope $ControllerPid $ControllerIdentity
        return $scope
    } catch {
        $failure = $_.Exception
        if ($scope) {
            try { Close-AgentsChatTaskCompletionProof $scope }
            catch { $failure = [AggregateException]::new('Committed observation open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        }
        throw [InvalidOperationException]::new('Committed handoff observation failed; retain evidence.', $failure)
    }
}
