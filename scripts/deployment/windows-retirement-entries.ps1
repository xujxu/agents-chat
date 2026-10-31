function Remove-AgentsChatRetirementEntry {
    param([hashtable]$Context, $ManifestDescriptor, [scriptblock]$Assert, [scriptblock]$Completed)
    $null = & $Assert $Context
    $target = $null
    try {
        $index = $Context.Prefix
        $commit = $index -eq $Context.Record.entries.Count
        $entry = if ($commit) { $ManifestDescriptor } else { $Context.Record.entries[$index] }
        $original = if ($commit) { $Context.Marker } else { $Context.Entries[$index] }
        $original.Check()
        $original.Dispose()
        $null = $Context.Files.Remove($original)
        $file = Join-Path $Context.Control $entry.path
        $target = if (-not $commit -and $entry.kind -ceq 'directory') {
            [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement($file, $entry.dev, $entry.ino)
        } else {
            [Deployment.WindowsPrivateFile]::RetainForRetirement($file, $entry.sha256, $entry.dev, $entry.ino, $entry.bytes)
        }
        if (-not $commit) { $Context.Target = @{ Entry=$entry; Handle=$target } }
        $null = & $Assert $Context
        $target.Check()
        $target.Delete()
        $target = $null
        $Context.Target = $null
        if ($commit) {
            $result = & $Completed $Context
            Close-AgentsChatTaskCompletionProof $Context
            return $result
        }
        $Context.Entries[$index] = $null
        $Context.Prefix++
        return & $Assert $Context
    } catch {
        $Context.Poisoned = $true
        throw
    } finally {
        $Context.Target = $null
        if ($target) { $target.Dispose() }
    }
}
