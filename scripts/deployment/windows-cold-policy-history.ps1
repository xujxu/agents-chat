function Get-AgentsChatColdPolicyBinding([hashtable]$Context) {
    $binding = [ordered]@{
        operationId=$Context.OperationId; taskName=$Context.TaskName
        ownerSha256=$Context.ColdOwnerSha256; filesReceiptSha256=$Context.ColdReceiptSha256
        intentSha256=$Context.ColdIntentSha256; historySha256=$Context.ColdHistorySha256
        stateSha256=$Context.StateSha256; sourceDefinition=$Context.ColdDefinition
        targetDefinition=$Context.Definition; securityDescriptor=$Context.SecurityDescriptor
    }
    if (-not $Context.Runtime) { $binding['launchSha256'] = $Context.ColdLaunchSha256 }
    return $binding
}

function Assert-AgentsChatColdPolicyOwnersAbsent([hashtable]$Context) {
    foreach ($owner in $Context.PolicyClaims) {
        if ($Context.PolicyClaimed -and
            $owner.controllerPid -eq $Context.PolicyControllerPid -and
            $owner.controllerIdentity -ceq $Context.PolicyControllerIdentity -and
            $owner.bridgePid -eq $PID -and $owner.bridgeIdentity -ceq $Context.PolicyBridgeIdentity) {
            continue
        }
        Assert-AgentsChatCompletionProcessAbsent $owner.controllerPid $owner.controllerIdentity
        Assert-AgentsChatCompletionProcessAbsent $owner.bridgePid $owner.bridgeIdentity
    }
}

