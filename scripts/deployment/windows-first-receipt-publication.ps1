. (Join-Path $PSScriptRoot 'windows-first-completion-proof.ps1')

function Assert-AgentsChatFirstReceiptPublication([hashtable]$Context) {
    if (-not $Context.Recovery -or $Context.Phase -cne 'complete' -or $null -eq $Context.DeploymentIdentity) {
        throw 'Cold receipt publication requires complete original runtime and prepared deployment identity.'
    }
    foreach ($pattern in @('deployment.json.pending-*', '.deployment.json.staging*')) {
        if ([IO.Directory]::GetFileSystemEntries($Context.Control, $pattern).Length) {
            throw 'Incomplete receipt publication evidence must be retained for recovery.'
        }
    }
    return Assert-AgentsChatFirstCompletionProof $Context
}

function Publish-AgentsChatFirstDeploymentReceipt([hashtable]$Context, [string]$ServiceText) {
    $null = Assert-AgentsChatFirstReceiptPublication $Context
    $service = Read-AgentsChatMaintenanceFields $ServiceText @(
        'project', 'taskName', 'definition', 'securityDescriptor', 'principalSid', 'enabled', 'configurationSha256')
    if ($service.project.GetString() -cne $Context.Project -or
        $service.taskName.GetString() -cne $Context.TaskName -or
        $service.definition.GetString() -cne $Context.NativeDefinition -or
        $service.securityDescriptor.GetString() -cne $Context.SecurityDescriptor -or
        $service.principalSid.GetString() -cne $Context.AccountSid -or
        $service.enabled.GetBoolean() -ne $Context.Enabled -or
        $service.configurationSha256.GetString() -cne $Context.ConfigurationSha256) {
        throw 'Cold receipt service identity differs from retained original task and runtime.'
    }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($ServiceText))).ToLowerInvariant()
    if ($Context.DeploymentReceiptPresent) {
        $receipt = Read-AgentsChatMaintenanceFields ($Context.DeploymentReceiptFile.ReadText()) @(
            'version', 'project', 'operationId', 'status', 'acceptedAt', 'identity')
        $identity = Read-AgentsChatMaintenanceFields $receipt.identity.GetRawText() @(
            'source', 'build', 'dependencies', 'config', 'service')
        if ($identity.service.GetString() -cne $hash) { throw 'Existing first receipt service identity differs.' }
    } else {
        $identity = [ordered]@{}
        foreach ($name in @('source', 'build', 'dependencies', 'config')) {
            $identity[$name] = $Context.DeploymentIdentity[$name]
        }
        $identity.service = $hash
        $text = [ordered]@{
            version=1; project=$Context.Project; operationId=$Context.OperationId; status='accepted'
            acceptedAt=$Context.AcceptedState.updatedAt.GetString(); identity=$identity
        } | ConvertTo-Json -Depth 8 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount("$text`n") -gt 8192) { throw 'Oversized first deployment receipt.' }
        $null = Assert-AgentsChatFirstReceiptPublication $Context
        $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control 'deployment.json'), "$text`n")
        $Context.Files.Add($file)
        $Context.DeploymentReceiptFile = $file
        $Context.DeploymentReceiptPresent = $true
    }
    $null = Assert-AgentsChatFirstReceiptPublication $Context
    return $Context.DeploymentReceiptFile.ReadText()
}
