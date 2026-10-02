param(
    [Parameter(Mandatory)][string]$Admission,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [string]$Control,
    [string]$LockSha256,
    [string]$StateSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$retained = $null
$context = $null
$watch = $null
$transaction = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported bridge platform.' }
    Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-transaction.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-retirement.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-replacement.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-activation.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-listener.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-completion.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwner($ControllerPid, $ControllerIdentity)
    $retained = [Deployment.WindowsPrivateFile]::Open($Admission, $Sha256)
    $fields = Read-AgentsChatMaintenanceFields ($retained.ReadText()) @(
        'version', 'operationId', 'controllerPid', 'controllerIdentity', 'taskName', 'definition',
        'securityDescriptor', 'configuration', 'configurationSha256', 'readySha256',
        'ownerPid', 'ownerIdentity', 'generation', 'instanceGuid')
    if ($fields.controllerPid.GetInt32() -ne $ControllerPid -or
        $fields.controllerIdentity.GetString() -cne $ControllerIdentity) { throw 'Original controller differs.' }
    $stage = 'transaction'
    if ($Control -or $LockSha256 -or $StateSha256) {
        if (-not $Control -or -not $LockSha256 -or -not $StateSha256 -or
            $Admission -cne (Join-Path $Control 'task-maintenance/admission.json')) {
            throw 'Incomplete native transaction admission.'
        }
        $transaction = Open-AgentsChatTaskTransaction -Control $Control -LockSha256 $LockSha256 `
            -StateSha256 $StateSha256 -AdmissionFields $fields
    }
    $stage = 'stop'
    $context = Stop-AgentsChatManagedTask -Admission $Admission -Sha256 $Sha256 -Transaction $transaction
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        admissionSha256=$Sha256; stopped=$true; inhibited=$true
        transactionSha256=$(if ($transaction) { $LockSha256 } else { $null })
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        if (-not $line.Wait(1800000)) { throw 'Controller request timed out.' }
        $text = $line.GetAwaiter().GetResult()
        $document = [Text.Json.JsonDocument]::Parse($text)
        try { $method = $document.RootElement.GetProperty('method').GetString() }
        finally { $document.Dispose() }
        $fields = @('id', 'method')
        if ($method -ceq 'replace') { $fields += @('configuration', 'sha256') }
        if ($method -ceq 'listener') { $fields += @('port') }
        if ($method -ceq 'prepare-completion') { $fields += @('port', 'providers') }
        if ($method -ceq 'complete') { $fields += @('stateSha256') }
        $request = Read-AgentsChatMaintenanceFields $text $fields
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close', 'retire', 'replace', 'activate', 'listener',
            'prepare-completion', 'complete')) { throw 'Invalid controller request.' }
        $sequence = $id
        $stage = 'check'
        $retained.Check()
        if ($method -ceq 'complete') {
            $stage = 'complete'
            Complete-AgentsChatTaskActivation -Context $context -StateSha256 $request.stateSha256.GetString()
        }
        elseif ($context.Activated) { $null = Assert-AgentsChatTaskActive -Context $context }
        elseif ($context.Retired) { $null = Assert-AgentsChatTaskRetired -Context $context }
        else { $null = Assert-AgentsChatTaskStopped -Context $context }
        if ($method -ceq 'retire') {
            $stage = 'retire'
            $null = Retire-AgentsChatTaskOwner -Context $context
        }
        if ($method -ceq 'replace') {
            $stage = 'replace'
            $null = Publish-AgentsChatTaskReplacement -Context $context `
                -Configuration $request.configuration.GetString() -Sha256 $request.sha256.GetString()
        }
        $reply = @{ id=$id; type='reply'; value=$method }
        if ($method -ceq 'activate') {
            $stage = 'activate'
            $reply.runtime = Start-AgentsChatTaskReplacement -Context $context
        }
        if ($method -ceq 'listener') {
            $stage = 'listener'
            $reply.listener = Open-AgentsChatTaskListener -Context $context -Port $request.port.GetInt32()
        }
        if ($method -ceq 'prepare-completion') {
            $stage = 'prepare-completion'
            $providers = @($request.providers.EnumerateArray() | ForEach-Object { $_.GetString() })
            Prepare-AgentsChatTaskCompletion -Context $context -Port $request.port.GetInt32() -Providers $providers
        }
        if ($method -ceq 'close') {
            $stage = 'close'
            Close-AgentsChatTaskMaintenance -Context $context
            $context = $null
            $retained.Dispose()
            $retained = $null
            if ($transaction) { Close-AgentsChatTaskTransaction $transaction; $transaction = $null }
        }
        [Console]::Out.WriteLine(($reply | ConvertTo-Json -Depth 4 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { return }
    }
} catch {
    if ($_.Exception.Message -cmatch '^Task maintenance refused: ([a-z-]+)\.$') { $stage += "/$($Matches[1])" }
    [Console]::Error.WriteLine("Task controller refused: $stage.")
    exit 1
} finally {
    if ($context) { Close-AgentsChatTaskMaintenance -Context $context }
    if ($retained) { $retained.Dispose() }
    if ($transaction) { Close-AgentsChatTaskTransaction $transaction }
    if ($watch) { $watch.Dispose() }
}
