param(
    [Parameter(Mandatory)][string[]]$Tests,
    [string]$NamePattern
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
$failure = $null
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
        if ($entry.Key -match '^(SystemRoot|PATH|ComSpec|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|CI|GITHUB_ACTIONS|DEPLOYMENT_TEST_[A-Z_]+)$') {
            $environment.Add([string]$entry.Key, [string]$entry.Value)
        }
    }
    $environment['TEMP'] = $root
    $environment['TMP'] = $root
    $environment['DEPLOYMENT_TEST_PWSH'] = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $controller = [Deployment.WindowsControllerProcess]::Start($node, $arguments.ToArray(), $root, $environment)
    $output = $controller.StandardOutput.ReadToEndAsync()
    $diagnostic = $controller.StandardError.ReadToEndAsync()
    if (-not $controller.WaitForExit(1800000)) { throw 'Private Windows tests timed out.' }
    $code = $controller.ExitCode
    $controller.Kill()
    if (-not $output.Wait(15000) -or -not $diagnostic.Wait(15000)) { throw 'Private test streams did not close.' }
    [Console]::Out.Write($output.GetAwaiter().GetResult())
    [Console]::Error.Write($diagnostic.GetAwaiter().GetResult())
    if ($code -ne 0) { throw "Private Windows tests failed with exit code $code." }
} catch {
    $failure = $_.Exception
    throw
} finally {
    if ($controller) {
        try { $controller.Dispose() }
        catch {
            if ($failure) { throw [AggregateException]::new($failure, $_.Exception) }
            throw
        }
    }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
