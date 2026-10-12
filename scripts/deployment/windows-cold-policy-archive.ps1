function Release-AgentsChatColdJournalFiles([hashtable]$Context) {
    $identities = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Context.RecoveryFiles['recovery-lock']) {
        $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control "recovery-lock/$name") ''
        $identity = $file.CaptureIdentity()
        $null = $identities.Add("$($identity.Dev):$($identity.Ino)")
    }
    $directory = $Context.ColdRecord.guardIdentity
    $releasedDirectory = $false
    for ($index = $Context.Files.Count - 1; $index -ge 0; $index--) {
        $file = $Context.Files[$index]
        $release = $false
        if ($file -is [Deployment.WindowsPrivateFile+DirectoryLease]) {
            $identity = $file.CaptureIdentity()
            if ($identity.Dev -ceq $directory.dev -and $identity.Ino -ceq $directory.ino) {
                $release = $releasedDirectory = $true
            }
        } elseif ($file -is [Deployment.WindowsPrivateFile]) {
            $identity = $file.CaptureIdentity()
            $release = $identities.Contains("$($identity.Dev):$($identity.Ino)")
        }
        if ($release) {
            $file.Dispose()
            $Context.Files.RemoveAt($index)
        }
    }
    if (-not $releasedDirectory) { throw 'Original cold journal directory was not retained.' }
}

function Archive-AgentsChatColdPolicyJournal([hashtable]$Context) {
    if (-not $Context.PolicyRecovery -or $Context.Closed -or $Context.Poisoned -or $Context.Busy -or
        -not $Context.PolicyClaimed -or $Context.PolicyStep -cne 'restored') {
        throw 'Cold journal archival requires its original claimed restored policy.'
    }
    $null = Assert-AgentsChatColdActivationRecoveryProof $Context
    $Context.Busy = $true
    try {
        $identity = $Context.ColdRecord.guardIdentity
        $archive = Join-Path $Context.Control "cold-policy-$($Context.PolicySha256)"
        $result = [ordered]@{
            status='cold-policy-archived'; mutationAuthority=$false
            operationId=$Context.OperationId; taskName=$Context.TaskName
            policySha256=$Context.PolicySha256; archive=$archive
            identity=@{ dev=$identity.dev; ino=$identity.ino }
        }
        Release-AgentsChatColdJournalFiles $Context
        $held = [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement(
            (Join-Path $Context.Control 'recovery-lock'), $identity.dev, $identity.ino)
        $Context.Files.Add($held)
        $held.ArchiveTo($archive)
        $held.Check()
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Cold journal archival refused; preserve both namespaces and original evidence.', $_.Exception)
    } finally { $Context.Busy = $false }
    Close-AgentsChatTaskCompletionProof $Context
    return $result
}
