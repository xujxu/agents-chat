function ConvertFrom-AgentsChatRetirementJson([Text.Json.JsonElement]$Value) {
    switch ($Value.ValueKind) {
        'Object' {
            $result = [ordered]@{}
            foreach ($property in $Value.EnumerateObject()) {
                if ($result.Contains($property.Name)) { throw 'Duplicate retirement field.' }
                $result[$property.Name] = ConvertFrom-AgentsChatRetirementJson $property.Value
            }
            return $result
        }
        'Array' {
            $items = @($Value.EnumerateArray() | ForEach-Object { ConvertFrom-AgentsChatRetirementJson $_ })
            return ,$items
        }
        'String' { return $Value.GetString() }
        'Number' { return $Value.GetInt32() }
        'True' { return $true }
        'False' { return $false }
        default { throw 'Unsupported retirement JSON value.' }
    }
}

function Assert-AgentsChatRetirementFields($Value, [string[]]$Names) {
    if ($Value -isnot [Collections.IDictionary] -or $Value.Count -ne $Names.Count) {
        throw 'Invalid retirement fields.'
    }
    foreach ($name in $Value.Keys) {
        if ($name -cnotin $Names) { throw 'Unexpected retirement field.' }
    }
}

function Read-AgentsChatRetirementJson([string]$Text) {
    $document = [Text.Json.JsonDocument]::Parse($Text)
    try { return ConvertFrom-AgentsChatRetirementJson $document.RootElement }
    finally { $document.Dispose() }
}

function Assert-AgentsChatRetirementIdentity($Value) {
    Assert-AgentsChatRetirementFields $Value @('dev', 'ino')
    if ($Value.dev -isnot [string] -or $Value.ino -isnot [string] -or
        $Value.dev -cnotmatch '^(0|[1-9][0-9]{0,9})$' -or
        $Value.ino -cnotmatch '^(0|[1-9][0-9]{0,19})$' -or
        [uint64]$Value.dev -gt [uint32]::MaxValue) { throw 'Invalid retirement identity.' }
    $null = [uint64]$Value.ino
}

function Assert-AgentsChatRetirementDescriptor($Value, [string]$Relative) {
    Assert-AgentsChatRetirementFields $Value @('path', 'dev', 'ino', 'bytes', 'sha256')
    Assert-AgentsChatRetirementIdentity @{ dev=$Value.dev; ino=$Value.ino }
    if ($Value.path -isnot [string] -or $Value.path -cne $Relative -or
        $Value.bytes -isnot [int] -or $Value.bytes -lt 1 -or $Value.bytes -gt 1048576 -or
        $Value.sha256 -isnot [string] -or $Value.sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Invalid retirement descriptor.'
    }
}

function Assert-AgentsChatRetirementCreator($Value, [int]$ControllerPid, [string]$ControllerIdentity) {
    Assert-AgentsChatRetirementFields $Value @('pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')
    if ($Value.pid -isnot [int] -or $Value.bridgePid -isnot [int] -or $Value.pid -eq $Value.bridgePid) {
        throw 'Invalid retirement creator.'
    }
    Assert-AgentsChatCompletionProcessIdentity $Value.pid $Value.processIdentity
    Assert-AgentsChatCompletionProcessIdentity $Value.bridgePid $Value.bridgeIdentity
    if ($Value.pid -ne $ControllerPid -or $Value.processIdentity -cne $ControllerIdentity -or
        $Value.bridgePid -ne $PID -or $Value.bridgeIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        Assert-AgentsChatCompletionProcessAbsent $Value.pid $Value.processIdentity
        Assert-AgentsChatCompletionProcessAbsent $Value.bridgePid $Value.bridgeIdentity
    }
}

function Open-AgentsChatRetirementFile([hashtable]$Context, $Descriptor, [string]$Relative) {
    Assert-AgentsChatRetirementDescriptor $Descriptor $Relative
    $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control $Relative) $Descriptor.sha256
    $identity = $file.CaptureIdentity()
    if ($identity.Dev -cne $Descriptor.dev -or $identity.Ino -cne $Descriptor.ino -or
        $file.ByteLength -ne $Descriptor.bytes) { throw 'Original retirement evidence was replaced.' }
    return $file
}

function Open-AgentsChatRetirementDirectory([hashtable]$Context, [string]$Path, $Expected) {
    Assert-AgentsChatRetirementIdentity $Expected
    $directory = [Deployment.WindowsPrivateFile]::OpenDirectory($Path)
    $Context.Files.Add($directory)
    $identity = $directory.CaptureIdentity()
    if ($identity.Dev -cne $Expected.dev -or $identity.Ino -cne $Expected.ino) {
        throw 'Original retirement directory was replaced.'
    }
}

