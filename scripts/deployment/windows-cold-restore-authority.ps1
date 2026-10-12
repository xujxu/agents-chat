. (Join-Path $PSScriptRoot 'windows-stopped-restore-proof.ps1')

function Open-AgentsChatColdRestoreAuthority {
    param(
        [string]$Control, [string]$OwnerSha256, [string]$ReceiptSha256,
        [int]$ControllerPid, [string]$ControllerIdentity
    )
    $proof = Open-AgentsChatStoppedRestoreProof -Control $Control -Recovery
    try {
        $ownerFile = Open-AgentsChatCompletionFile $proof (Join-Path $Control 'recovery-lock/owner.json') $OwnerSha256
        $record = $ownerFile.ReadText() | ConvertFrom-Json
        $document = [Text.Json.JsonDocument]::Parse($ownerFile.ReadText())
        try {
            $owner = Read-AgentsChatMaintenanceFields ($document.RootElement.GetProperty('owner').GetRawText()) `
                @('version', 'project', 'token', 'operationId', 'pid', 'processIdentity', 'createdAt')
        } finally { $document.Dispose() }
        if ($owner.version.GetInt32() -ne 1 -or $owner.pid.GetInt32() -ne $ControllerPid -or
            $owner.processIdentity.GetString() -cne $ControllerIdentity -or
            $record.stateSha256 -cne $proof.StateSha256 -or
            $record.lock.operationId -cne $proof.OperationId) {
            throw 'Cold restore owner differs from the original recovery controller.'
        }
        $receiptFile = Open-AgentsChatCompletionFile $proof (Join-Path $Control 'recovery-lock/files-restored.json') $ReceiptSha256
        $receipt = Read-AgentsChatMaintenanceFields ($receiptFile.ReadText()) @(
            'version', 'phase', 'ownerSha256', 'operationId', 'backupId', 'snapshotSha256', 'stateSha256', 'runtimeBundle')
        $runtime = Read-AgentsChatMaintenanceFields ($receipt.runtimeBundle.GetRawText()) @('directory', 'configuration', 'sha256')
        $directory = Join-Path $Control "runtime-$($owner.operationId.GetString())"
        if ($receipt.version.GetInt32() -ne 1 -or $receipt.phase.GetString() -cne 'files-restored' -or
            $receipt.ownerSha256.GetString() -cne $OwnerSha256 -or
            $receipt.operationId.GetString() -cne $proof.OperationId -or
            $receipt.backupId.GetString() -cne $record.backupId -or
            $receipt.snapshotSha256.GetString() -cne $record.snapshotSha256 -or
            $receipt.stateSha256.GetString() -cne $proof.StateSha256 -or
            $runtime.directory.GetString() -cne $directory -or
            $runtime.configuration.GetString() -cne (Join-Path $directory 'configuration.json') -or
            $runtime.sha256.GetString() -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Cold restore requires the current original completed-file receipt.'
        }
        $proof.ColdOwner = $owner
        $proof.ColdRecord = $record
        $proof.ColdReceipt = $receipt
        $proof.ColdRuntime = $runtime
        $proof.ColdControllerPid = $ControllerPid
        $proof.ColdControllerIdentity = $ControllerIdentity
        $null = Assert-AgentsChatStoppedRestoreProof $proof
        return $proof
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $proof }
        catch { throw [AggregateException]::new('Cold authority and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Assert-AgentsChatColdRestoreAuthority([hashtable]$Proof) {
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($Proof.ColdControllerPid) -cne $Proof.ColdControllerIdentity) {
        throw 'Original cold restore controller changed.'
    }
    foreach ($file in $Proof.Files) { $file.Check() }
    Assert-AgentsChatStoppedRestoreInventory $Proof
    Assert-AgentsChatStoppedRestoreOwnerAbsent $Proof
}
