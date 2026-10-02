function Confirm-AgentsChatTaskReplacementPolicy([string]$Before, [string]$After, [hashtable]$Context) {
    $Context.Stage = 'replacement-policy-xml'
    $original = [xml]$Before
    $candidate = [xml]$After
    $namespaces = [Xml.XmlNamespaceManager]::new($original.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    foreach ($document in @($original, $candidate)) {
        $Context.Stage = 'replacement-policy-inhibition'
        $enabled = $document.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
        if ($enabled.Count -ne 1 -or $enabled[0].InnerText -cne 'false') {
            throw 'Replacement must retain explicit task inhibition.'
        }
        foreach ($name in @('Command', 'Arguments', 'WorkingDirectory')) {
            $Context.Stage = 'replacement-policy-action'
            $nodes = $document.SelectNodes("/t:Task/t:Actions/t:Exec/t:$name", $namespaces)
            if ($nodes.Count -ne 1) { throw 'Replacement requires one complete literal action.' }
            $nodes[0].InnerText = 'normalized'
        }
    }
    if ($original.OuterXml -cne $candidate.OuterXml) {
        $Context.Stage = 'replacement-policy-root'
        foreach ($name in @('RegistrationInfo', 'Triggers', 'Principals', 'Settings', 'Actions')) {
            $beforeNodes = $original.SelectNodes("/t:Task/t:$name", $namespaces)
            $afterNodes = $candidate.SelectNodes("/t:Task/t:$name", $namespaces)
            if (($beforeNodes | ForEach-Object OuterXml | ConvertTo-Json -Compress) -cne
                ($afterNodes | ForEach-Object OuterXml | ConvertTo-Json -Compress)) {
                $Context.Stage = "replacement-policy-$($name.ToLowerInvariant())"
                break
            }
        }
        throw 'Unrelated replacement task policy changed.'
    }
}

function Write-AgentsChatTaskReplacementReceipt([hashtable]$Context, [string]$Phase) {
    $Context.Stage = 'replacement-receipt'
    $record = [ordered]@{
        version=1; phase=$Phase; operationId=$Context.Data.operationId
        admissionSha256=$Context.AdmissionSha256; transactionSha256=$Context.Transaction.ReceiptSha256
        previousSha256=$Context.ReplacementSha256; stateSha256=$Context.RetirementStateSha256
        taskName=$Context.Data.taskName; originalDefinition=$Context.Definition
        definition=$Context.ReplacementDefinition; securityDescriptor=$Context.Data.securityDescriptor
        configuration=$Context.ReplacementConfiguration; configurationSha256=$Context.ReplacementConfigurationSha256
    }
    $receipt = [Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Directory "task-replace-$Phase.json"), ($record | ConvertTo-Json -Depth 4 -Compress))
    $Context.Files.Add($receipt)
    $Context.ReplacementSha256 = $receipt.Sha256
}

