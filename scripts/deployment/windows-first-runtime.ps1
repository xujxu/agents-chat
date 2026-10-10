param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][string]$LockSha256,
    [Parameter(Mandatory)][string]$StateSha256,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$resources = [Collections.Generic.List[IDisposable]]::new()
$checks = [Collections.Generic.List[object]]::new()
$failure = $null
$stage = 'bootstrap'
$firstTask = $null
$context = $null
function Retain-FirstRuntimeResource($Resource) {
    $resources.Add($Resource)
    $checks.Add($Resource)
    return $Resource
}
function Assert-FirstRuntimePublication {
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original first-runtime controller changed.'
    }
    foreach ($resource in $checks) { $resource.Check() }
    if ($null -ne $context -and $null -ne $context.Activation) { Assert-AgentsChatFirstRuntime $context }
    elseif ($null -ne $firstTask) { Assert-AgentsChatFirstTaskRegistration $firstTask }
    if ($null -ne $context) { Assert-AgentsChatFirstActivationState $context }
    foreach ($name in @('recovery-lock', 'deployment.json', 'task-maintenance', 'backup')) {
        if ([IO.Directory]::GetFileSystemEntries($Control, $name).Length -ne 0) {
            throw 'Existing deployment or recovery evidence is not a first publication.'
        }
    }
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion -lt [version]'7.4' -or $Port -lt 1 -or $Port -gt 65535 -or
        $TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$') {
        throw 'Unsupported first-runtime publication context.'
    }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    . (Join-Path $PSScriptRoot 'windows-runtime-bundle.ps1')
    . (Join-Path $PSScriptRoot 'windows-first-task.ps1')
    . (Join-Path $PSScriptRoot 'windows-first-task-registration.ps1')
    . (Join-Path $PSScriptRoot 'windows-first-activation-handoff.ps1')
    . (Join-Path $PSScriptRoot 'windows-first-activation.ps1')
    . (Join-Path $PSScriptRoot 'windows-first-completion-handoff.ps1')
    . (Join-Path $PSScriptRoot 'windows-first-completion.ps1')
    $resources.Add([Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity))
    $stage = 'original-authority'
    if ($Control -cne (Join-Path (Split-Path -Parent $Project) ".$(Split-Path -Leaf $Project).deployment")) {
        throw 'First runtime requires its original sibling control.'
    }
    $null = Retain-FirstRuntimeResource ([Deployment.WindowsPrivateFile]::OpenSourceDirectory($Project))
    $null = Retain-FirstRuntimeResource ([Deployment.WindowsPrivateFile]::OpenDirectory($Control))
    $null = Retain-FirstRuntimeResource ([Deployment.WindowsPrivateFile]::OpenDirectory((Join-Path $Control 'lock')))
    $owner = Retain-FirstRuntimeResource ([Deployment.WindowsPrivateFile]::Open((Join-Path $Control 'lock/owner.json'), $LockSha256))
    $stateFile = Retain-FirstRuntimeResource ([Deployment.WindowsPrivateFile]::Open((Join-Path $Control 'state.json'), $StateSha256))
    if ($owner.ByteLength -gt 65536 -or $stateFile.ByteLength -gt 65536) { throw 'Oversized first-runtime authority.' }
    $lock = Read-AgentsChatMaintenanceFields ($owner.ReadText()) @(
        'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    $state = Read-AgentsChatMaintenanceFields ($stateFile.ReadText()) @(
        'version', 'operationId', 'project', 'operation', 'phase', 'previousPhase', 'sourceCommit',
        'targetCommit', 'backupId', 'priorRuntime', 'runtimeIdentity', 'startedAt', 'updatedAt', 'errorCode')
    $operationId = $lock.operationId.GetString()
    if ($lock.version.GetInt32() -ne 1 -or $lock.project.GetString() -cne $Project -or
        $lock.pid.GetInt32() -ne $ControllerPid -or $lock.processIdentity.GetString() -cne $ControllerIdentity -or
        $operationId -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
        $lock.token.GetString() -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
        $state.version.GetInt32() -ne 1 -or $state.project.GetString() -cne $Project -or
        $state.operationId.GetString() -cne $operationId -or $state.operation.GetString() -cne 'deploy' -or
        $state.phase.GetString() -cne 'configuring' -or $state.previousPhase.GetString() -cne 'building' -or
        $state.priorRuntime.GetString() -cne 'absent' -or $null -ne $state.backupId.GetString() -or
        $state.runtimeIdentity.GetString() -cne 'first-install-absent' -or $null -ne $state.errorCode.GetString() -or
        $state.startedAt.GetString() -cne $lock.createdAt.GetString() -or
        $state.targetCommit.GetString() -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') {
        throw 'First-runtime publication requires original configuring authority.'
    }
    $stage = 'environment'
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
    $initial = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method', 'environment')
    if ($initial.id.GetInt32() -ne 1 -or $initial.method.GetString() -cne 'publish' -or
        $initial.environment.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'Invalid first-runtime request.' }
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $initial.environment.EnumerateObject()) {
        if ($entry.Name -cnotin @('PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
            'HOME', 'NODE_ENV', 'NEXT_TELEMETRY_DISABLED') -or $entry.Value.ValueKind -ne [Text.Json.JsonValueKind]::String) {
            throw 'Unsupported first-runtime environment.'
        }
        $environment.Add($entry.Name, $entry.Value.GetString())
    }
    if (-not $environment.ContainsKey('NODE_ENV') -or $environment['NODE_ENV'] -cne 'production') {
        throw 'First runtime requires the admitted production environment.'
    }
    Assert-FirstRuntimePublication
    $stage = 'private-bundle'
    $directory = Join-Path $Control "first-runtime-$operationId"
    $bundle = New-AgentsChatRuntimeBundle -Source $PSScriptRoot -Directory $directory -File $Node `
        -Arguments @((Join-Path $Project 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', "$Port") `
        -WorkingDirectory $Project -Environment $environment -Retain
    foreach ($resource in $bundle.Retained) { $null = Retain-FirstRuntimeResource $resource }
    $null = Retain-FirstRuntimeResource ([Deployment.WindowsRuntimeHost]::Open($bundle.Configuration, $bundle.Sha256, $directory))
    Assert-FirstRuntimePublication
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try { $pwsh = $process.MainModule.FileName }
    finally { $process.Dispose() }
    $context = @{
        Resources=$resources; Checks=$checks; Project=$Project; Control=$Control; TaskName=$TaskName
        OperationId=$operationId; LockSha256=$LockSha256; StateSha256=$StateSha256
        Bundle=$bundle; Identity=$identity; Pwsh=$pwsh
        ConfiguringStateFile=$stateFile; OriginalState=$state
        ActivationPrepared=$false; ActivatingStateSha256=$null
        ActivatingStateFields=$null; ActivatingStateFile=$null
        CompletionPrepared=$false; AcceptedStateSha256=$null
        CompletionCompleted=$false; CompletionSha256=$null; CompletionProviders=$null; CompletionListener=$null
        Activation=$null; Listener=$null; Port=$Port
    }
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity
        directory=$directory; configuration=$bundle.Configuration; sha256=$bundle.Sha256
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $sequence = 1
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $text = $line.GetAwaiter().GetResult()
        $document = [Text.Json.JsonDocument]::Parse($text)
        try { $method = $document.RootElement.GetProperty('method').GetString() }
        finally { $document.Dispose() }
        $fields = if ($method -ceq 'register-task') { @('id', 'method', 'logonType', 'triggerType') }
            elseif ($method -ceq 'prepare-completion') { @('id', 'method', 'providers') }
            else { @('id', 'method') }
        $request = Read-AgentsChatMaintenanceFields $text $fields
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close', 'register-task', 'prepare-activation', 'activate', 'listener', 'prepare-completion', 'complete')) { throw 'Unexpected first-runtime request.' }
        $sequence = $id
        Assert-FirstRuntimePublication
        $value = $method
        if ($method -ceq 'register-task') {
            if ($null -ne $firstTask) { throw 'Original first task is already registered.' }
            $stage = 'first-task-registration'
            $firstTask = New-AgentsChatFirstTaskRegistration -Context $context `
                -LogonType $request.logonType.GetString() -TriggerType $request.triggerType.GetString()
            Assert-FirstRuntimePublication
            $value = $firstTask.Observation
        }
        if ($method -ceq 'prepare-activation') {
            $stage = 'first-activation-handoff'
            $value = Prepare-AgentsChatFirstActivation $context $firstTask
            Assert-FirstRuntimePublication
        }
        if ($method -ceq 'activate') {
            $stage = 'first-runtime-activation'
            $value = Start-AgentsChatFirstRuntime $context $firstTask { Assert-FirstRuntimePublication }
        }
        if ($method -ceq 'listener') {
            $stage = 'first-runtime-listener'
            $value = Open-AgentsChatFirstRuntimeListener $context { Assert-FirstRuntimePublication }
        }
        if ($method -ceq 'prepare-completion') {
            $stage = 'first-completion-handoff'
            if ($request.providers.ValueKind -ne [Text.Json.JsonValueKind]::Array) { throw 'Invalid first-runtime providers.' }
            $providers = @($request.providers.EnumerateArray() | ForEach-Object { $_.GetString() })
            $value = Prepare-AgentsChatFirstCompletion $context $providers { Assert-FirstRuntimePublication }
            Assert-FirstRuntimePublication
        }
        if ($method -ceq 'complete') {
            $stage = 'first-runtime-completion'
            $value = Complete-AgentsChatFirstRuntime $context { Assert-FirstRuntimePublication }
            Assert-FirstRuntimePublication
        }
        if ($method -ceq 'close' -and $null -ne $context.Activation) {
            $stage = 'first-runtime-settlement'
            Stop-AgentsChatFirstRuntime $context
        }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$value } | ConvertTo-Json -Depth 6 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    $kind = $failure.GetBaseException().GetType().Name
    $line = $_.InvocationInfo.ScriptLineNumber
    [Console]::Error.WriteLine("First-runtime preparation refused: $stage; type=$kind; line=$line. Retain the bundle and any inhibited task evidence.")
} finally {
    if ($null -ne $context -and $null -ne $context.Activation) {
        try { Stop-AgentsChatFirstRuntime $context }
        catch {
            [Console]::Error.WriteLine('First-runtime original-domain settlement failed; retain all evidence.')
            $failure = if ($failure) {
                [AggregateException]::new('First-runtime activation and settlement failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
    for ($index = $resources.Count - 1; $index -ge 0; $index--) {
        try { $resources[$index].Dispose() }
        catch {
            $failure = if ($failure) {
                [AggregateException]::new('First-runtime publication and close failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
