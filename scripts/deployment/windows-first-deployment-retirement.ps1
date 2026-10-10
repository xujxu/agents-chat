. (Join-Path $PSScriptRoot 'windows-first-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-first-retirement-record.ps1')
. (Join-Path $PSScriptRoot 'windows-task-retirement-intent.ps1')
. (Join-Path $PSScriptRoot 'windows-task-retirement-checkpoint.ps1')
. (Join-Path $PSScriptRoot 'windows-deployment-retirement-evidence.ps1')

function New-AgentsChatFirstRetirementCandidate([hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity) {
    $completion = Assert-AgentsChatFirstCompletionProof $Context
    if ($completion.phase -cne 'complete' -or -not $Context.DeploymentReceiptPresent) {
        throw 'First retirement requires completed runtime and original final deployment receipt.'
    }
    $lockFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'lock\owner.json') ''
    $lock = Read-AgentsChatRetirementJson ($lockFile.ReadText())
    $workers = Get-AgentsChatCompletedWorkerEvidence $Context $lock
    $entries = [Collections.Generic.List[object]]::new()
    $directory = "first-task-$($Context.OperationId)"
    foreach ($name in $Context.RecordNames) {
        if ($name -ceq 'completion-release-requested') {
            $file = $Context.ReleaseIntentFile
            $identity = $file.CaptureIdentity()
            $entries.Add([ordered]@{
                kind='file'; path="$directory\$name.json"; dev=$identity.Dev; ino=$identity.Ino
                bytes=$file.ByteLength; sha256=$file.Sha256
            })
        } else { $entries.Add((Get-AgentsChatDeploymentRetirementFile $Context "$directory\$name.json")) }
    }
    $entries.Add((Get-AgentsChatDeploymentRetirementDirectory $Context $directory))
    foreach ($entry in $workers.entries) { $entries.Add($entry) }
    $entries.Add((Get-AgentsChatDeploymentRetirementFile $Context 'lock\owner.json'))
    $entries.Add((Get-AgentsChatDeploymentRetirementDirectory $Context 'lock'))
    $listener = $Context.ListenerRecord
    $candidate = [ordered]@{
        version=4; purpose='first-deployment'; control=$Context.Control; project=$Context.Project; lock=$lock
        publisher=[ordered]@{ pid=$Context.BridgePid; processIdentity=$Context.BridgeIdentity }
        state=(Get-AgentsChatRetirementFile $Context 'state.json')
        receipt=(Get-AgentsChatRetirementFile $Context 'deployment.json')
        controlIdentity=(Get-AgentsChatRetirementDirectory $Context $Context.Control)
        completion=$completion
        checkpoint=[ordered]@{
            configuration=$Context.Configuration
            definitionSha256=(Get-AgentsChatRetirementTextHash $Context.NativeDefinition)
            securityDescriptorSha256=(Get-AgentsChatRetirementTextHash $Context.SecurityDescriptor)
            enabled=$true
            listener=[ordered]@{
                pid=$listener.pid.GetInt32(); processIdentity=$listener.identity.GetString()
                address=$listener.address.GetString(); createdAt=$listener.createdAt.GetString()
                pairedRecords=$listener.pairedRecords.GetBoolean()
            }
        }
        entries=$entries.ToArray(); workerManifestSha256=$workers.manifestSha256
        creator=[ordered]@{ pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID) }
    }
    $candidate = Read-AgentsChatRetirementJson ($candidate | ConvertTo-Json -Depth 16 -Compress)
    $validation = @{ Control=$Context.Control; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity }
    Initialize-AgentsChatFirstRetirementRecord $validation $candidate
    $null = Assert-AgentsChatFirstCompletionProof $Context
    $Context.Candidate = $candidate
    $Context.Preparing = $true
    return $candidate
}

