param(
    [Parameter(Mandatory)][ValidateSet('deploy', 'update')][string]$Operation,
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$Directory,
    [Parameter(Mandatory)][string]$TemporaryDirectory,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$PowerShell,
    [Parameter(Mandatory)][string]$Git,
    [Parameter(Mandatory)][string]$NpmCli,
    [Parameter(Mandatory)][string]$ArgumentsJson
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$capture = $null
$temporary = $null
$failure = $null
$outcome = $null
$stage = 'arguments'

function Invoke-OriginalCapturedProcess([string[]]$Arguments, [string]$Phase) {
    $actor = $null
    $originalFailure = $null
    try {
        $script:stage = "$Phase-start"
        $capture.Check()
        $temporary.Check()
        $actor = [Deployment.WindowsControllerProcess]::Start($Node, $Arguments, $capture.Directory, $environment)
        $actor.StandardInput.Close()
        $output = $actor.StandardOutput.ReadToEndAsync()
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $script:stage = "$Phase-wait"
        while (-not $actor.WaitForExit(30000)) {
            $capture.Check()
            $temporary.Check()
        }
        $code = $actor.ExitCode
        $script:stage = "$Phase-settle"
        $actor.Kill()
        if (-not $output.Wait(15000) -or -not $diagnostic.Wait(15000)) {
            throw 'Original controller streams did not settle.'
        }
        [Console]::Error.Write($diagnostic.GetAwaiter().GetResult())
        $text = $output.GetAwaiter().GetResult()
        $actor.Dispose()
        $actor = $null
        $capture.Check()
        $script:stage = "$Phase-result"
        if ($text.Length -gt 32768 -or $code -notin @(0, 1)) {
            throw 'Original controller returned an unsupported outcome.'
        }
        try { $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop }
        catch { throw 'Original controller result was not one JSON object.' }
        if ($value -isnot [pscustomobject]) { throw 'Original controller result was not an object.' }
        return @{ Code = $code; Value = $value }
    } catch {
        $originalFailure = $_.Exception
        throw
    } finally {
        if ($actor) {
            try { $actor.Dispose() }
            catch {
                if ($originalFailure) { throw [AggregateException]::new($originalFailure, $_.Exception) }
                throw
            }
        }
    }
}

try {
    if ($ArgumentsJson.Length -gt 16384) { throw 'Command arguments exceed their bound.' }
    $arguments = ConvertFrom-Json -InputObject $ArgumentsJson -NoEnumerate
    if ($arguments -isnot [array] -or $arguments.Count -gt 64) { throw 'Command arguments must be a bounded array.' }
    foreach ($argument in $arguments) {
        if ($argument -isnot [string] -or $argument -match '[\x00\r\n]') { throw 'Invalid command argument.' }
    }
    $stage = 'native-tools'
    Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs',
        'WindowsControllerProcess.cs', 'WindowsControllerCapture.cs' | ForEach-Object { Join-Path $PSScriptRoot $_ })
    $stage = 'capture'
    $temporary = [Deployment.WindowsPrivateFile]::OpenDirectory($TemporaryDirectory)
    $capture = [Deployment.WindowsControllerCapture]::Create($Source, $Project, $Directory)
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $environment.Add('TEMP', $TemporaryDirectory)
    $environment.Add('TMP', $TemporaryDirectory)
    $entry = Join-Path $capture.Directory 'scripts/deployment/windows-command-entry.mjs'
    $outcome = Invoke-OriginalCapturedProcess -Arguments (@($entry, $Operation, $Project, $Control,
        $TaskName, $PowerShell, $Git, $NpmCli) + [string[]]$arguments) -Phase 'command'
    $result = $outcome.Value
    if ($result.closeoutRequired -isnot [bool] -or
        ($outcome.Code -eq 0 -and $result.status -cnotin @('accepted', 'already-current')) -or
        ($outcome.Code -eq 1 -and $result.status -cne 'failed') -or
        ($result.status -ceq 'accepted' -and -not $result.closeoutRequired) -or
        ($result.status -ceq 'already-current' -and $result.closeoutRequired)) {
        throw 'Command result does not match its original exit status.'
    }
    if ($result.closeoutRequired) {
        if ($result.operationId -isnot [string] -or
            $result.operationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
            $result.recoveryEngine -isnot [string] -or $result.recoveryEngine -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Command closeout requires its exact original operation and saved recovery binding.'
        }
        $phase = if ($outcome.Code -eq 0) { 'accepted' } else { 'prior-runtime-restored' }
        $finalizer = Join-Path $capture.Directory 'scripts/deployment/windows-command-finalize-entry.mjs'
        $closed = Invoke-OriginalCapturedProcess -Arguments @($finalizer, $Control, $Project,
            $result.operationId, $result.recoveryEngine, $PowerShell, $phase) -Phase 'closeout'
        if ($closed.Code -ne 0 -or $closed.Value.status -cne 'completed' -or
            $closed.Value.operationId -cne $result.operationId -or $closed.Value.phase -cne $phase) {
            throw 'Saved finalizer did not confirm the original command closeout.'
        }
        $result.closeoutRequired = $false
        $result | Add-Member -NotePropertyName closeoutStatus -NotePropertyValue 'completed'
    }
    $stage = 'capture-check'
    $capture.Check()
    $temporary.Check()
    if ($outcome.Code -eq 0) {
        $stage = 'capture-retire'
        $capture.Retire()
    }
} catch {
    $failure = $_
} finally {
    foreach ($resource in @($capture, $temporary)) {
        if ($resource) {
            try { $resource.Dispose() }
            catch {
                if (-not $failure) { $failure = $_; $stage = 'capture-close' }
                else { [Console]::Error.WriteLine('Additional private supervisor cleanup failed; retain controller and operation evidence.') }
            }
        }
    }
}

if ($failure) {
    $code = 'DEPLOYMENT_WINDOWS_SUPERVISOR_FAILED'
    $details = @{
        status = 'failed'; code = $code; check = $stage
        message = 'Private Windows supervisor failed; retain controller, runtime and recovery evidence.'
        closeoutRequired = $false; operationId = $null; recoveryEngine = $null
        diagnostics = @(@{
            type = $failure.Exception.GetType().FullName
            line = $failure.InvocationInfo.ScriptLineNumber
        })
    }
    [Console]::Out.WriteLine(($details | ConvertTo-Json -Depth 5 -Compress))
    [Console]::Error.WriteLine("$code ($stage)")
    exit 1
}
[Console]::Out.WriteLine(($outcome.Value | ConvertTo-Json -Depth 8 -Compress))
exit $outcome.Code
