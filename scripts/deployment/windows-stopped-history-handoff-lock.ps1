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
    $lock.Directory.Check()
    $identity = $lock.Directory.CaptureIdentity()
    if ($identity.Dev -cne $lock.DirectoryIdentity.dev -or
        $identity.Ino -cne $lock.DirectoryIdentity.ino) { throw 'Handoff lock directory identity differs.' }
    $root = @(Get-ChildItem -LiteralPath $Context.Control -Force |
        Where-Object { $_.Name -ieq 'lock' })
    if ($root.Count -ne 1 -or $root[0].Name -cne 'lock' -or -not $root[0].PSIsContainer) {
        throw 'Handoff lock root inventory differs.'
    }
    $request = $lock.OwnerRequest
    $owner = if ($observer) { Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request }
        else { New-AgentsChatStoppedHistoryHandoffOwner @request }
    if (($owner | ConvertTo-Json -Compress) -cne $lock.OwnerText) { throw 'Handoff lock live owner differs.' }
    $children = @(Get-ChildItem -LiteralPath (Join-Path $Context.Control 'lock') -Force)
    if ($null -eq $lock.OwnerFile) {
        if ($observer) { throw 'Committed handoff observation requires its exact owner.' }
        if ($children.Count) { throw 'Handoff lock directory is not empty.' }
    } else {
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
    $lock.Directory.Check()
    if ($observer) { $null = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request }
    else { $null = New-AgentsChatStoppedHistoryHandoffOwner @request }
}
