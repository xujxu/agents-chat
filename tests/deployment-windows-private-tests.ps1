param(
    [Parameter(Mandatory)][string[]]$Tests,
    [string]$NamePattern,
    [ValidateRange(1, 3000)][int]$TimeoutSeconds = 1800
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs',
    'WindowsControllerProcess.cs' | ForEach-Object { Join-Path $source $_ })
$node = & node -p "require('node:fs').realpathSync.native(process.execPath)"
if ($LASTEXITCODE -ne 0) { throw 'Cannot canonicalize private test Node executable.' }
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
if ($LASTEXITCODE -ne 0) { throw 'Cannot canonicalize private test parent.' }
$root = Join-Path $parent "agents-private-tests-$([guid]::NewGuid())"
$controller = $null
$failures = [Collections.Generic.List[Exception]]::new()
try {
    $created = [Deployment.WindowsPrivateFile]::CreateDirectory($root)
    try { $created.Check() } finally { $created.Dispose() }
    $arguments = [Collections.Generic.List[string]]::new()
    $arguments.Add('--test')
    if ($NamePattern) { $arguments.Add("--test-name-pattern=$NamePattern") }
    foreach ($test in $Tests) {
        $file = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../$test"))
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing test file: $test" }
        $arguments.Add($file)
    }
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        if ($entry.Key -match '^(SystemRoot|SystemDrive|WINDIR|PATH|PATHEXT|ComSpec|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|CI|GITHUB_ACTIONS|DEPLOYMENT_TEST_[A-Z_]+)$') {
            $environment.Add([string]$entry.Key, [string]$entry.Value)
        }
    }
    $environment['TEMP'] = $root
    $environment['TMP'] = $root
    $environment['DEPLOYMENT_TEST_PWSH'] = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $controller = [Deployment.WindowsControllerProcess]::Start($node, $arguments.ToArray(), $root, $environment)
    $output = $controller.StandardOutput.ReadToEndAsync()
    $diagnostic = $controller.StandardError.ReadToEndAsync()
    $exited = $controller.WaitForExit($TimeoutSeconds * 1000)
    $code = $null
    if ($exited) { $code = $controller.ExitCode }
    else { $failures.Add([TimeoutException]::new('Private Windows tests timed out.')) }
    $controller.Kill()
    if (-not $output.Wait(15000) -or -not $diagnostic.Wait(15000)) { throw 'Private test streams did not close.' }
    [Console]::Out.Write($output.GetAwaiter().GetResult())
    [Console]::Error.Write($diagnostic.GetAwaiter().GetResult())
    if ($exited -and $code -ne 0) { throw "Private Windows tests failed with exit code $code." }
} catch {
    $failures.Add($_.Exception)
} finally {
    if ($controller) {
        try { $controller.Dispose() }
        catch { $failures.Add($_.Exception) }
    }
    try {
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    }
    catch { $failures.Add($_.Exception) }
}
if ($failures.Count -eq 1) { throw $failures[0] }
if ($failures.Count -gt 1) { throw [AggregateException]::new('Private Windows tests and cleanup failed.', $failures.ToArray()) }