function Read-AgentsChatColdPolicyHistory([hashtable]$Context, [string]$ExpectedSha256) {
    $Context.PolicyClaims = [Collections.Generic.List[hashtable]]::new()
    $Context.PolicyClaimed = $false
    $Context.PolicySequence = 0
    $Context.PolicyBytes = 0
    $Context.PolicySha256 = $Context.ColdHistorySha256
    $Context.PolicyDurableStep = 'initial'
    $Context.PolicyOwner = $null
    $binding = Get-AgentsChatColdPolicyBinding $Context
    $ownerFields = @('controllerPid', 'controllerIdentity', 'bridgePid', 'bridgeIdentity')
    $schema = @('version') + @($binding.Keys) + @('sequence', 'previousSha256') + $ownerFields + @('kind', 'step')
    $owners = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $names = @($Context.RecoveryFiles['recovery-lock'] | Where-Object { $_ -cmatch '^policy-[0-9]{6}\.json$' })
    if ($names.Count -gt 256) { throw 'Cold policy recovery exceeds its record budget.' }
    foreach ($name in $names) {
        $next = $Context.PolicySequence + 1
        if ($name -cne ('policy-{0:D6}.json' -f $next)) { throw 'Cold policy recovery sequence is incomplete.' }
        $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control "recovery-lock/$name") ''
        $Context.PolicyBytes += $file.ByteLength
        if ($file.ByteLength -gt 4194304 -or $Context.PolicyBytes -gt 16777216) {
            throw 'Cold policy recovery exceeds its byte budget.'
        }
        $record = Read-AgentsChatMaintenanceFields ($file.ReadText()) $schema
        if ($record.version.GetInt32() -ne 1 -or $record.sequence.GetInt32() -ne $next -or
            $record.previousSha256.GetString() -cne $Context.PolicySha256) {
            throw 'Cold policy recovery version, sequence or byte chain changed.'
        }
        foreach ($key in $binding.Keys) {
            if ($record[$key].GetString() -cne $binding[$key]) { throw 'Cold policy recovery binding changed.' }
        }
        $owner = @{
            controllerPid=$record.controllerPid.GetInt32(); controllerIdentity=$record.controllerIdentity.GetString()
            bridgePid=$record.bridgePid.GetInt32(); bridgeIdentity=$record.bridgeIdentity.GetString()
        }
        Assert-AgentsChatCompletionProcessIdentity $owner.controllerPid $owner.controllerIdentity
        Assert-AgentsChatCompletionProcessIdentity $owner.bridgePid $owner.bridgeIdentity
        if ($owner.controllerPid -eq $owner.bridgePid) { throw 'Cold policy controller and bridge identities overlap.' }
        $kind = $record.kind.GetString()
        $step = $record.step.GetString()
        if ($kind -ceq 'claim') {
            if ($step -cne $Context.PolicyDurableStep -or
                $owners.Contains($owner.controllerIdentity) -or $owners.Contains($owner.bridgeIdentity)) {
                throw 'Cold policy takeover changed its prior step or reused an owner.'
            }
            $null = $owners.Add($owner.controllerIdentity)
            $null = $owners.Add($owner.bridgeIdentity)
            $Context.PolicyOwner = $owner
            $Context.PolicyClaims.Add($owner)
        } else {
            $expected = if ($kind -ceq 'request' -and $Context.PolicyDurableStep -ceq 'initial') { 'requested' }
                elseif ($kind -ceq 'restored' -and $Context.PolicyDurableStep -ceq 'requested') { 'restored' }
                else { $null }
            if (-not $Context.PolicyOwner -or -not $expected -or $step -cne $expected) {
                throw 'Cold policy recovery transition lacks its original write-ahead step.'
            }
            foreach ($key in $ownerFields) {
                if ($owner[$key] -cne $Context.PolicyOwner[$key]) { throw 'Cold policy publisher was not claimed.' }
            }
            $Context.PolicyDurableStep = $step
        }
        $Context.PolicySequence = $next
        $Context.PolicySha256 = $file.Sha256
    }
    if ($Context.PolicySha256 -cne $ExpectedSha256) { throw 'Cold policy recovery journal differs from admission.' }
    Assert-AgentsChatColdPolicyOwnersAbsent $Context
    $task = $Context.Folder.GetTask($Context.TaskName)
    $definition = [string]$task.Xml
    $original = ([xml]$definition).OuterXml -ceq ([xml]$Context.Definition).OuterXml
    $guarded = Test-AgentsChatColdRecoveryDefinition $Context.ColdDefinition $definition `
        -Unacknowledged:($null -eq $Context.Runtime) -Enabled:([bool]$task.Enabled)
    if (($task.Enabled -and -not $guarded) -or (-not $original -and -not $guarded) -or
        ($Context.PolicyDurableStep -ceq 'initial' -and -not $guarded) -or
        ($Context.PolicyDurableStep -ceq 'restored' -and -not $original)) {
        throw 'Cold policy recovery lacks its exact guarded source or requested disabled target policy.'
    }
    $Context.CurrentDefinition = $definition
    $Context.CurrentEnabled = [bool]$task.Enabled
    $Context.PolicyStep = if ($Context.PolicyDurableStep -ceq 'requested' -and $original) {
        'policy-applied'
    } else { $Context.PolicyDurableStep }
}

function Write-AgentsChatColdPolicyRecord([hashtable]$Context, [string]$Kind, [string]$Step) {
    if ($Context.PolicySequence -ge 256) { throw 'Cold policy recovery exceeds its record budget.' }
    $record = [ordered]@{ version=1 }
    $binding = Get-AgentsChatColdPolicyBinding $Context
    foreach ($key in $binding.Keys) { $record[$key] = $binding[$key] }
    $owner = @{
        controllerPid=$Context.PolicyControllerPid; controllerIdentity=$Context.PolicyControllerIdentity
        bridgePid=$PID; bridgeIdentity=$Context.PolicyBridgeIdentity
    }
    $record['sequence'] = $Context.PolicySequence + 1
    $record['previousSha256'] = $Context.PolicySha256
    foreach ($key in @('controllerPid', 'controllerIdentity', 'bridgePid', 'bridgeIdentity')) {
        $record[$key] = $owner[$key]
    }
    $record['kind'] = $Kind
    $record['step'] = $Step
    $text = $record | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetByteCount($text)
    if ($bytes -gt 4194304 -or $Context.PolicyBytes + $bytes -gt 16777216) {
        throw 'Cold policy recovery exceeds its byte budget.'
    }
    $name = 'policy-{0:D6}.json' -f $record.sequence
    $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control "recovery-lock/$name"), $text)
    $Context.Files.Add($file)
    $Context.RecoveryFiles['recovery-lock'] = @(@($Context.RecoveryFiles['recovery-lock']) + $name | Sort-Object)
    $Context.PolicySequence = $record.sequence
    $Context.PolicySha256 = $file.Sha256
    $Context.PolicyBytes += $file.ByteLength
    $Context.PolicyDurableStep = $Step
    $Context.PolicyOwner = $owner
    if ($Kind -ceq 'claim') {
        $Context.PolicyClaims.Add($owner)
        $Context.PolicyClaimed = $true
    }
}
