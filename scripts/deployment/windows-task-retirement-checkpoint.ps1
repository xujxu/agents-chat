function Get-AgentsChatRetirementTextHash([string]$Text) {
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Prepare-AgentsChatTaskRetirementCheckpoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Context,
        [Parameter(Mandatory)][int]$ControllerPid,
        [Parameter(Mandatory)][string]$ControllerIdentity
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $prepared = Prepare-AgentsChatTaskRetirement -Context $Context `
        -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
    $candidate = [ordered]@{
        version=1; intent=$prepared.descriptor; configuration=$Context.Configuration
        definitionSha256=(Get-AgentsChatRetirementTextHash $Context.NativeDefinition)
        securityDescriptorSha256=(Get-AgentsChatRetirementTextHash $Context.SecurityDescriptor)
        enabled=$Context.Enabled
        listener=[ordered]@{
            pid=$Context.Completed.listenerPid.GetInt32()
            processIdentity=$Context.Completed.listenerIdentity.GetString()
            createdAt=$Context.Completed.listenerCreatedAt.GetString()
            address=$Context.Completed.listenerAddress.GetString()
            pairedRecords=$Context.Completed.listenerPairedRecords.GetBoolean()
        }
        retiredBridge=[ordered]@{ pid=$Context.BridgePid; processIdentity=$Context.BridgeIdentity }
        retiredOwner=[ordered]@{
            pid=$Context.Admission.ownerPid.GetInt32()
            processIdentity=$Context.Admission.ownerIdentity.GetString()
        }
        creator=[ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
    }
    $published = Publish-AgentsChatRetirementRecord -Context $Context -Candidate $candidate `
        -Name 'task-retirement-checkpoint.json'
    return [ordered]@{
        status='prepared'; descriptor=$published.descriptor; intent=$prepared; checkpoint=$published.record
    }
}
