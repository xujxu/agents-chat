function Confirm-AgentsChatTaskReplacementPolicy([string]$Before, [string]$After) {
    $original = [xml]$Before
    $candidate = [xml]$After
    $namespaces = [Xml.XmlNamespaceManager]::new($original.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    foreach ($document in @($original, $candidate)) {
        $enabled = $document.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
        if ($enabled.Count -ne 1 -or $enabled[0].InnerText -cne 'false') {
            throw 'Replacement must retain explicit task inhibition.'
        }
        foreach ($name in @('Command', 'Arguments', 'WorkingDirectory')) {
            $nodes = $document.SelectNodes("/t:Task/t:Actions/t:Exec/t:$name", $namespaces)
            if ($nodes.Count -ne 1) { throw 'Replacement requires one complete literal action.' }
            $nodes[0].InnerText = 'normalized'
        }
    }
    if ($original.OuterXml -cne $candidate.OuterXml) { throw 'Unrelated replacement task policy changed.' }
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
            $Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            [string]::Equals($bundle, [IO.Path]::GetDirectoryName($Context.Data.configuration),
                [StringComparison]::OrdinalIgnoreCase)) { throw 'Replacement requires a distinct installed bundle.' }
        $candidate = [Deployment.WindowsRuntimeHost]::Open($Configuration, $Sha256, $bundle)
        $Context.Files.Add($candidate)
        $Context.Stage = 'replacement-definition'
        $task = $Context.Folder.GetTask($Context.Data.taskName)
        if ([string]$task.Xml -cne $Context.Definition -or
            [string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor) {
            throw 'Original task changed before replacement.'
        }
        $definition = $task.Definition
        if ($definition.Actions.Count -ne 1 -or [int]$definition.Actions.Item(1).Type -ne 0 -or
            [int]$definition.Principal.LogonType -notin @(2, 3)) { throw 'Unsupported replacement task policy.' }
        $process = [Diagnostics.Process]::GetCurrentProcess()
        try { $powershell = $process.MainModule.FileName }
        finally { $process.Dispose() }
        $action = $definition.Actions.Item(1)
        $action.Path = $powershell
        $hostFile = Join-Path $bundle 'windows-runtime-host.ps1'
        $action.Arguments = "-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$Configuration`" -Sha256 $Sha256"
        $action.WorkingDirectory = $bundle
        $requestedDefinition = [string]$definition.XmlText
        if ($requestedDefinition.Length -gt 262144) { throw 'Replacement definition exceeds admission limits.' }
        Confirm-AgentsChatTaskReplacementPolicy $Context.Definition $requestedDefinition
        $Context.ReplacementConfiguration = $Configuration
        $Context.ReplacementConfigurationSha256 = $Sha256
        $Context.ReplacementDefinition = $requestedDefinition
        $Context.ReplacementSha256 = $Context.RetirementSha256
        Test-AgentsChatRetiredTaskContext $Context
        Write-AgentsChatTaskReplacementReceipt $Context 'requested'
        Test-AgentsChatRetiredTaskContext $Context
        $Context.Stage = 'replacement-registration'
        # Update only; preserve the admitted DACL and suppress registration triggers.
        $null = $Context.Folder.RegisterTaskDefinition($Context.Data.taskName, $definition, (4 -bor 16 -bor 32),
            [string]$definition.Principal.UserId, $null, [int]$definition.Principal.LogonType,
            $Context.Data.securityDescriptor)
        $task = $Context.Folder.GetTask($Context.Data.taskName)
        if ($task.Path -cne "\$($Context.Data.taskName)" -or $task.Enabled -or
            $task.GetInstances(0).Count -ne 0 -or
            [string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor -or
            ([xml][string]$task.Xml).OuterXml -cne ([xml]$requestedDefinition).OuterXml) {
            throw 'Registered replacement differs from the admitted disabled candidate.'
        }
        $Context.ReplacementDefinition = [string]$task.Xml
        $Context.ReplacementPrepared = $true
        Test-AgentsChatRetiredTaskContext $Context
        Write-AgentsChatTaskReplacementReceipt $Context 'complete'
        Test-AgentsChatRetiredTaskContext $Context
        return [pscustomobject]@{ replaced=$true; inhibited=$true }
    } catch {
        $Context.Poisoned = $true
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}
