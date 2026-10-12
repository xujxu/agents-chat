param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$OwnerSha256,
    [Parameter(Mandatory)][string]$ReceiptSha256,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$proof = $watch = $null
$failure = $null
$stage = 'bootstrap'

function Assert-AgentsChatColdRetirementEvidence {
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original cold retirement controller changed.'
    }
    foreach ($file in $proof.Files) { $file.Check() }
    Assert-AgentsChatStoppedRestoreInventory $proof
    Assert-AgentsChatStoppedRestoreOwnerAbsent $proof
    $task = $proof.Folder.GetTask($proof.TaskName)
    if ($task.Path -cne "\$($proof.TaskName)" -or $task.Enabled -or
        [string]$task.Xml -cne $proof.Definition -or
        [string]$task.GetSecurityDescriptor(7) -cne $proof.SecurityDescriptor) {
        throw 'Original cold retirement task policy changed.'
    }
    return $task
}

try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or
        $OwnerSha256 -cnotmatch '^[a-f0-9]{64}$' -or $ReceiptSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Unsupported cold retirement platform or receipt digests.'
    }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'))
    . (Join-Path $PSScriptRoot 'windows-stopped-restore-proof.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'proof-open'
    $proof = Open-AgentsChatStoppedRestoreProof -Control $Control -Recovery
    $stage = 'cold-owner'
    $ownerFile = Open-AgentsChatCompletionFile $proof (Join-Path $Control 'recovery-lock/owner.json') $OwnerSha256
    $record = $ownerFile.ReadText() | ConvertFrom-Json
    $owner = Read-AgentsChatMaintenanceFields ($record.owner | ConvertTo-Json -Compress) `
        @('version', 'project', 'token', 'operationId', 'pid', 'processIdentity', 'createdAt')
    if ($owner.version.GetInt32() -ne 1 -or $owner.pid.GetInt32() -ne $ControllerPid -or
        $owner.processIdentity.GetString() -cne $ControllerIdentity -or
        $record.stateSha256 -cne $proof.StateSha256 -or
        $record.lock.operationId -cne $proof.OperationId) {
        throw 'Cold retirement owner differs from the original recovery controller.'
    }
    $stage = 'completed-files'
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
        throw 'Cold retirement requires the current original completed-file receipt.'
    }
    $null = Assert-AgentsChatStoppedRestoreProof $proof
    $null = Assert-AgentsChatColdRetirementEvidence
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        controllerIdentity=$ControllerIdentity; control=$Control; ownerSha256=$OwnerSha256; receiptSha256=$ReceiptSha256
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $stage = 'request'
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
    $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
    if ($request.id.GetInt32() -ne 1 -or $request.method.GetString() -cne 'retire') {
        throw 'Invalid cold retirement request.'
    }
    $null = Assert-AgentsChatStoppedRestoreProof $proof
    $null = Assert-AgentsChatColdRetirementEvidence
    $admission = $proof.Admission
    if (-not $proof.AbsentOwner) {
        $stage = 'retirement'
        $reply = [Deployment.WindowsRuntimeControl]::Exchange([guid]$admission.generation.GetString(),
            $admission.ownerPid.GetInt32(), $admission.ownerIdentity.GetString(), 'retire', 15000)
        if ($reply -cne 'retired' -or -not $proof.Owner.WaitForExit(15000) -or $proof.Owner.ExitCode -ne 0) {
            throw 'Original cold runtime retirement was not acknowledged and settled.'
        }
    }
    $stage = 'settlement'
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ((Assert-AgentsChatColdRetirementEvidence).GetInstances(0).Count -ne 0) {
        if ($deadline.ElapsedMilliseconds -ge 15000) { throw 'Original cold runtime Scheduler instance did not settle.' }
        Start-Sleep -Milliseconds 100
    }
    Assert-AgentsChatCompletionProcessAbsent $admission.ownerPid.GetInt32() $admission.ownerIdentity.GetString()
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$admission.generation.GetString(), $proof.RuntimeSessionId)
    if ((Assert-AgentsChatColdRetirementEvidence).GetInstances(0).Count -ne 0) {
        throw 'Original cold runtime instance changed after settlement.'
    }
    $stage = 'close'
    Close-AgentsChatTaskCompletionProof $proof
    $proof = $null
    [Console]::Out.WriteLine((@{
        id=1; type='reply'; value='retired'; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Cold runtime retirement refused: $stage. $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($proof, $watch)) {
        if (-not $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Cold runtime retirement cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Cold retirement and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