function Assert-AgentsChatFirstRetirementInventory([hashtable]$Context) {
    $Context.Stage = 'first-retirement-inventory'
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = $Context.Prefix; $index -lt $Context.Record.entries.Count; $index++) {
        $null = $expected.Add($Context.Record.entries[$index].path)
    }
    $null = $expected.Add('worker-retirement.json')
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($entry.Name -match '^(worker-|first-task-|task-retirement|service-)' -or
            $entry.Name -in @('task-maintenance', 'lock', 'recovery-lock', 'backup', '.deployment.json.staging')) {
            if (-not $expected.Remove($entry.Name)) { throw 'Unexpected first retirement inventory.' }
        }
    }
    foreach ($directory in @("first-task-$($Context.OperationId)", 'worker-engine', 'lock')) {
        $children = @($expected | Where-Object { $_.StartsWith("$directory\", [StringComparison]::Ordinal) })
        $present = Test-Path -LiteralPath (Join-Path $Context.Control $directory)
        if ($Context.Target -and $Context.Target.Entry.kind -ceq 'directory' -and $Context.Target.Entry.path -ceq $directory) {
            if ($children.Count -or -not $present) { throw 'First retirement directory is not the next empty target.' }
            $Context.Target.Handle.Check()
        } elseif ($present) {
            foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $Context.Control $directory) -Force) {
                if ($entry.PSIsContainer -or -not $expected.Remove("$directory\$($entry.Name)")) {
                    throw 'Unexpected nested first retirement evidence.'
                }
            }
        }
    }
    if ($expected.Count) { throw 'Remaining first retirement evidence disappeared.' }
}

function Get-AgentsChatFirstRetirementObservation([hashtable]$Context, [string]$Status = 'retiring') {
    return [ordered]@{
        status=$Status; operationId=$Context.OperationId; stateSha256=$Context.Record.state.sha256
        receiptSha256=$Context.Record.receipt.sha256; runtime=[pscustomobject]$Context.Runtime
        retiredEntries=$Context.Prefix; totalEntries=$Context.Record.entries.Count
        manifestSha256=$Context.MarkerSha256
    }
}

function Assert-AgentsChatFirstRetirementControllers([hashtable]$Context) {
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($Context.ControllerPid) -cne $Context.ControllerIdentity) {
        throw 'Current first retirement actor changed.'
    }
    Assert-AgentsChatFirstCompletionControllers $Context
    Assert-AgentsChatFirstRetirementCreator $Context $Context.Record.creator
}

