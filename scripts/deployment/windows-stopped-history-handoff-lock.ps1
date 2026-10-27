function Assert-AgentsChatStoppedHistoryHandoffLock([hashtable]$Context) {
    $publisher = $Context.ContainsKey('HistoryHandoffLockPublisher') -and $Context.HistoryHandoffLockPublisher -eq $true
    $observer = $Context.ContainsKey('HistoryHandoffLockObserver') -and $Context.HistoryHandoffLockObserver -eq $true
    if ($publisher -eq $observer -or
        -not $Context.ContainsKey('HistoryHandoffLock') -or
        -not $Context.ContainsKey('HistoryCompletion') -or
        $Context.Prefix -ne $Context.Record.entries.Count) {
        throw 'Handoff lock lacks retained native publication proof.'
    }
    if ($observer -and -not $Context.ContainsKey('HistoryHandoffObservedCommit')) {
        throw 'Handoff lock lacks retained committed observation.'
    }
    $lock = $Context.HistoryHandoffLock
    $request = $lock.OwnerRequest
    $owner = if ($observer) { Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request }
        else { New-AgentsChatStoppedHistoryHandoffOwner @request }
    if (($owner | ConvertTo-Json -Compress) -cne $lock.OwnerText) { throw 'Handoff lock live owner differs.' }
    $root = @(Get-ChildItem -LiteralPath $Context.Control -Force |
        Where-Object { $_.Name -ieq 'lock' })
    if ($lock.DirectoryRetired) {
        if (-not $observer -or -not $lock.OwnerRetired -or $null -ne $lock.Directory -or
            $null -ne $lock.DirectoryRetirement -or $null -ne $lock.OwnerFile -or
            $null -ne $lock.OwnerRetirement -or
            -not $Context.ContainsKey('HistoryHandoffLockRetirementObserver') -or
            $Context.HistoryHandoffLockRetirementObserver -ne $true) {
            throw 'Retired handoff directory lacks its explicit retained intent proof.'
        }
        Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent $Context
        if ($root.Count) { throw 'Retired handoff directory unexpectedly exists.' }
        $null = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request
        return
    }
    $directoryTarget = $null -ne $lock.DirectoryRetirement
    if ($directoryTarget) {
        if (-not $observer -or -not $lock.OwnerRetired -or $null -ne $lock.Directory -or
            $null -ne $lock.OwnerFile -or $null -ne $lock.OwnerRetirement -or
            -not $Context.ContainsKey('HistoryHandoffLockDirectoryRetirementExecutor') -or
            $Context.HistoryHandoffLockDirectoryRetirementExecutor -ne $true) {
            throw 'Handoff directory target lacks its independent retained proof.'
        }
        $lock.DirectoryRetirement.Check()
    } else {
        $lock.Directory.Check()
        $identity = $lock.Directory.CaptureIdentity()
        if ($identity.Dev -cne $lock.DirectoryIdentity.dev -or
            $identity.Ino -cne $lock.DirectoryIdentity.ino) { throw 'Handoff lock directory identity differs.' }
    }
    if ($root.Count -ne 1 -or $root[0].Name -cne 'lock' -or -not $root[0].PSIsContainer) {
        throw 'Handoff lock root inventory differs.'
    }
    if ($directoryTarget) {
        $lock.DirectoryRetirement.CheckEmpty()
        $children = @()
    } else {
        $children = @(Get-ChildItem -LiteralPath (Join-Path $Context.Control 'lock') -Force)
    }
    if ($null -ne $lock.OwnerRetirement) {
        if (-not $observer -or $lock.OwnerRetired -or $null -ne $lock.OwnerFile -or
            -not $Context.ContainsKey('HistoryHandoffLockRetirementObserver') -or
            $Context.HistoryHandoffLockRetirementObserver -ne $true -or
            -not $Context.ContainsKey('HistoryHandoffLockRetirementExecutor') -or
            $Context.HistoryHandoffLockRetirementExecutor -ne $true) {
            throw 'Handoff owner retirement target lacks its independent retained proof.'
        }
        Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent $Context
        if ($children.Count -ne 1 -or $children[0].PSIsContainer -or $children[0].Name -cne 'owner.json') {
            throw 'Handoff retirement target inventory differs.'
        }
        $lock.OwnerRetirement.Check()
    } elseif ($null -eq $lock.OwnerFile) {
        if ($observer) {
            if (-not $lock.OwnerRetired -or
                -not $Context.ContainsKey('HistoryHandoffLockRetirementObserver') -or
                $Context.HistoryHandoffLockRetirementObserver -ne $true) {
                throw 'Committed handoff observation requires its exact owner.'
            }
            Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent $Context
        } elseif ($lock.OwnerRetired) { throw 'Handoff publisher cannot adopt a retired owner.' }
        if ($children.Count) { throw 'Handoff lock directory is not empty.' }
    } else {
        if ($lock.OwnerRetired) { throw 'Retired handoff owner unexpectedly exists.' }
        if ($children.Count -ne 1 -or $children[0].PSIsContainer -or $children[0].Name -cne 'owner.json') {
            throw 'Handoff lock owner inventory differs.'
        }

        $lock.OwnerFile.Check()
        if ($lock.OwnerFile.ReadText() -cne $lock.OwnerText) { throw 'Handoff lock owner bytes differ.' }
        $descriptor = Get-AgentsChatStoppedHandoffDescriptor $lock.OwnerFile 'lock\owner.json'
        foreach ($name in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
            if ($descriptor[$name] -cne $lock.OwnerDescriptor[$name]) { throw 'Handoff lock owner descriptor differs.' }
        }
    }
    if ($directoryTarget) { $lock.DirectoryRetirement.Check() }
    else { $lock.Directory.Check() }
    if ($observer) { $null = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request }
    else { $null = New-AgentsChatStoppedHistoryHandoffOwner @request }
}

function Get-AgentsChatStoppedHistoryHandoffLockOwnerDescriptor([hashtable]$Context) {
    Assert-AgentsChatStoppedHistoryHandoffLock $Context
    $lock = $Context.HistoryHandoffLock
    if ($null -ne $lock.OwnerFile) {
        return Get-AgentsChatStoppedHandoffDescriptor $lock.OwnerFile 'lock\owner.json'
    }
    if (-not $lock.OwnerRetired -and $null -eq $lock.OwnerRetirement) {
        throw 'Handoff original owner descriptor is unavailable.'
    }
    Assert-AgentsChatRetirementDescriptor $lock.OwnerDescriptor 'lock\owner.json' 65536
    return $lock.OwnerDescriptor
}
