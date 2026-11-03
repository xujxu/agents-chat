# Install, migrate or rebuild Agents-Chat as a Scheduled Task with release folders.
# See README "Deployment (Windows)". Run from an elevated PowerShell.
param(
    [string]$ProjectDir = $env:AGENTS_CHAT_PROJECT_DIR,
    [string]$ImportFrom,
    [string]$Repo,
    [string]$Revision,
    [switch]$SkipGitPull,
    [switch]$NoInstall,
    [switch]$RemoveTask,
    [string]$TaskName = 'Agents-Chat-Startup',
    [ValidateSet('Interactive', 'S4U')]
    [string]$TaskLogonType = 'Interactive',
    [ValidateSet('AtLogOn', 'AtStartup')]
    [string]$TaskTriggerType = 'AtLogOn',
    [string]$UserId,
    [switch]$NoTunnel,
    [switch]$Cloudflare,
    [int]$Port,
    [switch]$NoWait,
    [int]$WaitSeconds = 120,
    [switch]$DryRun,
    [switch]$Json
)

if ($NoTunnel -and $Cloudflare) { Write-Error '-NoTunnel and -Cloudflare are mutually exclusive.'; exit 2 }
. (Join-Path $PSScriptRoot 'deploy\Invoke-Core.ps1')

$tunnel = if ($NoTunnel) { 'None' } elseif ($Cloudflare) { 'Cloudflare' } else { 'DevTunnel' }
$extra = @('--logon-type', $TaskLogonType, '--trigger-type', $TaskTriggerType, '--tunnel', $tunnel)
if ($ImportFrom) { $extra += @('--import-from', $ImportFrom) }
if ($Repo) { $extra += @('--repo', $Repo) }
if ($UserId) { $extra += @('--user', $UserId) }
if ($SkipGitPull) { $extra += '--skip-git-pull' }
if ($RemoveTask) { $extra += '--remove-task' }

Invoke-DeployCore -Command 'deploy' -Bound $PSBoundParameters -Extra $extra
