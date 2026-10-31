. (Join-Path $PSScriptRoot 'windows-task-retirement-scope.ps1')
. (Join-Path $PSScriptRoot 'windows-first-retirement-record.ps1')

function Get-AgentsChatColdRetirementPaths($WorkerNames) {
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($name in @('admission', 'transaction', 'task-stop-intent', 'task-stop-inhibited',
        'task-stop-stop-requested', 'task-stop-stopped')) { $paths.Add("task-maintenance\$name.json") }
    $paths.Add('task-maintenance')
    $names = @('owner', 'files-restored', 'activation-intent', 'activation-start-requested', 'activation-running')
    $names += @('prepared', 'policy-requested', 'policy-staged', 'release-requested', 'released',
        'policy-restore-requested', 'policy-restored', 'enable-requested', 'complete') |
        ForEach-Object { "completion-$_" }
    foreach ($name in @($names | Sort-Object -CaseSensitive)) { $paths.Add("recovery-lock\$name.json") }
    $paths.Add('recovery-lock')
    foreach ($name in $WorkerNames) { $paths.Add("worker-engine\$name") }
    foreach ($name in @('worker-engine\manifest.json', 'worker-engine', 'worker-operation.ndjson',
        'cold-restore-terminal.json', 'lock\owner.json', 'lock')) { $paths.Add($name) }
    return $paths.ToArray()
}

function Assert-AgentsChatColdRetirementPath([string]$Path) {
    if ($Path.Length -gt 4096 -or $Path -cnotmatch '^[A-Za-z]:\\' -or $Path -match '[\x00\r\n]' -or
        $Path.Substring(3).Contains(':') -or [IO.Path]::GetFullPath($Path) -cne $Path) {
        throw 'Cold retirement requires canonical Windows paths.'
    }
}

