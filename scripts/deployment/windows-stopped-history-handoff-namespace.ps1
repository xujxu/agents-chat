function Assert-AgentsChatStoppedHistoryHandoffNamespace([hashtable]$Context, [string[]]$Names) {
    $expected = [Collections.Generic.HashSet[string]]::new($Names, [StringComparer]::Ordinal)
    if ($expected.Count -ne $Names.Count) { throw 'Duplicate expected handoff namespace entry.' }
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($entry.Name -notlike 'inactive-handoff-*') { continue }
        if ($entry.PSIsContainer -or -not $expected.Remove($entry.Name)) {
            throw 'Retired prepared handoff namespace differs.'
        }
    }
    if ($expected.Count) { throw 'Retired prepared handoff namespace is incomplete.' }
}
