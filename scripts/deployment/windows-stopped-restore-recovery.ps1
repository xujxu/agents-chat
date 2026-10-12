function Get-AgentsChatStoppedRestoreRecoveryNames([hashtable]$Context) {
    return @(@('recovery-lock', 'cold-restore-staging') | Where-Object {
        Test-Path -LiteralPath (Join-Path $Context.Control $_)
    })
}

function Assert-AgentsChatStoppedRestoreRecoveryInventory([hashtable]$Context) {
    $Context.Stage = 'recovery-inventory'
    $names = @(Get-AgentsChatStoppedRestoreRecoveryNames $Context)
    if (($names -join ',') -cne ($Context.RecoveryNames -join ',')) {
        throw 'Original cold restore recovery inventory changed.'
    }
    foreach ($name in $names) {
        $entries = @(Get-ChildItem -LiteralPath (Join-Path $Context.Control $name) -Force | Sort-Object Name)
        $expected = $Context.RecoveryFiles[$name]
        if (@($entries | Where-Object PSIsContainer).Count -or
            (@($entries | ForEach-Object Name) -join ',') -cne ($expected -join ',')) {
            throw 'Original cold restore owner inventory changed.'
        }
    }
}

function Open-AgentsChatStoppedRestoreRecoveryFiles([hashtable]$Context) {
    $Context.Stage = 'recovery-evidence'
    $Context.RecoveryNames = @(Get-AgentsChatStoppedRestoreRecoveryNames $Context)
    $Context.RecoveryFiles = @{}
    foreach ($name in $Context.RecoveryNames) {
        $directory = Join-Path $Context.Control $name
        $Context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        $entries = @(Get-ChildItem -LiteralPath $directory -Force | Sort-Object Name)
        if ($entries.Count -eq 0 -and $name -ceq 'cold-restore-staging') {
            $Context.RecoveryFiles[$name] = @()
            continue
        }
        $expected = @('owner.json')
        if ($name -ceq 'recovery-lock' -and @($entries | Where-Object Name -CEQ 'files-restored.json').Count) {
            $expected = @('files-restored.json', 'owner.json')
        }
        if ((@($entries | ForEach-Object Name) -join ',') -cne ($expected -join ',') -or
            @($entries | Where-Object { $_.PSIsContainer -or $_.Length -gt 65536 }).Count) {
            throw 'Incomplete or foreign cold restore owner evidence.'
        }
        $Context.RecoveryFiles[$name] = $expected
        foreach ($entry in $entries) { $null = Open-AgentsChatCompletionFile $Context $entry.FullName '' }
    }
    Assert-AgentsChatStoppedRestoreRecoveryInventory $Context
}
