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
            if (@($entries | Where-Object Name -CEQ 'activation-intent.json').Count) {
                $expected = @('activation-intent.json', 'files-restored.json', 'owner.json')
                if ($Context.ActivationHistory) {
                    $expected = @($expected + 'activation-start-requested.json' | Sort-Object)
                    if ($Context.CompletionHistory -or
                        @($entries | Where-Object Name -CEQ 'activation-running.json').Count) {
                        $expected = @($expected + 'activation-running.json' | Sort-Object)
                    }
                    if (@($entries | Where-Object Name -CEQ 'activation-stopped.json').Count) {
                        $expected = @($expected + 'activation-stopped.json' | Sort-Object)
                    }
                    if ($Context.CompletionHistory) {
                        if ($expected -ccontains 'activation-stopped.json') {
                            throw 'Completed cold runtime cannot contain stopped history.'
                        }
                        $phases = @('prepared', 'policy-requested', 'policy-staged',
                            'release-requested', 'released', 'policy-restore-requested', 'policy-restored',
                            'enable-requested', 'complete')
                        if ($Context.CompletionRecovery) {
                            $count = 0
                            while ($count -lt $phases.Count -and
                                @($entries | Where-Object Name -CEQ "completion-$($phases[$count]).json").Count) { $count++ }
                            if ($count -lt 4) { throw 'Cold completion recovery requires at least release intent.' }
                            $phases = $phases[0..($count - 1)]
                        }
                        $Context.CompletionPhases = $phases
                        $expected = @($expected + @($phases | ForEach-Object { "completion-$_.json" }) | Sort-Object)
                    }
                    if ($Context.PolicyRecovery) {
                        $policy = @($entries | Where-Object { $_.Name -cmatch '^policy-[0-9]{6}\.json$' })
                        $policyBytes = 0
                        foreach ($entry in $policy) {
                            if ($entry.PSIsContainer) { throw 'Cold policy recovery record is not a file.' }
                            $policyBytes += $entry.Length
                        }
                        if ($policy.Count -gt 256 -or $policyBytes -gt 16777216) {
                            throw 'Cold policy recovery exceeds its retained journal budget.'
                        }
                        $expected = @($expected + @($policy | ForEach-Object Name) | Sort-Object)
                    }
                }
            }
        }
        $maximum = if ($Context.ActivationHistory) { 4194304 } else { 65536 }
        if ((@($entries | ForEach-Object Name) -join ',') -cne ($expected -join ',') -or
            @($entries | Where-Object { $_.PSIsContainer -or $_.Length -gt $maximum }).Count) {
            throw 'Incomplete or foreign cold restore owner evidence.'
        }
        $Context.RecoveryFiles[$name] = $expected
        foreach ($entry in $entries) { $null = Open-AgentsChatCompletionFile $Context $entry.FullName '' }
    }
    Assert-AgentsChatStoppedRestoreRecoveryInventory $Context
}
