. (Join-Path $PSScriptRoot 'windows-task-owner-binding.ps1')

function Read-AgentsChatMaintenanceFields([string]$Text, [string[]]$Fields) {
    $document = [Text.Json.JsonDocument]::Parse($Text)
    try {
        if ($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'Expected an object.' }
        $remaining = [Collections.Generic.HashSet[string]]::new($Fields, [StringComparer]::Ordinal)
        $result = @{}
        foreach ($entry in $document.RootElement.EnumerateObject()) {
            if (-not $remaining.Remove($entry.Name)) { throw 'Unexpected or duplicate field.' }
            $result[$entry.Name] = $entry.Value.Clone()
        }
        if ($remaining.Count) { throw 'Incomplete object.' }
        return $result
    } finally { $document.Dispose() }
}

function Get-AgentsChatMaintenanceBinding([hashtable]$Context) {
    $data = $Context.Data
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $data.taskName -OwnerPid $data.ownerPid `
        -OwnerIdentity $data.ownerIdentity -Definition $Context.Definition -SecurityDescriptor $data.securityDescriptor
    if ($binding.instanceGuid -cne $data.instanceGuid -or
        ($Context.Inhibited -and $binding.enabled)) { throw 'Original task binding differs.' }
    return $binding
}

function Test-AgentsChatMaintenanceContext([hashtable]$Context, [bool]$Stopped) {
    if ($Context.Closed -or $Context.Poisoned) { throw 'Unavailable maintenance context.' }
    $Context.Stage = 'identity'
    if ($Context.Controller.HasExited -or $Context.Owner.HasExited -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Controller.Id) -cne $Context.Data.controllerIdentity -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Owner.Id) -cne $Context.Data.ownerIdentity) {
        throw 'Original maintenance processes changed.'
    }
    $Context.Stage = 'evidence'
    foreach ($file in $Context.Files) { $file.Check() }
    $Context.Stage = 'binding'
    $null = Get-AgentsChatMaintenanceBinding $Context
    $Context.Stage = 'domain'
    $observation = [Deployment.WindowsRuntimeControl]::Exchange([guid]$Context.Data.generation,
        $Context.Data.ownerPid, $Context.Data.ownerIdentity, 'observe', 15000) | ConvertFrom-Json
    if ($Stopped -and ($observation.phase -cne 'stopped' -or -not $observation.quiescent -or
        $observation.members.Count -ne 0)) { throw 'Original domain is not stopped.' }
    if ($observation.phase -cne 'stopped' -and $observation.members -notcontains $Context.LauncherPid) {
        throw 'Original runtime launcher is no longer owned.'
    }
    $Context.Stage = 'evidence'
    foreach ($file in $Context.Files) { $file.Check() }
    $Context.Stage = 'binding'
    $null = Get-AgentsChatMaintenanceBinding $Context
}

function Write-AgentsChatTaskStopReceipt([hashtable]$Context, [string]$Phase) {
    Test-AgentsChatMaintenanceContext $Context $Context.Stopped
    $Context.Stage = 'receipt'
    $record = [ordered]@{
        version=1; phase=$Phase; operationId=$Context.Data.operationId
        admissionSha256=$Context.AdmissionSha256; previousSha256=$Context.PreviousSha256
        instanceGuid=$Context.Data.instanceGuid; definition=$Context.Definition
        securityDescriptor=$Context.Data.securityDescriptor
    }
    $file = Join-Path $Context.Directory "task-stop-$Phase.json"
    $retained = [Deployment.WindowsPrivateFile]::Publish($file, ($record | ConvertTo-Json -Depth 4 -Compress))
    $Context.Files.Add($retained)
    $Context.PreviousSha256 = $retained.Sha256
}

function Confirm-AgentsChatTaskInhibition([string]$Before, [string]$After) {
    $original = [xml]$Before
    $current = [xml]$After
    $namespaces = [Xml.XmlNamespaceManager]::new($original.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $prior = $original.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
    $next = $current.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
    if ($prior.Count -gt 1 -or $next.Count -ne 1 -or $next[0].InnerText -cne 'false') {
        throw 'Ambiguous task inhibition policy.'
    }
    if ($prior.Count) {
        if ($prior[0].InnerText -cnotin @('true', 'false')) { throw 'Unsupported original enabled setting.' }
        $null = $prior[0].ParentNode.RemoveChild($prior[0])
    }
    $null = $next[0].ParentNode.RemoveChild($next[0])
    if ($original.OuterXml -cne $current.OuterXml) { throw 'Unrelated task policy changed during inhibition.' }
}

function Close-AgentsChatTaskMaintenance {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    if ($Context.Closed) { return }
    $Context.Closed = $true
    $failures = [Collections.Generic.List[Exception]]::new()
    foreach ($handle in @($Context.Files.ToArray()) + @($Context.Owner, $Context.Controller)) {
        if ($handle) {
            try { $handle.Dispose() }
            catch { $failures.Add($_.Exception) }
        }
    }
    $Context.Folder = $null
    if ($failures.Count) { throw 'Task maintenance refused: close.' }
}

function Assert-AgentsChatTaskStopped {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    $Context.Busy = $true
    try {
        if (-not $Context.Stopped -or -not $Context.Inhibited) { throw 'Task was not settled.' }
        Test-AgentsChatMaintenanceContext $Context $true
        return [pscustomobject]@{ stopped=$true; inhibited=$true }
    } catch {
        $Context.Poisoned = $true
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}

function Stop-AgentsChatManagedTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Admission,
        [Parameter(Mandatory)][string]$Sha256
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $context = @{
        Stage='admission'; Files=[Collections.Generic.List[IDisposable]]::new()
        Controller=$null; Owner=$null; Folder=$null; Data=$null
        Closed=$false; Poisoned=$false; Busy=$false; Stopped=$false; Inhibited=$false
        AdmissionSha256=$Sha256; PreviousSha256=$Sha256; Definition=$null; LauncherPid=0
        Directory=[IO.Path]::GetDirectoryName($Admission)
    }
    try {
        if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows -or
            [IO.Path]::GetFileName($Admission) -cne 'admission.json') { throw 'Unsupported maintenance entry.' }
        $admitted = [Deployment.WindowsPrivateFile]::Open($Admission, $Sha256)
        $context.Files.Add($admitted)
        $strings = @('operationId', 'controllerIdentity', 'taskName', 'definition', 'securityDescriptor',
            'configuration', 'configurationSha256', 'readySha256', 'ownerIdentity', 'generation', 'instanceGuid')
        $numbers = @('version', 'controllerPid', 'ownerPid')
        $fields = Read-AgentsChatMaintenanceFields ($admitted.ReadText()) ($strings + $numbers)
        $data = @{}
        foreach ($name in $strings) {
            $data[$name] = $fields[$name].GetString()
            if ([string]::IsNullOrEmpty($data[$name])) { throw 'Missing admission text.' }
        }
        foreach ($name in $numbers) { $data[$name] = $fields[$name].GetInt32() }
        if ($data.version -ne 1 -or $data.controllerPid -lt 1 -or $data.ownerPid -lt 1 -or
            $data.controllerPid -eq $data.ownerPid -or $data.controllerIdentity.Length -gt 64 -or
            $data.controllerIdentity -cnotmatch '^[1-9][0-9]*:[1-9][0-9]*$' -or
            $data.ownerIdentity.Length -gt 64 -or
            $data.ownerIdentity -cnotmatch '^[1-9][0-9]*:[1-9][0-9]*$') { throw 'Invalid maintenance identity.' }
        foreach ($name in @('operationId', 'generation', 'instanceGuid')) {
            $id = [guid]$data[$name]
            if ($id -eq [guid]::Empty -or $id.ToString('D') -cne $data[$name]) { throw 'Invalid maintenance generation.' }
        }
        $context.Data = $data
        $context.Definition = $data.definition
        $context.Stage = 'controller'
        $context.Controller = [Diagnostics.Process]::GetProcessById($data.controllerPid)
        $null = $context.Controller.Handle
        if ($context.Controller.HasExited -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($data.controllerPid) -cne $data.controllerIdentity) {
            throw 'Original maintenance controller differs.'
        }
        $context.Owner = [Diagnostics.Process]::GetProcessById($data.ownerPid)
        $null = $context.Owner.Handle
        $context.Stage = 'configuration'
        $config = [Deployment.WindowsPrivateFile]::Open($data.configuration, $data.configurationSha256)
        $context.Files.Add($config)
        $bundle = [IO.Path]::GetDirectoryName($data.configuration)
        $readyFile = Join-Path $bundle "runtime-$($data.ownerIdentity.Replace(':', '-')).json"
        $ready = [Deployment.WindowsPrivateFile]::Open($readyFile, $data.readySha256)
        $context.Files.Add($ready)
        $context.Stage = 'readiness'
        $readyFields = Read-AgentsChatMaintenanceFields ($ready.ReadText()) @('version', 'generation', 'pid', 'identity',
            'configurationSha256', 'sessionId', 'job', 'launcherPid')
        if ($readyFields.version.GetInt32() -ne 1 -or $readyFields.pid.GetInt32() -ne $data.ownerPid -or
            $readyFields.identity.GetString() -cne $data.ownerIdentity -or
            $readyFields.generation.GetString() -cne $data.generation -or
            $readyFields.configurationSha256.GetString() -cne $data.configurationSha256 -or
            $readyFields.job.GetString() -cne "Local\agents-deploy-$($data.generation)" -or
            $readyFields.launcherPid.GetInt32() -lt 1) { throw 'Original readiness scope differs.' }
        $context.LauncherPid = $readyFields.launcherPid.GetInt32()
        $context.Stage = 'binding'
        $binding = Get-AgentsChatMaintenanceBinding $context
        if ($binding.sessionId -ne $readyFields.sessionId.GetInt32()) { throw 'Original runtime session differs.' }
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        $task = $context.Folder.GetTask($data.taskName)
        $action = $task.Definition.Actions.Item(1)
        $hostFile = Join-Path $bundle 'windows-runtime-host.ps1'
        $arguments = "-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$($data.configuration)`" -Sha256 $($data.configurationSha256)"
        $process = [Diagnostics.Process]::GetCurrentProcess()
        try { $powershell = $process.MainModule.FileName }
        finally { $process.Dispose() }
        if ([string]$action.Path -ine $powershell -or [string]$action.WorkingDirectory -ine $bundle -or
            [string]$action.Arguments -cne $arguments) { throw 'Task is not the admitted literal managed host.' }

        Write-AgentsChatTaskStopReceipt $context 'intent'
        Test-AgentsChatMaintenanceContext $context $false
        $context.Stage = 'inhibition'
        $task = $context.Folder.GetTask($data.taskName)
        $task.Enabled = $false
        $task = $context.Folder.GetTask($data.taskName)
        Confirm-AgentsChatTaskInhibition $data.definition ([string]$task.Xml)
        if ($task.Enabled -or [string]$task.GetSecurityDescriptor(7) -cne $data.securityDescriptor) {
            throw 'Task inhibition changed the admitted security policy.'
        }
        $context.Definition = [string]$task.Xml
        $context.Inhibited = $true
        Write-AgentsChatTaskStopReceipt $context 'inhibited'
        Write-AgentsChatTaskStopReceipt $context 'stop-requested'
        Test-AgentsChatMaintenanceContext $context $false
        $context.Stage = 'stop'
        $null = [Deployment.WindowsRuntimeControl]::Exchange([guid]$data.generation, $data.ownerPid,
            $data.ownerIdentity, 'stop', 15000)
        $context.Stopped = $true
        Write-AgentsChatTaskStopReceipt $context 'stopped'
        $null = Assert-AgentsChatTaskStopped -Context $context
        return $context
    } catch {
        $context.Poisoned = $true
        $stage = $context.Stage
        Close-AgentsChatTaskMaintenance -Context $context
        throw "Task maintenance refused: $stage."
    }
}