function Read-AgentsChatRetirementRecords([hashtable]$Context) {
    $Context.Stage = 'checkpoint'
    $checkpointFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'task-retirement-checkpoint.json') ''
    $checkpoint = Read-AgentsChatRetirementJson ($checkpointFile.ReadText())
    $intentFile = Open-AgentsChatRetirementFile $Context $checkpoint.intent 'task-retirement.json'
    $intent = Read-AgentsChatRetirementJson ($intentFile.ReadText())
    $identity = $checkpointFile.CaptureIdentity()
    $prepared = [ordered]@{
        status='prepared'
        descriptor=[ordered]@{ path='task-retirement-checkpoint.json'; dev=$identity.Dev; ino=$identity.Ino
            bytes=$checkpointFile.ByteLength; sha256=$checkpointFile.Sha256 }
        intent=[ordered]@{ status='prepared'; descriptor=$checkpoint.intent; intent=$intent }
        checkpoint=$checkpoint
    }
    Initialize-AgentsChatRetirementRecords $Context $prepared
    Open-AgentsChatRetirementDirectory $Context (Join-Path $Context.Control 'lock') $intent.lockIdentity
    Open-AgentsChatRetirementDirectory $Context $Context.Directory $intent.maintenanceIdentity
    $owner = Open-AgentsChatRetirementFile $Context $intent.lockFile 'lock\owner.json'
    $lockNames = @('version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    $originalLock = Read-AgentsChatMaintenanceFields ($owner.ReadText()) $lockNames
    $storedLock = Read-AgentsChatMaintenanceFields ($intent.lock | ConvertTo-Json -Compress) $lockNames
    Assert-AgentsChatCompletionFields $originalLock $storedLock $lockNames
}

