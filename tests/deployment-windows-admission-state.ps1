$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs',
    'WindowsControllerProcess.cs' | ForEach-Object { Join-Path $source $_ })
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$node = & node -p "require('node:fs').realpathSync.native(process.execPath)"
if ($LASTEXITCODE -ne 0) { throw 'Cannot canonicalize ownership fixture Node executable.' }
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
if ($LASTEXITCODE -ne 0) { throw 'Cannot canonicalize ownership fixture parent.' }
$root = Join-Path $parent "agents-admission-state-$([guid]::NewGuid())"
$control = Join-Path $root 'control'
$project = Join-Path $root 'project'
$controller = $null
try {
    foreach ($directory in @($root, $control, $project)) {
        $created = [Deployment.WindowsPrivateFile]::CreateDirectory($directory)
        try { $created.Check() } finally { $created.Dispose() }
    }
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $environment.Add('TEMP', $root)
    $environment.Add('TMP', $root)
    $environment.Add('PATH', (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0'))
    $controller = [Deployment.WindowsControllerProcess]::Start($node,
        @((Join-Path $PSScriptRoot 'deployment-windows-admission-state.mjs'), $control, $project, $pwsh),
        $root, $environment)
    $output = $controller.StandardOutput.ReadToEndAsync()
    $diagnostic = $controller.StandardError.ReadToEndAsync()
    Write-Output 'PASS: ownership entrypoint fixture uses an original private Node controller and private control directories'
    if (-not $controller.WaitForExit(180000)) { throw 'Ownership fixture timed out.' }
    $code = $controller.ExitCode
    $controller.Kill()
    if (-not $output.Wait(15000) -or -not $diagnostic.Wait(15000)) { throw 'Ownership fixture streams did not close.' }
    [Console]::Out.Write($output.GetAwaiter().GetResult())
    [Console]::Error.Write($diagnostic.GetAwaiter().GetResult())
    if ($code -ne 0) { throw 'Windows ownership entrypoint admission failed.' }
} finally {
    if ($controller) { $controller.Dispose() }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
