function Confirm-AgentsChatFirstTaskSettings([Xml.XmlElement]$Expected, [Xml.XmlElement]$Actual) {
    $defaults = @{
        AllowHardTerminate='true'; RunOnlyIfNetworkAvailable='false'; AllowStartOnDemand='true'
        Hidden='false'; RunOnlyIfIdle='false'; WakeToRun='false'; Priority='7'; Enabled='true'
    }
    if ($Expected.NamespaceURI -cne 'http://schemas.microsoft.com/windows/2004/02/mit/task' -or
        $Actual.NamespaceURI -cne $Expected.NamespaceURI -or $Expected.Attributes.Count -ne $Actual.Attributes.Count) {
        throw 'First-task settings namespace or attributes differ.'
    }
    foreach ($attribute in $Expected.Attributes) {
        if (-not $Actual.HasAttribute($attribute.LocalName, $attribute.NamespaceURI) -or
            $Actual.GetAttribute($attribute.LocalName, $attribute.NamespaceURI) -cne $attribute.Value) {
            throw 'First-task settings attributes differ.'
        }
    }
    $expectedFields = @{}
    $actualFields = @{}
    foreach ($pair in @(@{ Node=$Expected; Fields=$expectedFields }, @{ Node=$Actual; Fields=$actualFields })) {
        foreach ($node in $pair.Node.ChildNodes) {
            if ($node -isnot [Xml.XmlElement] -or $node.NamespaceURI -cne $Expected.NamespaceURI -or
                $pair.Fields.ContainsKey($node.LocalName)) { throw 'Unsupported or duplicate first-task setting.' }
            $pair.Fields.Add($node.LocalName, $node)
        }
    }
    foreach ($name in $actualFields.Keys) {
        if (-not $expectedFields.ContainsKey($name)) { throw 'Unexpected first-task setting.' }
    }
    foreach ($name in $expectedFields.Keys) {
        $expectedField = $expectedFields[$name]
        if ($actualFields.ContainsKey($name)) {
            if ($expectedField.OuterXml -cne $actualFields[$name].OuterXml) {
                throw "Registered first-task setting differs: $name."
            }
        } elseif (-not $defaults.ContainsKey($name) -or $expectedField.Attributes.Count -ne 0 -or
            $expectedField.InnerXml -cne $defaults[$name]) {
            throw "Registered first-task setting is missing: $name."
        }
    }
}

