# Switch back to a previous release and its matching chat-data backup.
# See README "Deployment (Windows)". Run from an elevated PowerShell.
param(
    [string]$ProjectDir = $env:AGENTS_CHAT_PROJECT_DIR,
    [string]$Revision,
    [switch]$AcceptDataLoss,
    [string]$TaskName,
    [int]$Port,
    [switch]$NoWait,
    [int]$WaitSeconds = 120,
    [switch]$DryRun,
    [switch]$Json
)

. (Join-Path $PSScriptRoot 'deploy\Invoke-Core.ps1')
$extra = @()
if ($AcceptDataLoss) { $extra += '--accept-data-loss' }
Invoke-DeployCore -Command 'restore' -Bound $PSBoundParameters -Extra $extra
