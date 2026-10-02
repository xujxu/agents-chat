function Test-AgentsChatActivationAuthority([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or -not $Context.Retired -or -not $Context.ReplacementPrepared) {
        throw 'Activation requires completed original retirement and replacement.'
    }
    $Context.Stage = 'activation-authority'
    if ($Context.Controller.HasExited -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Controller.Id) -cne $Context.Data.controllerIdentity -or
        -not $Context.Owner.HasExited -or $Context.Owner.ExitCode -ne 0) {
        throw 'Original activation authority changed.'
    }
    Test-AgentsChatRetirementTransaction $Context
    $Context.Stage = 'activation-evidence'
    foreach ($file in $Context.Files) { $file.Check() }
}

function Test-AgentsChatActivationPolicy([hashtable]$Context, [bool]$Enabled) {
    $Context.Stage = 'activation-policy'
    $task = $Context.Folder.GetTask($Context.Data.taskName)
    $expected = if ($Enabled) { $Context.ActivationEnabledDefinition } else { $Context.ActivationDefinition }
    if ($task.Path -cne "\$($Context.Data.taskName)" -or [bool]$task.Enabled -ne $Enabled -or
        [string]$task.Xml -cne $expected -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor) {
        throw 'Original staged activation policy changed.'
    }
    return $task
}

function Write-AgentsChatTaskActivationReceipt([hashtable]$Context, [string]$Phase) {
    $Context.Stage = 'activation-receipt'
    $record = [ordered]@{
        version=1; phase=$Phase; operationId=$Context.Data.operationId
        admissionSha256=$Context.AdmissionSha256; transactionSha256=$Context.Transaction.ReceiptSha256
        previousSha256=$Context.ActivationSha256; stateSha256=$Context.RetirementStateSha256
        taskName=$Context.Data.taskName; replacementDefinition=$Context.ReplacementDefinition
        definition=$Context.ActivationDefinition; enabledDefinition=$Context.ActivationDemandDefinition
        securityDescriptor=$Context.Data.securityDescriptor
        configuration=$Context.ReplacementConfiguration; configurationSha256=$Context.ReplacementConfigurationSha256
        leasePid=$Context.ActivationLeasePid; leaseIdentity=$Context.ActivationLeaseIdentity
        runtime=$Context.ActivationRuntime
    }
    $receipt = [Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Directory "task-activate-$Phase.json"), ($record | ConvertTo-Json -Depth 5 -Compress))
    $Context.Files.Add($receipt)
    $Context.ActivationSha256 = $receipt.Sha256
}

function Test-AgentsChatActiveTaskContext([hashtable]$Context) {
    Test-AgentsChatActivationAuthority $Context
    $Context.Stage = 'activation-owner'
    $runtime = $Context.ActivationRuntime
    if (-not $runtime -or -not $Context.ActivationOwner -or $Context.ActivationOwner.HasExited -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.ActivationOwner.Id) -cne $runtime.identity) {
        throw 'Original activated owner changed.'
    }
    $null = Test-AgentsChatActivationPolicy $Context $false
    $Context.Stage = 'activation-binding'
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $Context.Data.taskName -OwnerPid $runtime.pid `
        -OwnerIdentity $runtime.identity -Definition $Context.ActivationDefinition `
        -SecurityDescriptor $Context.Data.securityDescriptor
    if ($binding.enabled -or $binding.instanceGuid -cne $runtime.instanceGuid -or
        $binding.sessionId -ne $runtime.sessionId) { throw 'Original activated task binding differs.' }
    $Context.Stage = 'activation-domain'
    $observation = [Deployment.WindowsRuntimeControl]::Exchange(
        [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'observe', 15000) | ConvertFrom-Json
    if ($observation.quiescent -or $observation.phase -ceq 'stopped' -or
        $observation.members -notcontains $runtime.launcherPid -or $observation.applicationHealthy) {
        throw 'Activated original runtime domain differs.'
    }
    Test-AgentsChatActivationAuthority $Context
    $null = Test-AgentsChatActivationPolicy $Context $false
    if ($Context.ActivationOwner.HasExited) { throw 'Activated owner exited during observation.' }
}