function Initialize-AgentsChatColdRetirementRecord([hashtable]$Context, $Record) {
    $Context.Stage = 'cold-retirement-record'
    Assert-AgentsChatRetirementFields $Record @('version', 'purpose', 'control', 'project', 'lock', 'controlIdentity',
        'state', 'receipt', 'terminal', 'completion', 'checkpoint', 'originals', 'workerManifestSha256', 'entries', 'creator')
    if ($Record.version -isnot [int] -or $Record.version -ne 5 -or $Record.purpose -cne 'cold-restore' -or
        $Record.control -cne $Context.Control -or $Record.project -isnot [string] -or
        $Record.workerManifestSha256 -isnot [string] -or $Record.workerManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $Record.entries -isnot [array] -or $Record.entries.Count -lt 29 -or $Record.entries.Count -gt 284) {
        throw 'Invalid cold retirement scope.'
    }
    Assert-AgentsChatColdRetirementPath $Record.control
    Assert-AgentsChatColdRetirementPath $Record.project
    if ([string]::Equals($Record.project, $Record.control, [StringComparison]::OrdinalIgnoreCase) -or
        $Record.project.StartsWith($Record.control.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $Record.control.StartsWith($Record.project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Cold retirement control must be external.'
    }
    Assert-AgentsChatFirstRetirementCreator $Context $Record.creator
    Assert-AgentsChatRetirementIdentity $Record.controlIdentity
    $lock = $Record.lock
    Assert-AgentsChatRetirementFields $lock @('version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    if ($lock.version -isnot [int] -or $lock.version -ne 1 -or $lock.pid -isnot [int] -or
        $lock.project -cne $Record.project -or $lock.createdAt -isnot [string]) { throw 'Invalid cold retirement lock.' }
    Assert-AgentsChatCompletionGuid $lock.token
    Assert-AgentsChatCompletionGuid $lock.operationId
    $null = [DateTimeOffset]::Parse($lock.createdAt, [Globalization.CultureInfo]::InvariantCulture)
    $completion = $Record.completion
    Assert-AgentsChatRetirementFields $completion @('status', 'mutationAuthority', 'operationId', 'taskName',
        'stateSha256', 'completionSha256', 'runtime', 'port', 'providers', 'lease')
    if ($completion.status -cne 'observed' -or $completion.mutationAuthority -isnot [bool] -or
        $completion.mutationAuthority -or $completion.lease -cne 'released' -or
        $completion.operationId -cne $lock.operationId -or
        $completion.taskName -isnot [string] -or $completion.taskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or
        $completion.port -isnot [int] -or $completion.port -lt 1 -or $completion.port -gt 65535 -or
        $completion.providers -isnot [array] -or $completion.providers.Count -lt 1 -or $completion.providers.Count -gt 3 -or
        @($completion.providers | Select-Object -Unique).Count -ne $completion.providers.Count -or
        @($completion.providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
        throw 'Invalid cold retirement completion.'
    }
    foreach ($pair in @(@($Record.state, 'state.json'), @($Record.receipt, 'deployment.json'),
        @($Record.terminal, 'cold-restore-terminal.json'))) { Assert-AgentsChatRetirementDescriptor $pair[0] $pair[1] }
    if ($Record.state.sha256 -cne $completion.stateSha256) { throw 'Cold retirement terminal state digest differs.' }
    $runtime = ConvertFrom-AgentsChatCompletionRuntime ($completion.runtime | ConvertTo-Json -Compress)
    $originals = $Record.originals
    Assert-AgentsChatRetirementFields $originals @('restoreController', 'stoppedRuntime', 'coldController', 'activationBridge')
    foreach ($original in $originals.Values) {
        Assert-AgentsChatRetirementFields $original @('pid', 'processIdentity')
        if ($original.pid -isnot [int] -or $original.processIdentity -ceq $runtime.identity) {
            throw 'Invalid cold retirement original process.'
        }
        Assert-AgentsChatCompletionProcessAbsent $original.pid $original.processIdentity
    }
    if ($originals.restoreController.pid -ne $lock.pid -or
        $originals.restoreController.processIdentity -cne $lock.processIdentity) { throw 'Original restore controller differs.' }
    $checkpoint = $Record.checkpoint
    Assert-AgentsChatRetirementFields $checkpoint @(
        'configuration', 'definitionSha256', 'securityDescriptorSha256', 'enabled', 'listener')
    Assert-AgentsChatColdRetirementPath $checkpoint.configuration
    $bundle = Split-Path -Parent $checkpoint.configuration
    if ($checkpoint.enabled -isnot [bool] -or (Split-Path -Parent $bundle) -cne $Context.Control -or
        (Split-Path -Leaf $bundle) -cnotmatch '^runtime-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
        (Split-Path -Leaf $checkpoint.configuration) -cne 'configuration.json') { throw 'Invalid cold runtime checkpoint.' }
    foreach ($name in @('definitionSha256', 'securityDescriptorSha256')) {
        if ($checkpoint[$name] -isnot [string] -or $checkpoint[$name] -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Invalid cold retirement policy digest.'
        }
    }
    $listener = $checkpoint.listener
    Assert-AgentsChatRetirementFields $listener @('pid', 'processIdentity', 'createdAt', 'address', 'pairedRecords')
    if ($listener.pid -isnot [int] -or $listener.createdAt -isnot [string] -or
        $listener.createdAt -cnotmatch '^[1-9][0-9]{0,18}$' -or $listener.pairedRecords -isnot [bool] -or
        $listener.address -cnotin @('127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1') -or
        ($listener.pairedRecords -and $listener.address -cne '::')) { throw 'Invalid cold retirement listener.' }
    $null = [int64]$listener.createdAt
    Assert-AgentsChatCompletionProcessIdentity $listener.pid $listener.processIdentity
    $workers = [Collections.Generic.List[string]]::new()
    $unique = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Record.entries) {
        if ($entry.path -is [string] -and $entry.path.StartsWith('worker-engine\', [StringComparison]::Ordinal) -and
            $entry.path -cne 'worker-engine\manifest.json') {
            $name = $entry.path.Substring(14)
            if ($name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or -not $unique.Add($name) -or
                $name -ieq 'manifest.json') { throw 'Invalid cold worker helper.' }
            $workers.Add($name)
        }
    }
    if ($workers.Count -lt 1 -or $workers.Count -gt 256) { throw 'Invalid cold worker helper count.' }
    $paths = @(Get-AgentsChatColdRetirementPaths $workers.ToArray())
    if ($paths.Count -ne $Record.entries.Count) { throw 'Invalid cold retirement entry count.' }
    $identities = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($retained in @($Record.controlIdentity, $Record.state, $Record.receipt)) {
        if (-not $identities.Add("$($retained.dev):$($retained.ino)")) { throw 'Aliased retained cold evidence.' }
    }
    for ($index = 0; $index -lt $paths.Count; $index++) {
        $entry = $Record.entries[$index]
        $kind = if ($paths[$index] -cin @('task-maintenance', 'recovery-lock', 'worker-engine', 'lock')) { 'directory' } else { 'file' }
        if ($entry.path -cne $paths[$index] -or $entry.kind -cne $kind) { throw 'Invalid cold retirement deletion order.' }
        if ($kind -ceq 'directory') {
            Assert-AgentsChatRetirementFields $entry @('kind', 'path', 'dev', 'ino')
            Assert-AgentsChatRetirementIdentity @{ dev=$entry.dev; ino=$entry.ino }
        } else {
            Assert-AgentsChatRetirementFields $entry @('kind', 'path', 'dev', 'ino', 'bytes', 'sha256')
            $descriptor = [ordered]@{}
            foreach ($name in @('path', 'dev', 'ino', 'bytes', 'sha256')) { $descriptor[$name] = $entry[$name] }
            $maximum = if ($entry.path -cmatch '^recovery-lock\\activation-(start-requested|running)\.json$') { 4194304 } else { 1048576 }
            Assert-AgentsChatRetirementDescriptor $descriptor $entry.path $maximum
        }
        if (-not $identities.Add("$($entry.dev):$($entry.ino)")) { throw 'Cold retirement aliases retained or retired evidence.' }
        if (($entry.path -ceq 'recovery-lock\completion-complete.json' -and $entry.sha256 -cne $completion.completionSha256) -or
            ($entry.path -ceq 'worker-engine\manifest.json' -and $entry.sha256 -cne $Record.workerManifestSha256)) {
            throw 'Original cold completion or worker digest differs.'
        }
        if ($entry.path -ceq 'cold-restore-terminal.json') {
            foreach ($name in $Record.terminal.Keys) {
                if ($entry[$name] -cne $Record.terminal[$name]) { throw 'Cold retirement terminal handoff differs.' }
            }
        }
    }
    $Context.Project = $Record.project
    $Context.OperationId = $lock.operationId
    $Context.TaskName = $completion.taskName
    $Context.StateSha256 = $Record.state.sha256
    $Context.Runtime = $runtime
    $Context.Checkpoint = $checkpoint
    $Context.Enabled = $checkpoint.enabled
    $Context.Port = $completion.port
    $Context.Providers = [string[]]$completion.providers
    $Context.Record = $Record
}
