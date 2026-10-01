param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)]$Owner,
    [Parameter(Mandatory)]$Ready,
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)]$Binding
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/deployment/windows-task-maintenance.ps1')
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function New-Admission([string]$Name, [Collections.IDictionary]$Record) {
    $directory = Join-Path $Root $Name
    New-Item -ItemType Directory -Path $directory | Out-Null
    $security = Get-Acl -LiteralPath $directory
    $security.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
    Set-Acl -LiteralPath $directory -AclObject $security
    $file = Join-Path $directory 'admission.json'
    $retained = [Deployment.WindowsPrivateFile]::Publish($file, ($Record | ConvertTo-Json -Depth 8 -Compress))
    try { return @{ Admission=$file; Sha256=$retained.Sha256 } }
    finally { $retained.Dispose() }
}
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$task = $scheduler.GetFolder('\').GetTask($TaskName)
$readyFile = Join-Path (Split-Path $Configuration -Parent) "runtime-$($Ready.identity.Replace(':', '-')).json"
$record = [ordered]@{
    version=1
    operationId=[guid]::NewGuid().ToString('D')
    controllerPid=$PID
    controllerIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    taskName=$TaskName
    definition=[string]$task.Xml
    securityDescriptor=[string]$task.GetSecurityDescriptor(7)
    configuration=$Configuration
    configurationSha256=$Sha256
    readySha256=(Get-FileHash -LiteralPath $readyFile -Algorithm SHA256).Hash.ToLowerInvariant()
    ownerPid=$Owner.Id
    ownerIdentity=$Ready.identity
    generation=$Ready.generation
    instanceGuid=$Binding.instanceGuid
}
foreach ($mode in @('controller', 'configuration', 'generation', 'definition')) {
    $changed = [ordered]@{}
    foreach ($key in $record.Keys) { $changed[$key] = $record[$key] }
    switch ($mode) {
        'controller' { $changed.controllerIdentity = "$PID`:1" }
        'configuration' { $changed.configurationSha256 = '0' * 64 }
        'generation' { $changed.generation = [guid]::NewGuid().ToString('D') }
        'definition' { $changed.definition += ' ' }
    }
    $arguments = New-Admission "refused-$mode" $changed
    $refused = $false
    $unexpected = $null
    try { $unexpected = Stop-AgentsChatManagedTask @arguments }
    catch { $refused = $_.Exception.Message -match '^Task maintenance refused: [a-z-]+\.$' }
    finally { if ($unexpected) { Close-AgentsChatTaskMaintenance -Context $unexpected } }
    Assert ($refused -and $scheduler.GetFolder('\').GetTask($TaskName).Enabled -and
        @(Get-ChildItem -LiteralPath (Split-Path $arguments.Admission -Parent)).Count -eq 1) 'Invalid maintenance admission changed task policy or published stop intent'
}
Write-Output 'PASS: durable task maintenance refuses changed controller, configuration, generation and task policy before mutation'
$arguments = New-Admission 'accepted-stop' $record
$context = $null
try {
    $context = Stop-AgentsChatManagedTask @arguments
    $stopped = Assert-AgentsChatTaskStopped -Context $context
    Assert ($stopped.stopped -and $stopped.inhibited -and -not $Owner.HasExited) 'Native maintenance did not retain an inhibited, settled original owner'
    $phases = @('intent', 'inhibited', 'stop-requested', 'stopped')
    $previous = $arguments.Sha256
    foreach ($phase in $phases) {
        $file = Join-Path (Split-Path $arguments.Admission -Parent) "task-stop-$phase.json"
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        $retained = [Deployment.WindowsPrivateFile]::Open($file, $hash)
        try { $receipt = $retained.ReadText() | ConvertFrom-Json }
        finally { $retained.Dispose() }
        Assert ($receipt.version -eq 1 -and $receipt.phase -ceq $phase -and
            $receipt.operationId -ceq $record.operationId -and
            $receipt.admissionSha256 -ceq $arguments.Sha256 -and $receipt.previousSha256 -ceq $previous -and
            $receipt.instanceGuid -ceq $Binding.instanceGuid) 'Durable stop receipt lost its operation, original instance or hash chain'
        $previous = $hash
    }
    Assert (-not $scheduler.GetFolder('\').GetTask($TaskName).Enabled) 'Maintenance released restart inhibition'
    $changed = Get-ScheduledTask -TaskName $TaskName
    $changed.Description = 'changed after durable original-domain settlement'
    Set-ScheduledTask -InputObject $changed | Out-Null
    $refused = $false
    try { Assert-AgentsChatTaskStopped -Context $context | Out-Null }
    catch { $refused = $_.Exception.Message -match '^Task maintenance refused: [a-z-]+\.$' }
    Assert $refused 'Changed task policy retained stopped authority'
} finally {
    if ($context) { Close-AgentsChatTaskMaintenance -Context $context }
}
Assert (-not $scheduler.GetFolder('\').GetTask($TaskName).Enabled -and -not $Owner.HasExited) 'Closing maintenance restarted or retired the original task owner'
Assert (@(Get-ChildItem -LiteralPath (Split-Path $arguments.Admission -Parent) -Filter 'task-stop-*.json').Count -eq 4) 'Closing maintenance removed durable stop evidence'
Write-Output 'PASS: durable native maintenance records original stop phases, detects policy mutation and leaves inhibition/evidence after close'