function Assert-AgentsChatTaskActive {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    $Context.Busy = $true
    try {
        if (-not $Context.Activated) { throw 'Task activation is incomplete.' }
        Test-AgentsChatActiveTaskContext $Context
        return $Context.ActivationRuntime
    } catch {
        $Context.Poisoned = $true
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}

function Start-AgentsChatTaskReplacement {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    if ($Context.Activated) { return Assert-AgentsChatTaskActive -Context $Context }
    $Context.Busy = $true
    try {
        Test-AgentsChatActivationAuthority $Context
        Test-AgentsChatRetiredTaskContext $Context
        $Context.Stage = 'activation-profile'
        $task = $Context.Folder.GetTask($Context.Data.taskName)
        $principal = $task.Definition.Principal
        if (-not $task.Definition.Settings.AllowDemandStart -or
            [int]$task.Definition.Settings.MultipleInstances -ne 2) {
            throw 'Activation requires demand-start and ignore-new instance policy.'
        }
        $requested = [xml]$Context.ReplacementDefinition
        $namespaces = [Xml.XmlNamespaceManager]::new($requested.NameTable)
        $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $triggers = $requested.SelectNodes('/t:Task/t:Triggers', $namespaces)
        $restart = $requested.SelectNodes('/t:Task/t:Settings/t:RestartOnFailure', $namespaces)
        $arguments = $requested.SelectNodes('/t:Task/t:Actions/t:Exec/t:Arguments', $namespaces)
        if ($triggers.Count -ne 1 -or $restart.Count -gt 1 -or $arguments.Count -ne 1) {
            throw 'Unsupported activation policy shape.'
        }
        $triggers[0].IsEmpty = $true
        if ($restart.Count) { $null = $restart[0].ParentNode.RemoveChild($restart[0]) }
        $Context.ActivationLeasePid = $PID
        $Context.ActivationLeaseIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        $arguments[0].InnerText += " -ControllerPid $PID -ControllerIdentity $($Context.ActivationLeaseIdentity)"
        $Context.ActivationDefinition = $requested.OuterXml
        if ($Context.ActivationDefinition.Length -gt 262144) { throw 'Activation definition exceeds admission limits.' }
        $demand = [xml]$Context.ActivationDefinition
        $enabled = $demand.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
        if ($enabled.Count -ne 1 -or $enabled[0].InnerText -cne 'false') { throw 'Explicit activation inhibition is required.' }
        $enabled[0].InnerText = 'true'
        $Context.ActivationDemandDefinition = $demand.OuterXml
        $Context.ActivationSha256 = $Context.ReplacementSha256
        Test-AgentsChatRetiredTaskContext $Context
        Write-AgentsChatTaskActivationReceipt $Context 'requested'
        Test-AgentsChatRetiredTaskContext $Context
        $Context.Stage = 'activation-registration'
        $null = $Context.Folder.RegisterTask($Context.Data.taskName, $Context.ActivationDefinition, (4 -bor 16 -bor 32),
            [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
        $task = $Context.Folder.GetTask($Context.Data.taskName)
        $Context.Stage = 'activation-registered-inhibition'
        if ($task.Enabled -or $task.GetInstances(0).Count -ne 0) { throw 'Registered activation is not inhibited.' }
        $Context.Stage = 'activation-registered-security'
        if ([string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor) {
            throw 'Registered activation security differs.'
        }
        Confirm-AgentsChatTaskReplacementPolicy $Context.ActivationDefinition ([string]$task.Xml) $Context
        $Context.Stage = 'activation-registered-definition'
        if (([xml][string]$task.Xml).OuterXml -cne $requested.OuterXml) {
            throw 'Registered activation definition differs.'
        }
        $Context.ActivationDefinition = [string]$task.Xml
        Test-AgentsChatActivationAuthority $Context
        $task = Test-AgentsChatActivationPolicy $Context $false
        Write-AgentsChatTaskActivationReceipt $Context 'prepared'
        Write-AgentsChatTaskActivationReceipt $Context 'start-requested'
        Test-AgentsChatActivationAuthority $Context
        $task = Test-AgentsChatActivationPolicy $Context $false
        if ($task.GetInstances(0).Count -ne 0) { throw 'Task started before original activation request.' }
        $Context.Stage = 'activation-enable'
        # Disabled tasks cannot demand-start. The persisted profile has no automation,
        # and every possible start requires this exact original controller's lease.
        $task.Enabled = $true
        $task = $Context.Folder.GetTask($Context.Data.taskName)
        Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $Context.ActivationDefinition
        $Context.ActivationEnabledDefinition = [string]$task.Xml
        Test-AgentsChatActivationAuthority $Context
        $task = Test-AgentsChatActivationPolicy $Context $true
        if ($task.GetInstances(0).Count -ne 0) { throw 'Unexpected task instance before demand-start.' }
        $Context.Stage = 'activation-run'
        $instance = $task.Run($null)
        if (-not $instance) { throw 'Native demand-start returned no instance.' }
        $instanceGuid = ([guid]$instance.InstanceGuid).ToString('D')
        if ($instanceGuid -ceq [guid]::Empty.ToString('D') -or $instanceGuid -ceq $Context.Data.instanceGuid) {
            throw 'Native activation reused an original task instance.'
        }
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        do {
            Test-AgentsChatActivationAuthority $Context
            $null = Test-AgentsChatActivationPolicy $Context $true
            $Context.Stage = 'activation-instance'
            $instance.Refresh()
            if ($instance.Path -cne "\$($Context.Data.taskName)" -or
                ([guid]$instance.InstanceGuid).ToString('D') -cne $instanceGuid -or
                $deadline.ElapsedMilliseconds -ge 15000) { throw 'Original activation instance did not start.' }
            if ([int]$instance.EnginePID -lt 1 -or [int]$instance.State -ne 4) { Start-Sleep -Milliseconds 100 }
        } while ([int]$instance.EnginePID -lt 1 -or [int]$instance.State -ne 4)
        $Context.ActivationOwner = [Diagnostics.Process]::GetProcessById([int]$instance.EnginePID)
        $null = $Context.ActivationOwner.Handle
        $ownerIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.ActivationOwner.Id)
        if ($Context.ActivationOwner.HasExited -or $ownerIdentity -ceq $Context.Data.ownerIdentity) {
            throw 'Activated original owner differs.'
        }
        $task = Test-AgentsChatActivationPolicy $Context $true
        $Context.Stage = 'activation-inhibit'
        $task.Enabled = $false
        $null = Test-AgentsChatActivationPolicy $Context $false
        $bundle = [IO.Path]::GetDirectoryName($Context.ReplacementConfiguration)
        $readyFile = Join-Path $bundle "runtime-$($ownerIdentity.Replace(':', '-')).json"
        $deadline.Restart()
        while (-not (Test-Path -LiteralPath $readyFile)) {
            Test-AgentsChatActivationAuthority $Context
            $null = Test-AgentsChatActivationPolicy $Context $false
            $Context.Stage = 'activation-readiness-wait'
            if ($Context.ActivationOwner.HasExited -or $deadline.ElapsedMilliseconds -ge 30000) {
                throw 'Activated original runtime did not publish readiness.'
            }
            Start-Sleep -Milliseconds 100
        }
        $Context.Stage = 'activation-readiness'
        $readyHash = (Get-FileHash -LiteralPath $readyFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $ready = [Deployment.WindowsPrivateFile]::Open($readyFile, $readyHash)
        $Context.Files.Add($ready)
        $fields = Read-AgentsChatMaintenanceFields ($ready.ReadText()) @('version', 'generation', 'pid', 'identity',
            'configurationSha256', 'sessionId', 'job', 'launcherPid')
        $generation = $fields.generation.GetString()
        if ($fields.version.GetInt32() -ne 1 -or $fields.pid.GetInt32() -ne $Context.ActivationOwner.Id -or
            $fields.identity.GetString() -cne $ownerIdentity -or
            $fields.configurationSha256.GetString() -cne $Context.ReplacementConfigurationSha256 -or
            [guid]$generation -eq [guid]::Empty -or ([guid]$generation).ToString('D') -cne $generation -or
            $generation -ceq $Context.Data.generation -or
            $fields.sessionId.GetInt32() -ne $Context.ActivationOwner.SessionId -or
            $fields.job.GetString() -cne "Local\agents-deploy-$generation" -or $fields.launcherPid.GetInt32() -lt 1) {
            throw 'Activated private readiness differs from its original owner.'
        }
        $Context.ActivationRuntime = [pscustomobject][ordered]@{
            pid=$Context.ActivationOwner.Id; identity=$ownerIdentity; generation=$generation; instanceGuid=$instanceGuid
            sessionId=$fields.sessionId.GetInt32(); configurationSha256=$Context.ReplacementConfigurationSha256
            launcherPid=$fields.launcherPid.GetInt32(); readySha256=$readyHash
        }
        Test-AgentsChatActiveTaskContext $Context
        Write-AgentsChatTaskActivationReceipt $Context 'running'
        $Context.Activated = $true
        Test-AgentsChatActiveTaskContext $Context
        return $Context.ActivationRuntime
    } catch {
        $Context.Poisoned = $true
        [Console]::Error.WriteLine("Task activation diagnostic: line=$($_.InvocationInfo.ScriptLineNumber); hresult=$($_.Exception.GetBaseException().HResult).")
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}
