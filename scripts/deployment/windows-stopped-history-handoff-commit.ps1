. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-live.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-namespace.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock.ps1')

function New-AgentsChatStoppedHistoryHandoffLock(
    [hashtable]$Context, $Descriptor, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    if (-not $Context.ContainsKey('HistoryHandoffLockPublisher') -or
        $Context.HistoryHandoffLockPublisher -ne $true) {
        throw 'Handoff lock commit requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffCommit') -or $Context.ContainsKey('HistoryHandoffLock')) {
            throw 'Handoff lock already retained.'
        }
        $request = @{
            Project=$Context.Project; PreviousOperationId=$Context.OperationId
            AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
            PreviousUpdatedAt=(Get-AgentsChatStoppedHistoryHandoffStateUpdatedAt $Context)
            ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        }
        $owner = New-AgentsChatStoppedHistoryHandoffOwner @request
        $preparedName = "inactive-handoff-$AttemptId-prepared.json"
        $committedName = "inactive-handoff-$AttemptId-committed.json"
        Assert-AgentsChatRetirementDescriptor $Descriptor $preparedName 1048576
        $prepared = Open-AgentsChatRetirementFile $Context $Descriptor $preparedName
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName)
            Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding $Context $AttemptId $request $prepared
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName)
        }
        $createdTime = [DateTimeOffset]::ParseExact($CreatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        if ($createdTime -gt [DateTimeOffset]::UtcNow) { throw 'Handoff commit predates preparation.' }
        $directory = [Deployment.WindowsPrivateFile]::CreateDirectory((Join-Path $Context.Control 'lock'))
        $Context.Files.Add($directory)
        $identity = $directory.CaptureIdentity()
        $lock = @{
            Directory=$directory; DirectoryIdentity=[ordered]@{ dev=$identity.Dev; ino=$identity.Ino }
            OwnerRequest=$request; OwnerText=($owner | ConvertTo-Json -Compress)
            OwnerFile=$null; OwnerDescriptor=$null; OwnerRetirement=$null; OwnerRetired=$false
            DirectoryRetirement=$null; DirectoryRetired=$false
        }
        $Context.HistoryHandoffLock = $lock
        $Context.HistoryHandoffCommit = @{
            Prepared=$prepared; PreparedName=$preparedName; CommittedName=$committedName
            AttemptId=$AttemptId; Request=$request; Owner=$owner; CreatedTime=$createdTime
            Committed=$null
        }
        $null = Assert-AgentsChatStoppedWorkerCleanup $Context
        Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName)
        return $lock.DirectoryIdentity
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff lock commit failed; retain evidence.', $_.Exception)
    }
}

function Publish-AgentsChatStoppedHistoryHandoffLockOwner([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffLockPublisher') -or
        $Context.HistoryHandoffLockPublisher -ne $true) {
        throw 'Handoff lock commit requires its independent native role.'
    }
    try {
        if (-not $Context.ContainsKey('HistoryHandoffCommit') -or
            -not $Context.ContainsKey('HistoryHandoffLock')) { throw 'Handoff lock preparation is not retained.' }
        $commit = $Context.HistoryHandoffCommit
        $lock = $Context.HistoryHandoffLock
        if ($null -ne $lock.OwnerFile -or $null -ne $commit.Committed) { throw 'Handoff lock owner already published.' }
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($commit.PreparedName)
            Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding $Context $commit.AttemptId $commit.Request $commit.Prepared
            Assert-AgentsChatStoppedHistoryHandoffLock $Context
        }
        $lock.OwnerFile = [Deployment.WindowsPrivateFile]::Publish(
            (Join-Path $Context.Control 'lock\owner.json'), $lock.OwnerText)
        $Context.Files.Add($lock.OwnerFile)
        $lock.OwnerDescriptor = Get-AgentsChatStoppedHandoffDescriptor $lock.OwnerFile 'lock\owner.json'
        Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding $Context $commit.AttemptId $commit.Request $commit.Prepared
        Assert-AgentsChatStoppedHistoryHandoffLock $Context
        Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($commit.PreparedName)
        return $lock.OwnerDescriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff lock commit failed; retain evidence.', $_.Exception)
    }
}

function Complete-AgentsChatStoppedHistoryHandoffCommit([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffLockPublisher') -or
        $Context.HistoryHandoffLockPublisher -ne $true) {
        throw 'Handoff lock commit requires its independent native role.'
    }
    try {
        if (-not $Context.ContainsKey('HistoryHandoffCommit') -or
            -not $Context.ContainsKey('HistoryHandoffLock')) { throw 'Handoff lock preparation is not retained.' }
        $commit = $Context.HistoryHandoffCommit
        $lock = $Context.HistoryHandoffLock
        if ($null -eq $lock.OwnerFile -or $null -ne $commit.Committed) { throw 'Handoff commit requires its unpublished owner stage.' }
        $preparedName = $commit.PreparedName
        $committedName = $commit.CommittedName
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName)
            Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding $Context $commit.AttemptId $commit.Request $commit.Prepared
            Assert-AgentsChatStoppedHistoryHandoffLock $Context
        }
        $committedAt = [DateTimeOffset]::UtcNow
        if ($commit.CreatedTime -gt $committedAt) { throw 'Handoff commit predates preparation.' }
        $record = [ordered]@{
            version=1; phase='stopped-history-handoff-committed'; attemptId=$commit.AttemptId
            control=$Context.Control; project=$Context.Project
            controlIdentity=$Context.HistoryRecord.controlIdentity
            previousOperationId=$Context.OperationId
            prepared=(Get-AgentsChatStoppedHandoffDescriptor $commit.Prepared $preparedName 1048576)
            newOwner=$commit.Owner; lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor
            creator=[ordered]@{
                pid=$commit.Request.ControllerPid; processIdentity=$commit.Request.ControllerIdentity
                bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            }
            committedAt=$committedAt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        }
        $text = $record | ConvertTo-Json -Depth 8 -Compress
        $held = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $committedName), $text)
        $Context.Files.Add($held)
        $committed = Get-AgentsChatStoppedHandoffDescriptor $held $committedName
        $commit.CommittedFile = $held
        $commit.CommittedAt = $record.committedAt
        $commit.Committed = $committed
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName, $committedName)
            $held.Check()
            if ($held.ReadText() -cne $text) { throw 'Published committed handoff bytes differ.' }
            $actual = Get-AgentsChatStoppedHandoffDescriptor $held $committedName
            foreach ($name in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
                if ($actual[$name] -cne $committed[$name]) { throw 'Published committed handoff descriptor differs.' }
            }
            Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding $Context $commit.AttemptId $commit.Request $commit.Prepared
            Assert-AgentsChatStoppedHistoryHandoffLock $Context
            $null = Assert-AgentsChatStoppedWorkerCleanup $Context
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName, $committedName)
        }

        return $committed
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff lock commit failed; retain evidence.', $_.Exception)
    }
}

function Publish-AgentsChatStoppedHistoryHandoffCommitted(
    [hashtable]$Context, $Descriptor, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    $null = New-AgentsChatStoppedHistoryHandoffLock $Context $Descriptor `
        $ControllerPid $ControllerIdentity $AttemptId $OperationId $Token $CreatedAt
    $null = Publish-AgentsChatStoppedHistoryHandoffLockOwner $Context
    return Complete-AgentsChatStoppedHistoryHandoffCommit $Context
}
