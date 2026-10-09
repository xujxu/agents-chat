$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helpers = Join-Path $repository 'scripts/deployment'
$implementation = Join-Path $helpers 'WindowsControllerCapture.cs'
Assert (Test-Path -LiteralPath $implementation -PathType Leaf) 'Missing native external Windows controller capture'
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs',
    'WindowsControllerProcess.cs', 'WindowsControllerCapture.cs' | ForEach-Object { Join-Path $helpers $_ })
$node = & node -p "require('node:fs').realpathSync.native(process.execPath)"
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize capture Node'
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize capture parent'
$root = Join-Path $parent "agents-controller-capture-$([guid]::NewGuid()) space"
[Deployment.WindowsPrivateFile]::CreateDirectory($root).Dispose()
$capture = $null
$controller = $null
try {
    $source = Join-Path $root 'source'
    $project = Join-Path $root 'project'
    foreach ($directory in @($source, (Join-Path $source 'scripts'), (Join-Path $source 'scripts/deployment'),
        (Join-Path $source 'lib'), (Join-Path $source 'lib/workflow'), $project)) {
        [Deployment.WindowsPrivateFile]::CreateDirectory($directory).Dispose()
    }
    foreach ($file in Get-ChildItem -LiteralPath $helpers -File) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $source "scripts/deployment/$($file.Name)")
    }
    Copy-Item -LiteralPath (Join-Path $repository 'lib/workflow/workflowSchema.mjs') `
        -Destination (Join-Path $source 'lib/workflow/workflowSchema.mjs')
    $destination = Join-Path $root 'captured'
    $refused = $false
    try { [Deployment.WindowsControllerCapture]::Create($source, $project, (Join-Path $project 'inside')).Dispose() }
    catch { $refused = $true }
    Assert $refused 'Controller capture accepted a destination inside mutable project'
    Assert (-not (Test-Path -LiteralPath (Join-Path $project 'inside'))) 'Rejected destination was created'
    $capture = [Deployment.WindowsControllerCapture]::Create($source, $project, $destination)
    $capture.Check()
    $original = Join-Path $source 'scripts/deployment/source-command.mjs'
    $saved = Join-Path $destination 'scripts/deployment/source-command.mjs'
    $digest = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash
    Assert ((Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash -ceq $digest) 'Controller helper bytes changed'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $destination 'scripts/deployment') -File).Count -eq
        @(Get-ChildItem -LiteralPath (Join-Path $source 'scripts/deployment') -File).Count) 'Controller dependency inventory is incomplete'
    [IO.File]::WriteAllText($original, 'throw new Error("source was replaced");')
    $capture.Check()
    Assert ((Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash -ceq $digest) 'Captured controller followed mutable source'
    $refused = $false
    try { [IO.File]::WriteAllText($saved, 'changed') } catch { $refused = $true }
    Assert $refused 'Retained controller helper permitted mutation'
    $refused = $false
    try { [Deployment.WindowsControllerCapture]::Create($source, $project, $destination).Dispose() }
    catch { $refused = $true }
    Assert $refused 'Controller capture overwrote an existing destination'
    $extra = Join-Path $destination 'unexpected'
    [IO.File]::WriteAllText($extra, 'unrelated')
    $refused = $false
    try { $capture.Check() } catch { $refused = $true }
    Assert $refused 'Controller capture ignored an unexpected file'
    [IO.File]::Delete($extra)
    $capture.Check()

    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $script = @'
const { pathToFileURL } = await import('node:url');
await import(pathToFileURL(process.cwd() + '/scripts/deployment/source-command.mjs'));
await import(pathToFileURL(process.cwd() + '/lib/workflow/workflowSchema.mjs'));
process.stdout.write('captured-dependencies-loaded');
'@
    $controller = [Deployment.WindowsControllerProcess]::Start($node,
        @('--input-type=module', '-e', $script), $destination, $environment)
    $output = $controller.StandardOutput.ReadToEndAsync()
    $diagnostic = $controller.StandardError.ReadToEndAsync()
    Assert ($controller.WaitForExit(30000) -and $controller.ExitCode -eq 0) 'Captured controller dependency load failed'
    $controller.Kill()
    Assert ($output.Wait(15000) -and $diagnostic.Wait(15000)) 'Captured controller streams did not settle'
    Assert ($output.GetAwaiter().GetResult() -ceq 'captured-dependencies-loaded') 'Captured controller output differs'
    Assert ([string]::IsNullOrEmpty($diagnostic.GetAwaiter().GetResult())) 'Captured controller emitted unexpected diagnostics'
    $controller.Dispose()
    $controller = $null
    $capture.Check()
    $capture.Dispose()
    $capture = $null
    $private = [Deployment.WindowsPrivateFile]::Open($saved, $digest.ToLowerInvariant())
    $private.Dispose()

    $unsupported = Join-Path $source 'scripts/deployment/unsupported.txt'
    [IO.File]::WriteAllText($unsupported, 'unsupported')
    $refused = $false
    try { [Deployment.WindowsControllerCapture]::Create($source, $project, (Join-Path $root 'invalid')).Dispose() }
    catch { $refused = $true }
    Assert ($refused -and -not (Test-Path -LiteralPath (Join-Path $root 'invalid'))) 'Unsupported inventory created a capture'
    [IO.File]::Delete($unsupported)
    $linked = Join-Path $source 'scripts/deployment/linked.mjs'
    New-Item -ItemType HardLink -Path $linked -Target $original | Out-Null
    $refused = $false
    try { [Deployment.WindowsControllerCapture]::Create($source, $project, (Join-Path $root 'linked')).Dispose() }
    catch { $refused = $true }
    Assert $refused 'Controller capture accepted hardlinked source'
    Assert ((Get-Item -LiteralPath $original).Length -gt 0) 'Capture refusal removed original source'
    Write-Output 'PASS: private external controller captures complete dependencies, survives source replacement and refuses mutation or overwrite'
} finally {
    if ($controller) { $controller.Dispose() }
    if ($capture) { $capture.Dispose() }
    Remove-Item -LiteralPath $root -Recurse -Force
}
