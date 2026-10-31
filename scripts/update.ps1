# Upgrade Agents-Chat to the latest (or a given) commit, with automatic rollback.
# See README "Deployment (Windows)". Run from an elevated PowerShell.
param(
    [string]$ProjectDir = $env:AGENTS_CHAT_PROJECT_DIR,
    [string]$Revision,
    [switch]$NoInstall,
    [string]$TaskName,
    [int]$Port,
    [switch]$NoWait,
    [int]$WaitSeconds = 120,
    [switch]$DryRun,
    [switch]$Status,
    [switch]$Json
)

. (Join-Path $PSScriptRoot 'deploy\Invoke-Core.ps1')
$extra = @()
if ($Status) { $extra += '--status' }
Invoke-DeployCore -Command 'update' -Bound $PSBoundParameters -Extra $extra
