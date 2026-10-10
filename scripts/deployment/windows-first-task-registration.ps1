function Retain-AgentsChatFirstTaskResource([hashtable]$Context, $Resource) {
    $Context.Resources.Add($Resource)
    $Context.Checks.Add($Resource)
    return $Resource
}

function Assert-AgentsChatFirstTaskRegistration([hashtable]$Context) {
    $task = $Context.Folder.GetTask($Context.TaskName)
    if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
        [string]$task.Xml -cne $Context.Observation.definition -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.Observation.securityDescriptor) {
        throw 'Original inhibited first-task registration changed.'
    }
}

function New-AgentsChatFirstTaskRegistration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Context,
        [Parameter(Mandatory)][ValidateSet('Interactive', 'S4U')][string]$LogonType,
        [Parameter(Mandatory)][ValidateSet('AtLogOn', 'AtStartup')][string]$TriggerType
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $absent = $false
    try { $null = $folder.GetTask($Context.TaskName) }
    catch {
        if ($_.Exception.GetBaseException().HResult -ne -2147024894) { throw }
        $absent = $true
    }
    if (-not $absent) { throw 'Existing first-task registration must not be replaced.' }
    $account = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid = $account.User.Value }
    finally { $account.Dispose() }
    $definition = $scheduler.NewTask(0)
    $definition.RegistrationInfo.URI = "\$($Context.TaskName)"
    $definition.RegistrationInfo.Description = "Agents-Chat managed first installation $($Context.OperationId)."
    $definition.Principal.Id = 'Author'
    $definition.Principal.UserId = $sid
    $definition.Principal.LogonType = if ($LogonType -ceq 'S4U') { 2 } else { 3 }
    $definition.Principal.RunLevel = 1
    $definition.Settings.Enabled = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.MultipleInstances = 2
    $definition.Settings.ExecutionTimeLimit = 'P365D'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.StartWhenAvailable = $true
    $definition.Settings.RestartInterval = 'PT1M'
    $definition.Settings.RestartCount = 3
    $trigger = $definition.Triggers.Create($(if ($TriggerType -ceq 'AtStartup') { 8 } else { 9 }))
    if ($TriggerType -ceq 'AtLogOn') { $trigger.UserId = $sid }
    $action = $definition.Actions.Create(0)
    $definition.Actions.Context = 'Author'
    $action.Path = $Context.Pwsh
    $action.WorkingDirectory = $Context.Project
    $hostScript = Join-Path $Context.Bundle.Directory 'windows-runtime-host.ps1'
    $action.Arguments = "-NoProfile -NonInteractive -File `"$hostScript`" -Configuration `"$($Context.Bundle.Configuration)`" -Sha256 $($Context.Bundle.Sha256)"
    $permanent = [string]$definition.XmlText
    $staged = [xml]$permanent
    $namespaces = [Xml.XmlNamespaceManager]::new($staged.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $staged.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $namespaces).InnerText = 'false'
    $staged.SelectSingleNode('/t:Task/t:Triggers', $namespaces).IsEmpty = $true
    $restart = $staged.SelectSingleNode('/t:Task/t:Settings/t:RestartOnFailure', $namespaces)
    $null = $restart.ParentNode.RemoveChild($restart)
    $arguments = $staged.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments', $namespaces)
    $arguments.InnerText += " -ControllerPid $PID -ControllerIdentity $($Context.Identity)"
    $definition.XmlText = $staged.OuterXml
    $requested = [string]$definition.XmlText
    $directory = Join-Path $Context.Control "first-task-$($Context.OperationId)"
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::CreateDirectory($directory))
    $intent = [ordered]@{
        version=1; operationId=$Context.OperationId; project=$Context.Project; taskName=$Context.TaskName
        lockSha256=$Context.LockSha256; stateSha256=$Context.StateSha256
        controllerPid=$PID; controllerIdentity=$Context.Identity
        configuration=$Context.Bundle.Configuration; configurationSha256=$Context.Bundle.Sha256
        definition=$requested; permanentDefinition=$permanent; accountSid=$sid
        logonType=$LogonType; triggerType=$TriggerType
    }
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $directory 'intent.json'), ($intent | ConvertTo-Json -Depth 4 -Compress)))
    $task = Register-AgentsChatFirstTask -Folder $folder -TaskName $Context.TaskName -Definition $definition
    $actual = [xml][string]$task.Xml
    $expected = [xml]$requested
    foreach ($document in @($actual, $expected)) {
        $users = $document.SelectNodes('/t:Task/t:Principals/t:Principal/t:UserId', $namespaces)
        if ($users.Count -ne 1) { throw 'First task requires one explicit account.' }
        $user = $users[0].InnerText
        $accountSid = if ($user -match '^S-\d-') {
            [Security.Principal.SecurityIdentifier]::new($user)
        } else {
            ([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier])
        }
        if ($accountSid.Value -cne $sid) { throw 'Registered first-task account differs.' }
        $users[0].InnerText = $sid
    }
    if ($actual.DocumentElement.OuterXml -cne $expected.DocumentElement.OuterXml) {
        $different = @('RegistrationInfo', 'Triggers', 'Principals', 'Settings', 'Actions') | Where-Object {
            $before = $expected.SelectSingleNode("/t:Task/t:$_", $namespaces)
            $after = $actual.SelectSingleNode("/t:Task/t:$_", $namespaces)
            $before.OuterXml -cne $after.OuterXml
        }
        [Console]::Error.WriteLine("First-task policy diagnostic: sections=$($different -join ',').")
        if ('Settings' -in $different) {
            foreach ($document in @($expected, $actual)) {
                $settings = $document.SelectSingleNode('/t:Task/t:Settings', $namespaces)
                [Console]::Error.WriteLine("First-task settings diagnostic: $($settings.OuterXml)")
            }
        }
        throw 'Registered first-task policy differs from the requested definition.'
    }
    $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$($Context.TaskName)"
    $taskHash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $retained = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $taskHash))
    $fileIdentity = $retained.CaptureIdentity()
    $observation = [ordered]@{
        status='first-task-prepared'; runtimeAuthority=$false
        project=$Context.Project; operationId=$Context.OperationId; taskName=$Context.TaskName
        accountSid=$sid; logonType=$LogonType; triggerType=$TriggerType
        controllerPid=$PID; controllerIdentity=$Context.Identity
        configuration=$Context.Bundle.Configuration; configurationSha256=$Context.Bundle.Sha256
        definition=[string]$task.Xml; permanentDefinition=$permanent
        securityDescriptor=[string]$task.GetSecurityDescriptor(7)
        taskFileSha256=$taskHash; taskFileDev=$fileIdentity.Dev; taskFileIno=$fileIdentity.Ino
        taskFileSecurityDescriptor=$retained.SecurityDescriptor
    }
    $result = @{ Folder=$folder; TaskName=$Context.TaskName; Observation=$observation }
    Assert-AgentsChatFirstTaskRegistration $result
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $directory 'registered.json'), ($observation | ConvertTo-Json -Depth 4 -Compress)))
    Assert-AgentsChatFirstTaskRegistration $result
    return $result
}
