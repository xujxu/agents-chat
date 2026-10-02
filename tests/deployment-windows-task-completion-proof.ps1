param([Parameter(Mandatory)][string]$Control, [string]$ExpectedFailure, [string]$ExpectedCause)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/deployment'))
Add-Type -Path @(
    (Join-Path $source 'WindowsWorkerJob.cs'), (Join-Path $source 'WindowsRuntimeDomain.cs'),
    (Join-Path $source 'WindowsRuntimePipe.cs'), (Join-Path $source 'WindowsRuntimeControl.cs'),
    (Join-Path $source 'WindowsPrivateFile.cs'), (Join-Path $source 'WindowsRuntimeLease.cs'),
    (Join-Path $source 'WindowsRuntimeHost.cs'), (Join-Path $source 'WindowsRuntimeListener.cs'))
. (Join-Path $source 'windows-task-completion-proof.ps1')
$proof = $null
$refused = $false
try {
    $proof = Open-AgentsChatTaskCompletionProof -Control $Control
    $result = Assert-AgentsChatTaskCompletionProof -Context $proof
} catch {
    if (-not $ExpectedFailure -or $_.Exception.ToString() -cnotmatch [regex]::Escape($ExpectedFailure) -or
        ($ExpectedCause -and $_.Exception.ToString() -cnotmatch [regex]::Escape($ExpectedCause))) { throw }
    $refused = $true
} finally {
    if ($proof) { Close-AgentsChatTaskCompletionProof -Context $proof }
}
if ($ExpectedFailure) {
    if (-not $refused) { throw 'Completion proof unexpectedly accepted the refused case.' }
    [pscustomobject]@{ status='refused'; reason=$ExpectedFailure } | ConvertTo-Json -Compress
} else { $result | ConvertTo-Json -Depth 5 -Compress }
