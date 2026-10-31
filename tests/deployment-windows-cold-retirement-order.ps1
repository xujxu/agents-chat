param([Parameter(Mandatory)][string]$WorkerNamesJson)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/deployment/windows-cold-retirement-record.ps1')
@(Get-AgentsChatColdRetirementPaths ($WorkerNamesJson | ConvertFrom-Json)) | ConvertTo-Json -Compress