function Assert-AgentsChatFirstDeploymentRetirement([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'First retirement authority is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatFirstRetirementControllers $Context
        Assert-AgentsChatFirstRetirementInventory $Context
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatCompletionRuntime $Context
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatFirstRetirementControllers $Context
        Assert-AgentsChatFirstRetirementInventory $Context
        Assert-AgentsChatCompletionFinalRuntime $Context
        return Get-AgentsChatFirstRetirementObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("First retirement refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatFirstDeploymentRetirement([string]$Control, [int]$ControllerPid, [string]$ControllerIdentity) {
    $context = @{
        Control=$Control; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        Files=[Collections.Generic.List[IDisposable]]::new(); Closed=$false; Poisoned=$false; Busy=$false
        Owner=$null; Instance=$null; Folder=$null; TaskFile=$null; Prefix=0; Target=$null; Preparing=$false
        Stage='first-retirement-marker'
    }
    try {
        $directory = [Deployment.WindowsPrivateFile]::OpenDirectory($Control)
        $context.Files.Add($directory)
        $markerPath = Join-Path $Control 'worker-retirement.json'
        $original = Open-AgentsChatCompletionFile $context $markerPath ''
        $identity = $original.CaptureIdentity()
        $sha256 = $original.Sha256
        $bytes = $original.ByteLength
        if ($bytes -gt 1048576) { throw 'Oversized first retirement marker.' }
        $record = Read-AgentsChatRetirementJson ($original.ReadText())
        Initialize-AgentsChatFirstRetirementRecord $context $record
        $rootIdentity = $directory.CaptureIdentity()
        if ($rootIdentity.Dev -cne $record.controlIdentity.dev -or $rootIdentity.Ino -cne $record.controlIdentity.ino) {
            throw 'Original first retirement control changed.'
        }
        $original.Dispose()
        $null = $context.Files.Remove($original)
        $context.Marker = [Deployment.WindowsPrivateFile]::OpenExclusive($markerPath, $sha256, $identity.Dev, $identity.Ino, $bytes)
        $context.Files.Add($context.Marker)
        $context.MarkerSha256 = $sha256
        $context.MarkerDescriptor = [ordered]@{
            path='worker-retirement.json'; dev=$identity.Dev; ino=$identity.Ino; bytes=$bytes; sha256=$sha256
        }
        $null = Open-AgentsChatRetirementFile $context $record.state 'state.json'
        $null = Open-AgentsChatRetirementFile $context $record.receipt 'deployment.json'
        $lockNames = @('version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
        $lock = Read-AgentsChatMaintenanceFields ($record.lock | ConvertTo-Json -Compress) $lockNames
        $state = Read-AgentsChatFirstAcceptedState $context $lock
        Read-AgentsChatFirstDeploymentReceipt $context $state
        $context.Stage = 'first-retirement-prefix'
        $context.Entries = [object[]]::new($record.entries.Count)
        $remaining = $false
        for ($index = 0; $index -lt $record.entries.Count; $index++) {
            $entry = $record.entries[$index]
            $file = Join-Path $Control $entry.path
            if (-not (Test-Path -LiteralPath $file)) {
                if ($remaining) { throw 'Non-prefix first retirement inventory.' }
                $context.Prefix++
                continue
            }
            $remaining = $true
            if ($entry.kind -ceq 'directory') {
                $retained = [Deployment.WindowsPrivateFile]::OpenDirectory($file)
                $context.Files.Add($retained)
            } else { $retained = Open-AgentsChatCompletionFile $context $file $entry.sha256 }
            $context.Entries[$index] = $retained
            $current = $retained.CaptureIdentity()
            if ($current.Dev -cne $entry.dev -or $current.Ino -cne $entry.ino -or
                ($entry.kind -ceq 'file' -and $retained.ByteLength -ne $entry.bytes)) {
                throw 'First retirement evidence was replaced.'
            }
        }
        if ($null -ne $context.Entries[-2]) {
            $originalLock = Read-AgentsChatMaintenanceFields ($context.Entries[-2].ReadText()) $lockNames
            Assert-AgentsChatCompletionFields $originalLock $lock $lockNames
        }
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenSourceDirectory($context.Project))
        Open-AgentsChatRetirementRuntime $context
        Retain-AgentsChatFirstCompletionTaskFile $context
        $null = Assert-AgentsChatFirstDeploymentRetirement $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("First retirement open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('First retirement open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Publish-AgentsChatFirstDeploymentRetirement([hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity) {
    if (-not $Context.Preparing) { throw 'First retirement has not retained its candidate.' }
    $null = Assert-AgentsChatFirstCompletionProof $Context
    Assert-AgentsChatDeploymentWorkerInventory $Context @($Context.Candidate.entries | Where-Object {
        $_.path.StartsWith('worker-', [StringComparison]::Ordinal)
    })
    $marker = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control 'worker-retirement.json'),
        ($Context.Candidate | ConvertTo-Json -Depth 16 -Compress))
    $Context.Files.Add($marker)
    $null = Assert-AgentsChatFirstCompletionProof $Context
    Close-AgentsChatTaskCompletionProof $Context
    return Open-AgentsChatFirstDeploymentRetirement $Context.Control $ControllerPid $ControllerIdentity
}

function Remove-AgentsChatNextFirstRetirementEntry([hashtable]$Context) {
    $null = Assert-AgentsChatFirstDeploymentRetirement $Context
    $target = $null
    try {
        $index = $Context.Prefix
        $commit = $index -eq $Context.Record.entries.Count
        $entry = if ($commit) { $Context.MarkerDescriptor } else { $Context.Record.entries[$index] }
        $original = if ($commit) { $Context.Marker } else { $Context.Entries[$index] }
        $original.Check()
        $original.Dispose()
        $null = $Context.Files.Remove($original)
        $file = Join-Path $Context.Control $entry.path
        $target = if (-not $commit -and $entry.kind -ceq 'directory') {
            [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement($file, $entry.dev, $entry.ino)
        } else { [Deployment.WindowsPrivateFile]::RetainForRetirement($file, $entry.sha256, $entry.dev, $entry.ino, $entry.bytes) }
        if (-not $commit) { $Context.Target = @{ Entry=$entry; Handle=$target } }
        $null = Assert-AgentsChatFirstDeploymentRetirement $Context
        $target.Check()
        $target.Delete()
        $target = $null
        $Context.Target = $null
        if ($commit) {
            $result = Get-AgentsChatFirstRetirementObservation $Context 'retired'
            Close-AgentsChatTaskCompletionProof $Context
            return $result
        }
        $Context.Entries[$index] = $null
        $Context.Prefix++
        return Assert-AgentsChatFirstDeploymentRetirement $Context
    } catch {
        $Context.Poisoned = $true
        throw
    } finally {
        $Context.Target = $null
        if ($target) { $target.Dispose() }
    }
}
