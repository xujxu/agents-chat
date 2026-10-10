. (Join-Path $PSScriptRoot 'windows-task-retirement-scope.ps1')

function Assert-AgentsChatFirstRetirementCreator([hashtable]$Context, $Creator) {
    Assert-AgentsChatRetirementFields $Creator @('pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')
    if ($Creator.pid -isnot [int] -or $Creator.bridgePid -isnot [int] -or $Creator.pid -eq $Creator.bridgePid) {
        throw 'Invalid first retirement creator.'
    }
    Assert-AgentsChatCompletionProcessIdentity $Creator.pid $Creator.processIdentity
    Assert-AgentsChatCompletionProcessIdentity $Creator.bridgePid $Creator.bridgeIdentity
    if ($Creator.pid -ne $Context.ControllerPid -or $Creator.processIdentity -cne $Context.ControllerIdentity) {
        Assert-AgentsChatCompletionProcessAbsent $Creator.pid $Creator.processIdentity
    }
    if ($Creator.bridgePid -ne $PID -or $Creator.bridgeIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        Assert-AgentsChatCompletionProcessAbsent $Creator.bridgePid $Creator.bridgeIdentity
    }
}

function Initialize-AgentsChatFirstRetirementRecord([hashtable]$Context, $Record) {
    $Context.Stage = 'first-retirement-record'
    Assert-AgentsChatRetirementFields $Record @(
        'version', 'purpose', 'control', 'project', 'lock', 'publisher', 'state', 'receipt', 'controlIdentity',
        'completion', 'checkpoint', 'entries', 'workerManifestSha256', 'creator')
    if ($Record.version -isnot [int] -or $Record.version -ne 4 -or $Record.purpose -cne 'first-deployment' -or
        $Record.control -cne $Context.Control -or $Record.project -isnot [string] -or
        $Record.project -cnotmatch '^[A-Za-z]:\\' -or $Record.project.Length -gt 4096 -or
        $Record.project -match '[\x00\r\n]' -or $Record.project.Substring(3).Contains(':') -or
        [IO.Path]::GetFullPath($Record.project) -cne $Record.project -or
        $Context.Control -cne (Join-Path (Split-Path -Parent $Record.project) ".$(Split-Path -Leaf $Record.project).deployment") -or
        $Record.workerManifestSha256 -isnot [string] -or $Record.workerManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $Record.entries -isnot [array] -or $Record.entries.Count -lt 21 -or $Record.entries.Count -gt 308) {
        throw 'Invalid first retirement scope.'
    }
    Assert-AgentsChatFirstRetirementCreator $Context $Record.creator
    Assert-AgentsChatRetirementIdentity $Record.controlIdentity
    $lock = $Record.lock
    Assert-AgentsChatRetirementFields $lock @('version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    if ($lock.version -isnot [int] -or $lock.version -ne 1 -or $lock.pid -isnot [int] -or
        $lock.project -cne $Record.project -or $lock.createdAt -isnot [string]) { throw 'Invalid first retirement lock.' }
    Assert-AgentsChatCompletionGuid $lock.token
    Assert-AgentsChatCompletionGuid $lock.operationId
    Assert-AgentsChatRetirementFields $Record.publisher @('pid', 'processIdentity')
    if ($Record.publisher.pid -isnot [int] -or $Record.publisher.pid -eq $lock.pid) {
        throw 'Invalid original first publisher.'
    }
    $Context.ActorPid = $lock.pid
    $Context.ActorIdentity = $lock.processIdentity
    $Context.BridgePid = $Record.publisher.pid
    $Context.BridgeIdentity = $Record.publisher.processIdentity
    Assert-AgentsChatFirstCompletionControllers $Context
    $completion = $Record.completion
    Assert-AgentsChatRetirementFields $completion @(
        'status', 'mutationAuthority', 'phase', 'operationId', 'taskName', 'stateSha256', 'completionSha256',
        'runtime', 'port', 'providers', 'lease')
    if ($completion.status -cne 'first-completion-observed' -or $completion.phase -cne 'complete' -or
        $completion.mutationAuthority -isnot [bool] -or $completion.mutationAuthority -or
        $completion.operationId -cne $lock.operationId -or $completion.lease -cne 'released' -or
        $completion.taskName -isnot [string] -or $completion.taskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or
        $completion.port -isnot [int] -or $completion.port -lt 1 -or $completion.port -gt 65535 -or
        $completion.providers -isnot [array] -or $completion.providers.Count -lt 1 -or $completion.providers.Count -gt 3 -or
        @($completion.providers | Select-Object -Unique).Count -ne $completion.providers.Count -or
        @($completion.providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
        throw 'Invalid first retirement completion.'
    }
    Assert-AgentsChatRetirementDescriptor $Record.state 'state.json'
    Assert-AgentsChatRetirementDescriptor $Record.receipt 'deployment.json'
    if ($Record.state.sha256 -cne $completion.stateSha256) { throw 'First accepted state digest differs.' }
    $Context.Runtime = ConvertFrom-AgentsChatCompletionRuntime ($completion.runtime | ConvertTo-Json -Compress)
    if ($Context.Runtime.pid -in @($Context.ActorPid, $Context.BridgePid)) { throw 'Ambiguous first retirement runtime.' }
    $checkpoint = $Record.checkpoint
    Assert-AgentsChatRetirementFields $checkpoint @(
        'configuration', 'definitionSha256', 'securityDescriptorSha256', 'enabled', 'listener')
    if ($checkpoint.enabled -isnot [bool] -or -not $checkpoint.enabled -or
        $checkpoint.configuration -cne (Join-Path $Context.Control "first-runtime-$($lock.operationId)\configuration.json")) {
        throw 'Invalid first retirement runtime checkpoint.'
    }
    foreach ($name in @('definitionSha256', 'securityDescriptorSha256')) {
        if ($checkpoint[$name] -isnot [string] -or $checkpoint[$name] -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Invalid first retirement policy digest.'
        }
    }
    $listener = $checkpoint.listener
    Assert-AgentsChatRetirementFields $listener @('pid', 'processIdentity', 'createdAt', 'address', 'pairedRecords')
    if ($listener.pid -isnot [int] -or $listener.createdAt -isnot [string] -or
        $listener.createdAt -cnotmatch '^[1-9][0-9]{0,18}$' -or $listener.pairedRecords -isnot [bool] -or
        $listener.address -cnotin @('127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1') -or
        ($listener.pairedRecords -and $listener.address -cne '::')) { throw 'Invalid first retirement listener.' }
    $null = [int64]$listener.createdAt
    Assert-AgentsChatCompletionProcessIdentity $listener.pid $listener.processIdentity
    $directory = "first-task-$($lock.operationId)"
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($name in Get-AgentsChatFirstCompletionRecordNames) { $paths.Add("$directory\$name.json") }
    $paths.Add($directory)
    $index = $paths.Count
    $journals = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    while ($index -lt $Record.entries.Count -and
        $Record.entries[$index].path -cmatch '^worker-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.ndjson$') {
        $name = $Record.entries[$index++].path
        if ($journals.Count -ge 32 -or -not $journals.Add($name)) { throw 'Duplicate or excessive first workers.' }
        $paths.Add($name)
    }
    $helpers = 0
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    while ($index -lt $Record.entries.Count -and
        $Record.entries[$index].path -cmatch '^worker-engine\\[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$') {
        $name = $Record.entries[$index++].path
        if (++$helpers -gt 257 -or -not $names.Add($name)) { throw 'Duplicate or excessive first helpers.' }
        $paths.Add($name)
    }
    if ($helpers -lt 2 -or $paths[-1] -cne 'worker-engine\manifest.json' -or
        $Record.entries[$index - 1].sha256 -cne $Record.workerManifestSha256) { throw 'Invalid first helper manifest.' }
    foreach ($name in @('worker-engine', 'worker-operation.ndjson', 'lock\owner.json', 'lock')) { $paths.Add($name) }
    if ($paths.Count -ne $Record.entries.Count -or $Record.entries[13].sha256 -cne $completion.completionSha256) {
        throw 'Invalid first retirement inventory or completion digest.'
    }
    for ($index = 0; $index -lt $paths.Count; $index++) {
        $entry = $Record.entries[$index]
        $kind = if ($paths[$index] -cin @($directory, 'worker-engine', 'lock')) { 'directory' } else { 'file' }
        if ($entry.path -cne $paths[$index] -or $entry.kind -cne $kind) { throw 'Invalid first retirement deletion order.' }
        if ($kind -ceq 'directory') {
            Assert-AgentsChatRetirementFields $entry @('kind', 'path', 'dev', 'ino')
            Assert-AgentsChatRetirementIdentity @{ dev=$entry.dev; ino=$entry.ino }
        } else {
            Assert-AgentsChatRetirementFields $entry @('kind', 'path', 'dev', 'ino', 'bytes', 'sha256')
            $descriptor = [ordered]@{}
            foreach ($name in @('path', 'dev', 'ino', 'bytes', 'sha256')) { $descriptor[$name] = $entry[$name] }
            Assert-AgentsChatRetirementDescriptor $descriptor $entry.path
        }
    }
    $Context.Project = $Record.project
    $Context.OperationId = $lock.operationId
    $Context.Directory = Join-Path $Context.Control $directory
    $Context.TaskName = $completion.taskName
    $Context.StateSha256 = $Record.state.sha256
    $Context.Checkpoint = $checkpoint
    $Context.Enabled = $true
    $Context.Port = $completion.port
    $Context.Providers = [string[]]$completion.providers
    $Context.Record = $Record
}
