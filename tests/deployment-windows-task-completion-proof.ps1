param([Parameter(Mandatory)][string]$Control)
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
try {
    $proof = Open-AgentsChatTaskCompletionProof -Control $Control
    Assert-AgentsChatTaskCompletionProof -Context $proof | ConvertTo-Json -Depth 5 -Compress
} finally {
    if ($proof) { Close-AgentsChatTaskCompletionProof -Context $proof }
}
