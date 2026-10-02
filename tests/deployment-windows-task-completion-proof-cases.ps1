param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Directory,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)]$Runtime,
    [Parameter(Mandatory)][string]$StateSha256,
    [Parameter(Mandatory)][string]$CompletionSha256,
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)]$Owner,
    [Parameter(Mandatory)]$Member
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$wrapper = Join-Path $PSScriptRoot 'deployment-windows-task-completion-proof.ps1'
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
function Observe([string]$Failure = '', [string]$Cause = '') {
    $output = & $pwsh -NoProfile -NonInteractive -File $wrapper -Control $Control -ExpectedFailure $Failure -ExpectedCause $Cause
    Assert ($LASTEXITCODE -eq 0) 'Fresh completed-task proof process failed'
    $proof = ($output -join "`n") | ConvertFrom-Json
    if ($Failure) {
        Assert ($proof.status -ceq 'refused' -and $proof.reason -ceq $Failure) 'Expected completion refusal was not observed'
    } else {
        Assert ($proof.status -ceq 'observed' -and -not $proof.mutationAuthority -and
            $proof.lease -ceq 'released' -and $proof.operationId -ceq $OperationId -and
            $proof.taskName -ceq $TaskName -and $proof.stateSha256 -ceq $StateSha256 -and
            $proof.completionSha256 -ceq $CompletionSha256 -and $proof.port -eq $Port -and
            @($proof.providers).Count -eq 1 -and $proof.providers[0] -ceq 'admin-login') 'Cold proof lost original completed authority'
        foreach ($field in $Runtime.PSObject.Properties.Name) {
            Assert ($proof.runtime.$field -ceq $Runtime.$field) 'Cold proof adopted another runtime'
        }
    }
    Assert (-not $Owner.HasExited -and -not $Member.HasExited) 'Read-only observation stopped original runtime work'
}
function Evidence {
    foreach ($file in @(Get-ChildItem -LiteralPath $Directory -File | Sort-Object Name) +
        @(Get-Item -LiteralPath (Join-Path $Control 'state.json'), (Join-Path $Control 'lock/owner.json'))) {
        "$($file.FullName):$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
    }
}
function Changed-Bytes([string]$Path, [string]$Text, [string]$Failure, [string]$Cause = '') {
    $bytes = [IO.File]::ReadAllBytes($Path)
    try {
        [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
        Observe $Failure $Cause
    } finally { [IO.File]::WriteAllBytes($Path, $bytes) }
}
$definition = [string]$folder.GetTask($TaskName).Xml
$enabled = [bool]$folder.GetTask($TaskName).Enabled
$before = @(Evidence)
Observe
$state = Join-Path $Control 'state.json'
Changed-Bytes $state ([IO.File]::ReadAllText($state) + "`n") 'records-completion-state' 'Private configuration digest differs.'
$intent = Join-Path $Directory 'task-stop-intent.json'
Changed-Bytes $intent ([IO.File]::ReadAllText($intent) + "`n") 'records-stop-inhibited' 'Completion receipt chain differs.'
$prepared = Join-Path $Directory 'task-complete-prepared.json'
$text = [IO.File]::ReadAllText($prepared)
Assert ($text.StartsWith('{"version":1,')) 'Completion fixture requires its original ordered record'
Changed-Bytes $prepared ($text.Replace('{"version":1,', '{"version":1,"version":1,')) `
    'records-complete-prepared' 'Unexpected or duplicate field.'
Changed-Bytes $prepared ($text.Replace('{"version":1,', '{"version":1,"unexpected":true,')) `
    'records-complete-prepared' 'Unexpected or duplicate field.'
$extra = Join-Path $Directory 'unexpected-proof-evidence.json'
try {
    [IO.File]::WriteAllText($extra, '{}')
    Observe 'inventory' 'Unsupported completion evidence inventory.'
} finally { Remove-Item -LiteralPath $extra }
$recovery = Join-Path $Control 'recovery-lock'
try {
    [IO.File]::WriteAllText($recovery, '{}')
    Observe 'directories' 'Exclusive recovery authority exists.'
} finally { Remove-Item -LiteralPath $recovery }
try {
    $folder.GetTask($TaskName).Enabled = -not $enabled
    Observe 'task-policy' 'Completed task policy differs.'
} finally { $folder.GetTask($TaskName).Enabled = $enabled }
Observe
Assert (($before -join "`n") -ceq (@(Evidence) -join "`n") -and
    [string]$folder.GetTask($TaskName).Xml -ceq $definition) 'Proof changed retained evidence, state/lock or task policy'
[IO.File]::WriteAllText((Join-Path $Root 'listener-rebind'), 'rebind')
$reboundFile = Join-Path $Root 'listener-rebound.json'
$deadline = [Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path -LiteralPath $reboundFile)) {
    Assert ($deadline.ElapsedMilliseconds -lt 10000 -and -not $Member.HasExited) 'Original listener did not rebind'
    Start-Sleep -Milliseconds 100
}
$rebound = Get-Content -LiteralPath $reboundFile -Raw | ConvertFrom-Json
Assert ($rebound.pid -eq $Member.Id -and $rebound.port -eq $Port) 'Rebind must retain original listener process and port'
Observe 'runtime-listener' 'Listener is not the original completed binding.'
Assert (($before -join "`n") -ceq (@(Evidence) -join "`n") -and
    [string]$folder.GetTask($TaskName).Xml -ceq $definition) 'Rebind refusal changed private evidence or task policy'
Write-Output 'PASS: fresh completion proof retains original evidence/runtime, refuses changed state, receipt chains/schema, inventory, recovery authority, task policy and same-process rebind without mutation'
