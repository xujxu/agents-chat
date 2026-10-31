[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [switch]$AcceptDataLoss,
    [int]$TimeoutSeconds = 1800,
    [switch]$Json,
    [switch]$Help
)
. (Join-Path $PSScriptRoot 'deployment/windows-public-command.ps1')
exit (Invoke-WindowsPublicCommand -Operation restore -Source (Split-Path -Parent $PSScriptRoot) -Options $PSBoundParameters)
