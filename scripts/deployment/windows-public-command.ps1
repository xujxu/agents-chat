function Invoke-WindowsPublicCommand {
    param(
        [Parameter(Mandatory)][ValidateSet('deploy', 'update')][string]$Operation,
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][Collections.IDictionary]$Options
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $PSNativeCommandUseErrorActionPreference = $false
    $code = 0
    $result = $null
    $stage = 'arguments'
    try {
        if ($Options['Help']) {
            $result = @{
                status = 'help'
                message = @"
Usage: pwsh -NoProfile -File scripts/$Operation.ps1 [options]

Existing running managed tasks only; requires elevated PowerShell 7.4+ and
Node.js 24 with its bundled npm, plus Git on the controller PATH.
  -ProjectDir PATH       Installed checkout (default: this tools checkout)
  -TaskName NAME         Existing task (default: Agents-Chat-Startup)
  -Revision SHA          Full locally available commit; conflicts with -SkipGitPull
  -SkipGitPull           Keep current source revision
  -NoInstall            Skip npm ci, but still build and verify
  -WaitSeconds SECONDS   Positive readiness wait (default: 180)
  -TimeoutSeconds N      Positive per-stage deadline (default: 1800)
  -Status               Read-only status; creates no directories or captures
  -Json                 One JSON result on stdout; progress/errors on stderr
  -Help                 Show this help without accessing tools or installation

First installation, legacy/stopped tasks, restore, -NoWait, -Verify, -DryRun,
-RemoveTask and explicit -UserId/-NoTunnel/-TaskLogonType/-TaskTriggerType
changes are not supported yet. There is no legacy deployment fallback.
The existing task identity, account, triggers and configuration are preserved.
Readiness uses port 3010. Control/backup lives in sibling .<project>.deployment;
private helpers use sibling .<project>.deployment-controllers.
Successful helper captures are retired; failed captures and recovery evidence
must be retained for inspection. Never manually remove an operation lock.
"@
            }
        } else {
            $unsupported = $Options['NoWait'] -or $Options['Verify'] -or $Options['DryRun'] -or $Options['RemoveTask'] -or
                ($Options.ContainsKey('WaitSeconds') -and $Options['WaitSeconds'] -eq 0)
            foreach ($name in @('UserId', 'NoTunnel', 'TaskLogonType', 'TaskTriggerType')) {
                if ($Options.ContainsKey($name)) { $unsupported = $true }
            }
            if ($unsupported) {
                $code = 1
                $result = @{ status = 'failed'; code = 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED'
                    message = 'This Windows command mode is not supported; no operation was started.' }
            } else {
                $stage = 'controller-prerequisites'
                if ($PSVersionTable.PSVersion -lt [version]'7.4' -or -not $IsWindows) {
                    throw 'An elevated Windows PowerShell 7.4 or newer controller is required.'
                }
                $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
                if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                    throw 'An elevated Windows controller is required.'
                }
                $arguments = [Collections.Generic.List[string]]::new()
                foreach ($pair in @(@('SkipGitPull', '--no-pull'), @('NoInstall', '--no-install'), @('Status', '--status'))) {
                    if ($Options[$pair[0]]) { $arguments.Add($pair[1]) }
                }
                if ($Options.ContainsKey('Revision')) {
                    $arguments.Add('--revision'); $arguments.Add($Options['Revision'])
                }
                if (-not $Options['Status'] -or $Options.ContainsKey('WaitSeconds')) {
                    $arguments.Add('--wait')
                    $arguments.Add($(if ($Options.ContainsKey('WaitSeconds')) { [string]$Options['WaitSeconds'] } else { '180' }))
                }
                if (-not $Options['Status'] -or $Options.ContainsKey('TimeoutSeconds')) {
                    $arguments.Add('--timeout')
                    $arguments.Add($(if ($Options.ContainsKey('TimeoutSeconds')) { [string]$Options['TimeoutSeconds'] } else { '1800' }))
                }
                $project = if ($Options.ContainsKey('ProjectDir')) { $Options['ProjectDir'] } else { $Source }
                $project = [IO.Path]::GetFullPath($project)
                $taskName = if ($Options.ContainsKey('TaskName')) { $Options['TaskName'] } else { 'Agents-Chat-Startup' }
                $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
                $git = (Get-Command git.exe -CommandType Application -ErrorAction Stop).Source
                $pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
                $jsonArguments = ConvertTo-Json -InputObject $arguments.ToArray() -Compress
                $nodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
                $nodePath = [Environment]::GetEnvironmentVariable('NODE_PATH', 'Process')
                try {
                    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process')
                    [Environment]::SetEnvironmentVariable('NODE_PATH', $null, 'Process')
                    $stage = 'context'
                    $text = & $node (Join-Path $PSScriptRoot 'windows-public-context.mjs') `
                        $Operation $Source $project $taskName $git $pwsh $jsonArguments
                    $code = $LASTEXITCODE
                    $context = ($text -join "`n") | ConvertFrom-Json
                    if ($code -ne 0) { $result = $context }
                    elseif ($context.operation -ceq 'status') {
                        $stage = 'status'
                        $statusArguments = [string[]]$context.args
                        $text = & $context.node (Join-Path $PSScriptRoot 'windows-command-entry.mjs') `
                            $Operation $context.project $context.control $context.taskName $context.pwsh `
                            $context.git $context.npmCli @statusArguments
                        $code = $LASTEXITCODE
                        $result = ($text -join "`n") | ConvertFrom-Json
                    } else {
                        $stage = 'supervisor'
                        $directory = Join-Path $context.temporary ([guid]::NewGuid().ToString())
                        $supervised = & (Join-Path $PSScriptRoot 'windows-command-supervisor.ps1') `
                            -Operation $Operation -Source $context.source -Project $context.project -Control $context.control `
                            -Directory $directory -TemporaryDirectory $context.temporary -TaskName $context.taskName `
                            -Node $context.node -PowerShell $context.pwsh -Git $context.git -NpmCli $context.npmCli `
                            -ArgumentsJson $jsonArguments -PrepareDirectories -ReturnOutcome
                        $code = $supervised.Code
                        $result = $supervised.Result
                    }
                } finally {
                    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $nodeOptions, 'Process')
                    [Environment]::SetEnvironmentVariable('NODE_PATH', $nodePath, 'Process')
                }
            }
        }
    } catch {
        $code = 1
        $result = @{ status = 'failed'; code = 'DEPLOYMENT_WINDOWS_PUBLIC_COMMAND_FAILED'
            check = $stage
            message = 'Windows command failed; check controller prerequisites and retain deployment/recovery evidence.'
            diagnostics = @(@{ type = $_.Exception.GetType().FullName; line = $_.InvocationInfo.ScriptLineNumber }) }
    }
    if ($Options['Json']) {
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 12 -Compress))
    } else {
        $message = if ($result.PSObject.Properties['message'] -or $result -is [Collections.IDictionary] -and $result.Contains('message')) {
            $result.message
        } else { $result.status }
        [Console]::Out.WriteLine($message)
    }
    if ($code -ne 0) {
        [Console]::Error.WriteLine("$($result.message) ($($result.code))")
        if ($result -is [Collections.IDictionary] -and $result.Contains('diagnostics')) {
            foreach ($diagnostic in $result.diagnostics) {
                [Console]::Error.WriteLine("Diagnostic: $stage $($diagnostic.type) line=$($diagnostic.line)")
            }
        }
    }
    return $code
}
