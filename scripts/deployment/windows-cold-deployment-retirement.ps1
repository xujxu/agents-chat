. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-cold-retirement-evidence.ps1')
. (Join-Path $PSScriptRoot 'windows-retirement-entries.ps1')

function Assert-AgentsChatColdRetirementInventory([hashtable]$Context) {
    $Context.Stage = 'cold-retirement-inventory'
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = $Context.Prefix; $index -lt $Context.Record.entries.Count; $index++) {
        $null = $expected.Add($Context.Record.entries[$index].path)
    }
    $null = $expected.Add('worker-retirement.json')
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -match '^(worker-|task-retirement|service-|first-task-|cold-restore-terminal\.json)' -or
            $item.Name -in @('task-maintenance', 'lock', 'recovery-lock', 'cold-restore-staging',
                '.deployment.json.staging', 'state.json.lock') -or $item.Name -like 'state.json.lock.pending-*') {
            if (-not $expected.Remove($item.Name)) { throw 'Unexpected cold retirement inventory.' }
        }
    }
    foreach ($directory in @('task-maintenance', 'recovery-lock', 'worker-engine', 'lock')) {
        $children = @($expected | Where-Object { $_.StartsWith("$directory\", [StringComparison]::Ordinal) })
        $present = Test-Path -LiteralPath (Join-Path $Context.Control $directory)
        if ($Context.Target -and $Context.Target.Entry.kind -ceq 'directory' -and $Context.Target.Entry.path -ceq $directory) {
            if ($children.Count -or -not $present) { throw 'Cold retirement directory is not the next empty target.' }
            $Context.Target.Handle.Check()
        } elseif ($present) {
            foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Context.Control $directory) -Force) {
                if ($item.PSIsContainer -or -not $expected.Remove("$directory\$($item.Name)")) {
                    throw 'Unexpected nested cold retirement evidence.'
                }
            }
        }
    }
    if ($expected.Count) { throw 'Remaining cold retirement evidence disappeared.' }
}

function Get-AgentsChatColdRetirementObservation([hashtable]$Context, [string]$Status = 'retiring') {
    return [ordered]@{
        status=$Status; operationId=$Context.OperationId; stateSha256=$Context.Record.state.sha256
        receiptSha256=$Context.Record.receipt.sha256; runtime=[pscustomobject]$Context.Runtime
        retiredEntries=$Context.Prefix; totalEntries=$Context.Record.entries.Count; manifestSha256=$Context.MarkerSha256
    }
}

function Assert-AgentsChatColdRetirementControllers([hashtable]$Context) {
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($Context.ControllerPid) -cne $Context.ControllerIdentity) {
        throw 'Current cold retirement actor changed.'
    }
    Assert-AgentsChatFirstRetirementCreator $Context $Context.Record.creator
    foreach ($original in $Context.Record.originals.Values) {
        Assert-AgentsChatCompletionProcessAbsent $original.pid $original.processIdentity
    }
}

function Assert-AgentsChatColdDeploymentRetirement([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Cold retirement authority is unavailable.' }
    $Context.Busy = $true
    try {
        foreach ($pass in @(1, 2)) {
            Assert-AgentsChatColdRetirementControllers $Context
            Assert-AgentsChatColdRetirementInventory $Context
            foreach ($file in $Context.Files) { $file.Check() }
            Assert-AgentsChatCompletionRuntime $Context
        }
        Assert-AgentsChatCompletionFinalRuntime $Context
        return Get-AgentsChatColdRetirementObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Cold retirement refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatColdDeploymentRetirement([string]$Control, [int]$ControllerPid, [string]$ControllerIdentity) {
    $context = @{
        Control=$Control; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        Files=[Collections.Generic.List[IDisposable]]::new(); Closed=$false; Poisoned=$false; Busy=$false
        Owner=$null; Instance=$null; Folder=$null; Prefix=0; Target=$null; Stage='cold-retirement-marker'
    }
    try {
        $directory = [Deployment.WindowsPrivateFile]::OpenDirectory($Control)
        $context.Files.Add($directory)
        $markerPath = Join-Path $Control 'worker-retirement.json'
        $original = Open-AgentsChatCompletionFile $context $markerPath ''
        $identity = $original.CaptureIdentity()
        $sha256 = $original.Sha256
        $bytes = $original.ByteLength
        if ($bytes -gt 1048576) { throw 'Oversized cold retirement marker.' }
        $record = Read-AgentsChatRetirementJson ($original.ReadText())
        Initialize-AgentsChatColdRetirementRecord $context $record
        $rootIdentity = $directory.CaptureIdentity()
        if ($rootIdentity.Dev -cne $record.controlIdentity.dev -or $rootIdentity.Ino -cne $record.controlIdentity.ino) {
            throw 'Original cold retirement control changed.'
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
        Read-AgentsChatColdRetirementAcceptance $context $record.lock
        $context.Stage = 'cold-retirement-prefix'
        $context.Entries = [object[]]::new($record.entries.Count)
        $remaining = $false
        for ($index = 0; $index -lt $record.entries.Count; $index++) {
            $entry = $record.entries[$index]
            $file = Join-Path $Control $entry.path
            if (-not (Test-Path -LiteralPath $file)) {
                if ($remaining) { throw 'Non-prefix cold retirement inventory.' }
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
                throw 'Cold retirement evidence was replaced.'
            }
        }
        if ($null -ne $context.Entries[-2]) {
            $names = @('version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
            $originalLock = Read-AgentsChatMaintenanceFields ($context.Entries[-2].ReadText()) $names
            $lock = Read-AgentsChatMaintenanceFields ($record.lock | ConvertTo-Json -Compress) $names
            Assert-AgentsChatCompletionFields $originalLock $lock $names
        }
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenSourceDirectory($context.Project))
        Open-AgentsChatRetirementRuntime $context
        $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$($context.TaskName)"
        $taskHash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $taskHash))
        $null = Assert-AgentsChatColdDeploymentRetirement $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Cold retirement open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Cold retirement open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Remove-AgentsChatNextColdRetirementEntry([hashtable]$Context) {
    return Remove-AgentsChatRetirementEntry $Context $Context.MarkerDescriptor `
        { param($scope) Assert-AgentsChatColdDeploymentRetirement $scope } `
        { param($scope) Get-AgentsChatColdRetirementObservation $scope 'retired' }
}
