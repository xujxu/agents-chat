# Share the Teams bot with colleagues, or stop sharing it, and update TEAMS_ALLOWED_USERS.
# See docs/teams-bot.md "Add or remove colleagues with one command". Run from an elevated
# PowerShell unless you pass -NoRestart. Examples:
#   .\scripts\teams-share.ps1 add alice@contoso.com,bob@contoso.com
#   .\scripts\teams-share.ps1 remove bob@contoso.com
#   .\scripts\teams-share.ps1 list
param(
    [Parameter(Position = 0)][string]$Command,
    [Parameter(Position = 1)][string[]]$Emails = @(),
    [string]$ProjectDir = $env:AGENTS_CHAT_PROJECT_DIR,
    [string]$TeamsAppDir,
    [string]$Env,
    [switch]$NoRestart,
    [int]$WaitSeconds = 120,
    [switch]$DryRun,
    [switch]$Help
)

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'Node.js 24 was not found on PATH.'; exit 2 }

$cliArgs = @()
if ($Help -or -not $Command) { $cliArgs += '--help' }
else {
    $cliArgs += $Command
    if ($Emails.Count) { $cliArgs += ($Emails -join ',') }
    if ($ProjectDir) { $cliArgs += @('--project-dir', $ProjectDir) }
    if ($TeamsAppDir) { $cliArgs += @('--teams-app-dir', $TeamsAppDir) }
    if ($Env) { $cliArgs += @('--env', $Env) }
    if ($NoRestart) { $cliArgs += '--no-restart' }
    $cliArgs += @('--wait', "$WaitSeconds")
    if ($DryRun) { $cliArgs += '--dry-run' }
}

& $node.Source (Join-Path $PSScriptRoot 'teams-share\cli.mjs') @cliArgs
exit $LASTEXITCODE