function Confirm-AgentsChatFirstTaskXml([Xml.XmlElement]$Expected, [Xml.XmlElement]$Actual) {
    if ($Expected.LocalName -cne $Actual.LocalName -or $Expected.NamespaceURI -cne $Actual.NamespaceURI) {
        throw 'Registered first-task element differs.'
    }
    $beforeAttributes = @($Expected.Attributes | Where-Object NamespaceURI -CNE 'http://www.w3.org/2000/xmlns/')
    $afterAttributes = @($Actual.Attributes | Where-Object NamespaceURI -CNE 'http://www.w3.org/2000/xmlns/')
    if ($beforeAttributes.Count -ne $afterAttributes.Count) { throw 'Registered first-task attributes differ.' }
    foreach ($attribute in $beforeAttributes) {
        if (-not $Actual.HasAttribute($attribute.LocalName, $attribute.NamespaceURI) -or
            $Actual.GetAttribute($attribute.LocalName, $attribute.NamespaceURI) -cne $attribute.Value) {
            throw "Registered first-task attribute differs: $($attribute.LocalName)."
        }
    }
    if ($Expected.LocalName -ceq 'Settings') {
        Confirm-AgentsChatFirstTaskSettings $Expected $Actual
        return
    }
    $beforeChildren = @($Expected.ChildNodes)
    $afterChildren = @($Actual.ChildNodes)
    if ($Expected.LocalName -cin @('BootTrigger', 'LogonTrigger')) {
        $enabled = @($beforeChildren | Where-Object {
            $_ -is [Xml.XmlElement] -and $_.LocalName -ceq 'Enabled' -and $_.NamespaceURI -ceq $Expected.NamespaceURI
        })
        $actualEnabled = @($afterChildren | Where-Object {
            $_ -is [Xml.XmlElement] -and $_.LocalName -ceq 'Enabled' -and $_.NamespaceURI -ceq $Expected.NamespaceURI
        })
        if ($enabled.Count -eq 1 -and $actualEnabled.Count -eq 0 -and
            $enabled[0].Attributes.Count -eq 0 -and $enabled[0].InnerXml -ceq 'true') {
            $beforeChildren = @($beforeChildren | Where-Object { -not [object]::ReferenceEquals($_, $enabled[0]) })
        }
    }
    if ($beforeChildren.Count -ne $afterChildren.Count) {
        $beforeNames = @($beforeChildren | ForEach-Object { $_.LocalName }) -join ','
        $afterNames = @($afterChildren | ForEach-Object { $_.LocalName }) -join ','
        [Console]::Error.WriteLine("First-task shape differs: element=$($Expected.LocalName); expected=$beforeNames; actual=$afterNames.")
        throw "Registered first-task shape differs: $($Expected.LocalName)."
    }
    if ($Expected.LocalName -ceq 'Task') {
        $remaining = [Collections.Generic.Dictionary[string,Xml.XmlElement]]::new([StringComparer]::Ordinal)
        foreach ($node in $Actual.ChildNodes) {
            if ($node -isnot [Xml.XmlElement] -or $node.NamespaceURI -cne $Expected.NamespaceURI) {
                throw 'Unsupported first-task root content.'
            }
            $remaining.Add($node.LocalName, $node)
        }
        foreach ($node in $Expected.ChildNodes) {
            if ($node -isnot [Xml.XmlElement] -or -not $remaining.ContainsKey($node.LocalName)) {
                throw 'Missing or duplicate first-task section.'
            }
            Confirm-AgentsChatFirstTaskXml $node $remaining[$node.LocalName]
            $null = $remaining.Remove($node.LocalName)
        }
        return
    }
    for ($index = 0; $index -lt $beforeChildren.Count; $index++) {
        $before = $beforeChildren[$index]
        $after = $afterChildren[$index]
        if ($before -is [Xml.XmlElement] -and $after -is [Xml.XmlElement]) {
            Confirm-AgentsChatFirstTaskXml $before $after
        } elseif ($before.NodeType -ne $after.NodeType -or $before.Value -cne $after.Value) {
            throw "Registered first-task content differs: $($Expected.LocalName)."
        }
    }
}

function Retain-AgentsChatFirstTaskResource([hashtable]$Context, $Resource) {
    $Context.Resources.Add($Resource)
    $Context.Checks.Add($Resource)
    return $Resource
}

function Confirm-AgentsChatFirstTaskPolicy([string]$Expected, [string]$Actual, [string]$Sid) {
    $before = [xml]$Expected
    $after = [xml]$Actual
    foreach ($document in @($before, $after)) {
        $namespaces = [Xml.XmlNamespaceManager]::new($document.NameTable)
        $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        if ($document.SelectNodes('/t:Task/t:Principals/t:Principal/t:UserId', $namespaces).Count -ne 1) {
            throw 'First task requires one explicit account.'
        }
        $users = $document.SelectNodes(
            '/t:Task/t:Principals/t:Principal/t:UserId | /t:Task/t:Triggers/t:LogonTrigger/t:UserId', $namespaces)
        foreach ($user in $users) {
            $accountSid = if ($user.InnerText -match '^S-\d-') {
                [Security.Principal.SecurityIdentifier]::new($user.InnerText)
            } else {
                ([Security.Principal.NTAccount]::new($user.InnerText)).Translate([Security.Principal.SecurityIdentifier])
            }
            if ($accountSid.Value -cne $Sid) { throw 'Registered first-task account differs.' }
            $user.InnerText = $Sid
        }
    }
    Confirm-AgentsChatFirstTaskXml $before.DocumentElement $after.DocumentElement
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
    Confirm-AgentsChatFirstTaskPolicy $requested ([string]$task.Xml) $sid
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
    $result = @{ Folder=$folder; TaskName=$Context.TaskName; Observation=$observation; File=$retained }
    Assert-AgentsChatFirstTaskRegistration $result
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $directory 'registered.json'), ($observation | ConvertTo-Json -Depth 4 -Compress)))
    Assert-AgentsChatFirstTaskRegistration $result
    return $result
}