function Publish-AgentsChatTaskReplacement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Context,
        [Parameter(Mandatory)][string]$Configuration,
        [Parameter(Mandatory)][string]$Sha256
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    $Context.Busy = $true
    try {
        $Context.Stage = 'replacement-retirement'
        if (-not $Context.Retired) { throw 'Original owner must retire before replacement.' }
        Test-AgentsChatRetiredTaskContext $Context
        $Context.Stage = 'replacement-candidate'
        if ($Context.ReplacementPrepared) {
            if ($Configuration -cne $Context.ReplacementConfiguration -or
                $Sha256 -cne $Context.ReplacementConfigurationSha256) { throw 'Original replacement differs.' }
            return [pscustomobject]@{ replaced=$true; inhibited=$true }
        }
        $bundle = [IO.Path]::GetDirectoryName($Configuration)
        if ([IO.Path]::GetFileName($Configuration) -cne 'configuration.json' -or
            $Configuration -match '%|\$\(' -or $Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            [string]::Equals($bundle, [IO.Path]::GetDirectoryName($Context.Data.configuration),
                [StringComparison]::OrdinalIgnoreCase)) { throw 'Replacement requires a distinct installed bundle.' }
        $candidate = [Deployment.WindowsRuntimeHost]::Open($Configuration, $Sha256, $bundle)
        $Context.Files.Add($candidate)
        $Context.Stage = 'replacement-current-policy'
        $task = $Context.Folder.GetTask($Context.Data.taskName)
        if ([string]$task.Xml -cne $Context.Definition -or
            [string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor) {
            throw 'Original task changed before replacement.'
        }
        $Context.Stage = 'replacement-action-shape'
        $definition = $task.Definition
        if ($definition.Actions.Count -ne 1 -or [int]$definition.Actions.Item(1).Type -ne 0 -or
            [int]$definition.Principal.LogonType -notin @(2, 3)) { throw 'Unsupported replacement task policy.' }
        $Context.Stage = 'replacement-executable'
        $process = [Diagnostics.Process]::GetCurrentProcess()
        try { $powershell = $process.MainModule.FileName }
        finally { $process.Dispose() }
        if ($powershell -match '%|\$\(') { throw 'PowerShell path is not literal for Task Scheduler.' }
        $hostFile = Join-Path $bundle 'windows-runtime-host.ps1'
        $Context.Stage = 'replacement-definition-xml'
        $requested = [xml]$Context.Definition
        $namespaces = [Xml.XmlNamespaceManager]::new($requested.NameTable)
        $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $values = [ordered]@{
            Command=$powershell
            Arguments="-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$Configuration`" -Sha256 $Sha256"
            WorkingDirectory=$bundle
        }
        foreach ($name in $values.Keys) {
            $nodes = $requested.SelectNodes("/t:Task/t:Actions/t:Exec/t:$name", $namespaces)
            if ($nodes.Count -ne 1) { throw 'Replacement requires one complete literal action.' }
            $nodes[0].InnerText = $values[$name]
        }
        $requestedDefinition = $requested.OuterXml
        if ($requestedDefinition.Length -gt 262144) { throw 'Replacement definition exceeds admission limits.' }
        Confirm-AgentsChatTaskReplacementPolicy $Context.Definition $requestedDefinition $Context
        $Context.ReplacementConfiguration = $Configuration
        $Context.ReplacementConfigurationSha256 = $Sha256
        $Context.ReplacementDefinition = $requestedDefinition
        $Context.ReplacementSha256 = $Context.RetirementSha256
        Test-AgentsChatRetiredTaskContext $Context
        Write-AgentsChatTaskReplacementReceipt $Context 'requested'
        Test-AgentsChatRetiredTaskContext $Context
        $Context.Stage = 'replacement-registration'
        # Update only; preserve the admitted DACL and suppress registration triggers.
        $null = $Context.Folder.RegisterTask($Context.Data.taskName, $requestedDefinition, (4 -bor 16 -bor 32),
            [string]$definition.Principal.UserId, $null, [int]$definition.Principal.LogonType,
            $Context.Data.securityDescriptor)
        $task = $Context.Folder.GetTask($Context.Data.taskName)
        $Context.Stage = 'replacement-registered-path'
        if ($task.Path -cne "\$($Context.Data.taskName)") { throw 'Registered replacement path differs.' }
        $Context.Stage = 'replacement-registered-inhibition'
        if ($task.Enabled -or $task.GetInstances(0).Count -ne 0) { throw 'Registered replacement is not inhibited.' }
        $Context.Stage = 'replacement-registered-security'
        if ([string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor) {
            throw 'Registered replacement security differs.'
        }
        Confirm-AgentsChatTaskReplacementPolicy $requestedDefinition ([string]$task.Xml) $Context
        $Context.Stage = 'replacement-registered-definition'
        if (([xml][string]$task.Xml).OuterXml -cne ([xml]$requestedDefinition).OuterXml) {
            throw 'Registered replacement definition differs.'
        }
        $Context.ReplacementDefinition = [string]$task.Xml
        $Context.ReplacementPrepared = $true
        Test-AgentsChatRetiredTaskContext $Context
        Write-AgentsChatTaskReplacementReceipt $Context 'complete'
        Test-AgentsChatRetiredTaskContext $Context
        return [pscustomobject]@{ replaced=$true; inhibited=$true }
    } catch {
        $Context.Poisoned = $true
        [Console]::Error.WriteLine("Task replacement diagnostic: line=$($_.InvocationInfo.ScriptLineNumber); hresult=$($_.Exception.GetBaseException().HResult).")
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}
