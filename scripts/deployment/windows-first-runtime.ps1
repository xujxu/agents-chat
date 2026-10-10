param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Control,
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
    foreach ($name in @('recovery-lock', 'deployment.json', 'task-maintenance', 'backup')) {
        if ([IO.Directory]::GetFileSystemEntries($Control, $name).Length -ne 0) {
            throw 'Existing deployment or recovery evidence is not a first publication.'
        }
    }
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion -lt [version]'7.4' -or $Port -lt 1 -or $Port -gt 65535) {
        throw 'Unsupported first-runtime publication context.'
    }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    . (Join-Path $PSScriptRoot 'windows-runtime-bundle.ps1')
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
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 1048576)
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
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity
        directory=$directory; configuration=$bundle.Configuration; sha256=$bundle.Sha256
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $sequence = 1
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close')) { throw 'Unexpected first-runtime request.' }
        $sequence = $id
        Assert-FirstRuntimePublication
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$method } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("First-runtime publication refused: $stage. Retain any incomplete bundle.")
} finally {
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
