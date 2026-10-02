function Get-AgentsChatRetirementFile([hashtable]$Context, [string]$Relative) {
    $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control $Relative) ''
    $identity = $file.CaptureIdentity()
    return [ordered]@{
        path=$Relative; dev=$identity.Dev; ino=$identity.Ino; bytes=$file.ByteLength; sha256=$file.Sha256
    }
}

function Get-AgentsChatRetirementDirectory([hashtable]$Context, [string]$Path) {
    $directory = [Deployment.WindowsPrivateFile]::OpenDirectory($Path)
    $Context.Files.Add($directory)
    $identity = $directory.CaptureIdentity()
    return [ordered]@{ dev=$identity.Dev; ino=$identity.Ino }
}

function Get-AgentsChatRetirementCompletion($Observation) {
    $runtime = [ordered]@{}
    foreach ($name in @('pid', 'identity', 'generation', 'instanceGuid', 'sessionId',
        'configurationSha256', 'launcherPid', 'readySha256')) {
        $runtime[$name] = $Observation.runtime.$name
    }
    return [ordered]@{
        status=$Observation.status; mutationAuthority=$Observation.mutationAuthority
        operationId=$Observation.operationId; taskName=$Observation.taskName
        stateSha256=$Observation.stateSha256; completionSha256=$Observation.completionSha256
        runtime=$runtime; port=$Observation.port; providers=[string[]]$Observation.providers; lease=$Observation.lease
    }
}

function Prepare-AgentsChatTaskRetirement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Context,
        [Parameter(Mandatory)][int]$ControllerPid,
        [Parameter(Mandatory)][string]$ControllerIdentity
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    Assert-AgentsChatCompletionProcessIdentity $ControllerPid $ControllerIdentity
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original retirement controller changed.'
    }
    $completion = Get-AgentsChatRetirementCompletion (Assert-AgentsChatTaskCompletionProof -Context $Context)
    $lockPath = Join-Path $Context.Control 'lock\owner.json'
    $lockFile = Open-AgentsChatCompletionFile $Context $lockPath ''
    $lockNames = @('version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    $lockFields = Read-AgentsChatMaintenanceFields ($lockFile.ReadText()) $lockNames
    $lock = [ordered]@{}
    foreach ($name in $lockNames) {
        $lock[$name] = if ($name -cin @('version', 'pid')) { $lockFields[$name].GetInt32() }
            else { $lockFields[$name].GetString() }
    }
    $paths = @('task-maintenance\admission.json', 'task-maintenance\transaction.json')
    $paths += @($Context.RecordNames | ForEach-Object { "task-maintenance\task-$_.json" })
    $candidate = [ordered]@{
        version=1; control=$Context.Control; project=$Context.Project; lock=$lock
        lockFile=(Get-AgentsChatRetirementFile $Context 'lock\owner.json')
        state=(Get-AgentsChatRetirementFile $Context 'state.json')
        controlIdentity=(Get-AgentsChatRetirementDirectory $Context $Context.Control)
        lockIdentity=(Get-AgentsChatRetirementDirectory $Context (Join-Path $Context.Control 'lock'))
        maintenanceIdentity=(Get-AgentsChatRetirementDirectory $Context $Context.Directory)
        completion=$completion
        files=@($paths | ForEach-Object { Get-AgentsChatRetirementFile $Context $_ })
        creator=[ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
    }
    if ($candidate.lock.operationId -cne $completion.operationId -or
        $candidate.lock.project -cne $candidate.project -or $candidate.state.sha256 -cne $completion.stateSha256 -or
        $candidate.files[-1].sha256 -cne $completion.completionSha256) { throw 'Original retirement scope differs.' }
    $text = $candidate | ConvertTo-Json -Depth 12 -Compress
    $marker = Join-Path $Context.Control 'task-retirement.json'
    $null = Assert-AgentsChatTaskCompletionProof -Context $Context
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original retirement controller changed before publication.'
    }
    if (Test-Path -LiteralPath $marker) {
        $retained = Open-AgentsChatCompletionFile $Context $marker ''
        $stored = Read-AgentsChatMaintenanceFields ($retained.ReadText()) ([string[]]$candidate.Keys)
        $expected = Read-AgentsChatMaintenanceFields $text ([string[]]$candidate.Keys)
        foreach ($name in $candidate.Keys) {
            if ($name -cne 'creator' -and $stored[$name].GetRawText() -cne $expected[$name].GetRawText()) {
                throw "Original retirement intent differs: $name."
            }
        }
        $creator = Read-AgentsChatMaintenanceFields $stored.creator.GetRawText() @(
            'pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')
        $owner = [ordered]@{
            pid=$creator.pid.GetInt32(); processIdentity=$creator.processIdentity.GetString()
            bridgePid=$creator.bridgePid.GetInt32(); bridgeIdentity=$creator.bridgeIdentity.GetString()
        }
        Assert-AgentsChatCompletionProcessIdentity $owner.pid $owner.processIdentity
        Assert-AgentsChatCompletionProcessIdentity $owner.bridgePid $owner.bridgeIdentity
        if ($owner.pid -eq $owner.bridgePid) { throw 'Ambiguous retirement creator.' }
        if ($owner.pid -ne $ControllerPid -or $owner.processIdentity -cne $ControllerIdentity -or
            $owner.bridgePid -ne $PID -or $owner.bridgeIdentity -cne $candidate.creator.bridgeIdentity) {
            Assert-AgentsChatCompletionProcessAbsent $owner.pid $owner.processIdentity
            Assert-AgentsChatCompletionProcessAbsent $owner.bridgePid $owner.bridgeIdentity
        }
        $candidate.creator = $owner
    } else {
        $retained = [Deployment.WindowsPrivateFile]::Publish($marker, $text)
        $Context.Files.Add($retained)
    }
    $identity = $retained.CaptureIdentity()
    $descriptor = [ordered]@{
        path='task-retirement.json'; dev=$identity.Dev; ino=$identity.Ino
        bytes=$retained.ByteLength; sha256=$retained.Sha256
    }
    $null = Assert-AgentsChatTaskCompletionProof -Context $Context
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original retirement controller changed after publication.'
    }
    return [ordered]@{ status='prepared'; descriptor=$descriptor; intent=$candidate }
}
