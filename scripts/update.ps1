[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [string]$Revision,
    [switch]$SkipGitPull,
    [switch]$NoInstall,
    [int]$WaitSeconds = 180,
    [int]$TimeoutSeconds = 1800,
    [switch]$Status,
    [switch]$Json,
    [switch]$Help,
    [switch]$NoWait,
    [switch]$Verify,
    [switch]$DryRun,
    [switch]$RemoveTask,
    [string]$UserId,
    [switch]$NoTunnel,
    [ValidateSet('Interactive', 'S4U')][string]$TaskLogonType,
    [ValidateSet('AtLogOn', 'AtStartup')][string]$TaskTriggerType
)
. (Join-Path $PSScriptRoot 'deployment/windows-public-command.ps1')
exit (Invoke-WindowsPublicCommand -Operation update -Source (Split-Path -Parent $PSScriptRoot) -Options $PSBoundParameters)