function Initialize-AgentsChatRetirementRecords([hashtable]$Context, $Prepared) {
    Assert-AgentsChatRetirementFields $Prepared @('status', 'descriptor', 'intent', 'checkpoint')
    Assert-AgentsChatRetirementFields $Prepared.intent @('status', 'descriptor', 'intent')
    if ($Prepared.status -cne 'prepared' -or $Prepared.intent.status -cne 'prepared') {
        throw 'Invalid prepared retirement checkpoint.'
    }
    Assert-AgentsChatRetirementDescriptor $Prepared.descriptor 'task-retirement-checkpoint.json'
    Assert-AgentsChatRetirementDescriptor $Prepared.intent.descriptor 'task-retirement.json'
    $checkpoint = $Prepared.checkpoint
    $intent = $Prepared.intent.intent
    Assert-AgentsChatRetirementFields $checkpoint @('version', 'intent', 'configuration',
        'definitionSha256', 'securityDescriptorSha256', 'enabled', 'listener', 'retiredBridge', 'retiredOwner', 'creator')
    Assert-AgentsChatRetirementDescriptor $checkpoint.intent 'task-retirement.json'
    foreach ($name in $checkpoint.intent.Keys) {
        if ($checkpoint.intent[$name] -cne $Prepared.intent.descriptor[$name]) {
            throw 'Prepared checkpoint intent descriptor differs.'
        }
    }
    if ($checkpoint.version -isnot [int] -or $checkpoint.version -ne 1 -or
        $checkpoint.enabled -isnot [bool]) { throw 'Unsupported retirement checkpoint.' }
    foreach ($name in @('definitionSha256', 'securityDescriptorSha256')) {
        if ($checkpoint[$name] -isnot [string] -or $checkpoint[$name] -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Invalid checkpoint policy digest.'
        }
    }
    Assert-AgentsChatRetirementCreator $checkpoint.creator $Context.ControllerPid $Context.ControllerIdentity
    $Context.Stage = 'intent'
    Assert-AgentsChatRetirementFields $intent @('version', 'control', 'project', 'lock', 'lockFile', 'state',
        'controlIdentity', 'lockIdentity', 'maintenanceIdentity', 'completion', 'files', 'creator')
    if ($intent.version -isnot [int] -or $intent.version -ne 1 -or $intent.control -cne $Context.Control -or
        $intent.project -isnot [string] -or $intent.project -cnotmatch '^[A-Za-z]:\\' -or
        $intent.project.Length -gt 4096 -or $intent.project -match '[\x00\r\n]' -or
        [IO.Path]::GetFullPath($intent.project) -cne $intent.project -or
        $intent.project.Substring(3).Contains(':') -or
        [string]::Equals($intent.project, $Context.Control, [StringComparison]::OrdinalIgnoreCase) -or
        $intent.project.StartsWith($Context.Control.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $Context.Control.StartsWith($intent.project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Invalid retirement project scope.'
    }
    Assert-AgentsChatRetirementCreator $intent.creator $Context.ControllerPid $Context.ControllerIdentity
    Open-AgentsChatRetirementDirectory $Context $Context.Control $intent.controlIdentity
    Assert-AgentsChatRetirementIdentity $intent.lockIdentity
    Assert-AgentsChatRetirementIdentity $intent.maintenanceIdentity
    $Context.Stage = 'original-lock-state'
    Assert-AgentsChatRetirementDescriptor $intent.lockFile 'lock\owner.json'
    $lockNames = @('version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    Assert-AgentsChatRetirementFields $intent.lock $lockNames
    if ($intent.lock.version -isnot [int] -or $intent.lock.version -ne 1 -or
        $intent.lock.pid -isnot [int] -or $intent.lock.project -cne $intent.project -or
        $intent.lock.createdAt -isnot [string] -or -not $intent.lock.createdAt) { throw 'Invalid retirement owner.' }
    Assert-AgentsChatCompletionGuid $intent.lock.token
    Assert-AgentsChatCompletionGuid $intent.lock.operationId
    Assert-AgentsChatCompletionProcessAbsent $intent.lock.pid $intent.lock.processIdentity
    $state = Open-AgentsChatRetirementFile $Context $intent.state 'state.json'
    $Context.Stage = 'completion'
    $completion = $intent.completion
    Assert-AgentsChatRetirementFields $completion @('status', 'mutationAuthority', 'operationId', 'taskName',
        'stateSha256', 'completionSha256', 'runtime', 'port', 'providers', 'lease')
    if ($completion.status -cne 'observed' -or $completion.mutationAuthority -isnot [bool] -or
        $completion.mutationAuthority -or $completion.lease -cne 'released' -or
        $completion.operationId -cne $intent.lock.operationId -or
        $completion.stateSha256 -cne $state.Sha256 -or $completion.taskName -isnot [string] -or
        $completion.taskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or
        $completion.port -isnot [int] -or $completion.port -lt 1 -or $completion.port -gt 65535 -or
        $completion.providers -isnot [array] -or $completion.providers.Count -lt 1 -or
        $completion.providers.Count -gt 3 -or
        @($completion.providers | Select-Object -Unique).Count -ne $completion.providers.Count -or
        @($completion.providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
        throw 'Invalid original retirement completion.'
    }
    $Context.Runtime = ConvertFrom-AgentsChatCompletionRuntime ($completion.runtime | ConvertTo-Json -Compress)
    foreach ($name in @('retiredBridge', 'retiredOwner')) {
        Assert-AgentsChatRetirementFields $checkpoint[$name] @('pid', 'processIdentity')
        if ($checkpoint[$name].pid -isnot [int]) { throw 'Invalid retired process.' }
        Assert-AgentsChatCompletionProcessAbsent $checkpoint[$name].pid $checkpoint[$name].processIdentity
    }
    $paths = @('task-maintenance\admission.json', 'task-maintenance\transaction.json')
    $paths += @(Get-AgentsChatCompletionRecordNames | ForEach-Object { "task-maintenance\task-$_.json" })
    if ($intent.files -isnot [array] -or $intent.files.Count -ne $paths.Count) { throw 'Invalid retirement receipt list.' }
    for ($index = 0; $index -lt $paths.Count; $index++) {
        Assert-AgentsChatRetirementDescriptor $intent.files[$index] $paths[$index]
    }
    if ($intent.files[-1].sha256 -cne $completion.completionSha256) { throw 'Original completion receipt differs.' }
    $listener = $checkpoint.listener
    Assert-AgentsChatRetirementFields $listener @('pid', 'processIdentity', 'createdAt', 'address', 'pairedRecords')
    if ($listener.pid -isnot [int] -or $listener.createdAt -isnot [string] -or
        $listener.createdAt -cnotmatch '^[1-9][0-9]{0,18}$' -or $listener.pairedRecords -isnot [bool] -or
        $listener.address -cnotin @('127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1') -or
        ($listener.pairedRecords -and $listener.address -cne '::')) { throw 'Invalid original retirement listener.' }
    $null = [int64]$listener.createdAt
    Assert-AgentsChatCompletionProcessIdentity $listener.pid $listener.processIdentity
    if ($checkpoint.configuration -isnot [string] -or
        $checkpoint.configuration -cnotmatch '^[A-Za-z]:\\' -or
        $checkpoint.configuration.Length -gt 4096 -or $checkpoint.configuration -match '[\x00\r\n]' -or
        $checkpoint.configuration.Substring(3).Contains(':') -or
        [IO.Path]::GetFullPath($checkpoint.configuration) -cne $checkpoint.configuration -or
        [IO.Path]::GetFileName($checkpoint.configuration) -cne 'configuration.json') {
        throw 'Invalid original retirement configuration path.'
    }
    $Context.Project = $intent.project
    $Context.TaskName = $completion.taskName
    $Context.Port = $completion.port
    $Context.Enabled = $checkpoint.enabled
    $Context.Intent = $intent
    $Context.Checkpoint = $checkpoint
    $Context.Prepared = $Prepared
}
