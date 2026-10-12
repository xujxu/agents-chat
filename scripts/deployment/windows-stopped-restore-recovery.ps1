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
        $entries = @(Get-ChildItem -LiteralPath (Join-Path $Context.Control $name) -Force)
        $expected = if ($Context.RecoveryOwners.Contains($name)) { @('owner.json') } else { @() }
        if (@($entries | Where-Object PSIsContainer).Count -or
            (@($entries | ForEach-Object Name) -join ',') -cne ($expected -join ',')) {
            throw 'Original cold restore owner inventory changed.'
        }
    }
}

function Open-AgentsChatStoppedRestoreRecoveryFiles([hashtable]$Context) {
    $Context.Stage = 'recovery-evidence'
    $Context.RecoveryNames = @(Get-AgentsChatStoppedRestoreRecoveryNames $Context)
    $Context.RecoveryOwners = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Context.RecoveryNames) {
        $directory = Join-Path $Context.Control $name
        $Context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        $entries = @(Get-ChildItem -LiteralPath $directory -Force)
        if ($entries.Count -eq 0 -and $name -ceq 'cold-restore-staging') { continue }
        if ($entries.Count -ne 1 -or $entries[0].Name -cne 'owner.json' -or
            $entries[0].PSIsContainer -or $entries[0].Length -gt 65536) {
            throw 'Incomplete or foreign cold restore owner evidence.'
        }
        $null = $Context.RecoveryOwners.Add($name)
        $null = Open-AgentsChatCompletionFile $Context $entries[0].FullName ''
    }
    Assert-AgentsChatStoppedRestoreRecoveryInventory $Context
}
