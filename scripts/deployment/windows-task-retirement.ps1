function Test-AgentsChatRetirementPolicy([hashtable]$Context) {
    $Context.Stage = 'retirement-policy'
    $task = $Context.Folder.GetTask($Context.Data.taskName)
    $definition = if ($Context.ReplacementPrepared) { $Context.ReplacementDefinition } else { $Context.Definition }
    if ($task.Path -cne "\$($Context.Data.taskName)" -or $task.Enabled -or
        [string]$task.Xml -cne $definition -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor) {
        throw 'Original disabled task policy changed.'
    }
    return $task.GetInstances(0).Count
}

function Test-AgentsChatRetirementTransaction([hashtable]$Context) {
    $Context.Stage = 'retirement-transaction'
    if (-not $Context.Transaction) { throw 'Retirement requires original transaction authority.' }
    Assert-AgentsChatTaskTransaction $Context.Transaction
    $Context.Stage = 'retirement-phase'
    $expected = if ($Context.Transaction.Operation -ceq 'restore') { 'restore-activating' } else { 'activating' }
    if ($Context.Transaction.Phase -cne $expected) { throw 'Transaction is not ready for activation.' }
    if ($Context.RetirementRequested -and $Context.Transaction.StateSha256 -cne $Context.RetirementStateSha256) {
        throw 'Original activation state changed during retirement.'
    }
}

function Test-AgentsChatRetiredTaskContext([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or -not $Context.RetirementRequested) {
        throw 'Unavailable retirement context.'
    }
    $Context.Stage = 'retirement-identity'
    if ($Context.Controller.HasExited -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Controller.Id) -cne $Context.Data.controllerIdentity -or
        -not $Context.Owner.HasExited -or $Context.Owner.ExitCode -ne 0) {
        throw 'Original retirement processes differ.'
    }
    Test-AgentsChatRetirementTransaction $Context
    $Context.Stage = 'retirement-evidence'
    foreach ($file in $Context.Files) { $file.Check() }
    if ((Test-AgentsChatRetirementPolicy $Context) -ne 0) { throw 'Original task has not settled.' }
    Test-AgentsChatRetirementTransaction $Context
    $Context.Stage = 'retirement-evidence'
    foreach ($file in $Context.Files) { $file.Check() }
    if ($Context.Controller.HasExited -or (Test-AgentsChatRetirementPolicy $Context) -ne 0) {
        throw 'Retirement authority changed during observation.'
    }
}

function Write-AgentsChatTaskRetirementReceipt([hashtable]$Context, [string]$Phase) {
    $Context.Stage = 'retirement-receipt'
    $data = $Context.Data
    $record = [ordered]@{
        version=1; phase=$Phase; operationId=$data.operationId
        admissionSha256=$Context.AdmissionSha256; transactionSha256=$Context.Transaction.ReceiptSha256
        previousSha256=$Context.RetirementSha256; taskName=$data.taskName
        definition=$Context.Definition; securityDescriptor=$data.securityDescriptor
        ownerPid=$data.ownerPid; ownerIdentity=$data.ownerIdentity
        generation=$data.generation; instanceGuid=$data.instanceGuid; statePhase=$Context.Transaction.Phase
        stateSha256=$Context.RetirementStateSha256
    }
    $receipt = [Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Directory "task-retire-$Phase.json"), ($record | ConvertTo-Json -Depth 4 -Compress))
    $Context.Files.Add($receipt)
    $Context.RetirementSha256 = $receipt.Sha256
}

function Assert-AgentsChatTaskRetired {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    $Context.Busy = $true
    try {
        if (-not $Context.Retired) { throw 'Original task retirement is incomplete.' }
        Test-AgentsChatRetiredTaskContext $Context
        return [pscustomobject]@{ retired=$true; inhibited=$true }
    } catch {
        $Context.Poisoned = $true
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}

function Retire-AgentsChatTaskOwner {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    if ($Context.Retired) { return Assert-AgentsChatTaskRetired -Context $Context }
    $Context.Busy = $true
    try {
        if (-not $Context.Stopped -or -not $Context.Inhibited) { throw 'Original task is not stopped.' }
        Test-AgentsChatMaintenanceContext $Context $true
        Test-AgentsChatRetirementTransaction $Context
        $Context.RetirementSha256 = $Context.PreviousSha256
        $Context.RetirementStateSha256 = $Context.Transaction.StateSha256
        Write-AgentsChatTaskRetirementReceipt $Context 'requested'
        $Context.RetirementRequested = $true
        Test-AgentsChatMaintenanceContext $Context $true
        Test-AgentsChatRetirementTransaction $Context
        $Context.Stage = 'retirement-request'
        $reply = [Deployment.WindowsRuntimeControl]::Exchange([guid]$Context.Data.generation,
            $Context.Data.ownerPid, $Context.Data.ownerIdentity, 'retire', 15000)
        if ($reply -cne 'retired' -or -not $Context.Owner.WaitForExit(15000) -or $Context.Owner.ExitCode -ne 0) {
            throw 'Original task owner retirement was not acknowledged and settled.'
        }
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        while ((Test-AgentsChatRetirementPolicy $Context) -ne 0) {
            if ($deadline.ElapsedMilliseconds -ge 15000) { throw 'Original task instance did not settle.' }
            Start-Sleep -Milliseconds 100
        }
        Test-AgentsChatRetiredTaskContext $Context
        Write-AgentsChatTaskRetirementReceipt $Context 'complete'
        $Context.Retired = $true
        Test-AgentsChatRetiredTaskContext $Context
        return [pscustomobject]@{ retired=$true; inhibited=$true }
    } catch {
        $Context.Poisoned = $true
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}
