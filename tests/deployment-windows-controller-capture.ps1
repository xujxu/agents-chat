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

    Assert ($null -ne [Deployment.WindowsControllerCapture].GetMethod('Retire')) 'Missing original controller capture retirement'
    $retiring = Join-Path $root 'retiring-capture'
    $capture = [Deployment.WindowsControllerCapture]::Create($source, $project, $retiring)
    $unexpected = Join-Path $retiring 'unexpected'
    [IO.File]::WriteAllText($unexpected, 'retain this unrelated file')
    $refused = $false
    try { $capture.Retire() } catch { $refused = $true }
    Assert ($refused -and (Test-Path -LiteralPath (Join-Path $retiring 'lib/workflow/workflowSchema.mjs'))) `
        'Unexpected capture content was silently removed'
    Assert ([IO.File]::ReadAllText($unexpected) -ceq 'retain this unrelated file') 'Capture retirement removed unrelated content'
    [IO.File]::Delete($unexpected)
    $capture.Check()
    $capture.Retire()
    $capture.Dispose()
    $capture = $null
    Assert (-not (Test-Path -LiteralPath $retiring)) 'Completed capture was not retired'
    Assert ((Test-Path -LiteralPath $source) -and (Test-Path -LiteralPath $project) -and
        (Test-Path -LiteralPath $saved)) 'Capture retirement changed source, project or another capture'

    $held = Join-Path $root 'held-capture'
    $capture = [Deployment.WindowsControllerCapture]::Create($source, $project, $held)
    $controller = [Deployment.WindowsControllerProcess]::Start($node,
        @('-e', "process.stdout.write('held\n');setInterval(()=>{},1000)"), $held, $environment)
    $ready = $controller.StandardOutput.ReadLineAsync()
    Assert ($ready.Wait(15000) -and $ready.GetAwaiter().GetResult() -ceq 'held') 'Original capture holder did not start'
    $refused = $false
    try { $capture.Retire() } catch { $refused = $true }
    Assert $refused 'Capture retirement ignored an original actor CWD lease'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $held 'scripts/deployment') -File).Count -eq
        @(Get-ChildItem -LiteralPath (Join-Path $source 'scripts/deployment') -File).Count) `
        'Capture retirement deleted files before confirming original actor handles closed'
    Assert (Test-Path -LiteralPath (Join-Path $held 'lib/workflow/workflowSchema.mjs')) 'Active capture lost its schema'
    $controller.Kill()
    Assert ($controller.WaitForExit(15000)) 'Original capture holder did not settle'
    $controller.Dispose()
    $controller = $null
    $capture.Dispose()
    $capture = $null

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
    [IO.File]::Delete($linked)
    $helperDirectory = Join-Path $source 'scripts/deployment'
    $count = @(Get-ChildItem -LiteralPath $helperDirectory -File).Count
    Assert ($count -le 512) 'Repository helper count exceeds the explicit capture budget'
    for ($index = $count; $index -lt 512; $index++) {
        [IO.File]::WriteAllText((Join-Path $helperDirectory "padding-$index.mjs"), '')
    }
    $bounded = Join-Path $root 'bounded-capture'
    $capture = [Deployment.WindowsControllerCapture]::Create($source, $project, $bounded)
    $capture.Check()
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $bounded 'scripts/deployment') -File).Count -eq 512) `
        'Controller capture did not admit the exact helper-count boundary'
    $capture.Retire()
    $capture = $null
    $overflow = Join-Path $helperDirectory 'overflow.mjs'
    [IO.File]::WriteAllText($overflow, '')
    $refused = $false
    $rejected = Join-Path $root 'overflow-capture'
    try { [Deployment.WindowsControllerCapture]::Create($source, $project, $rejected).Dispose() }
    catch {
        if ($_.Exception.ToString() -cnotmatch 'inventory exceeds its bound') { throw }
        $refused = $true
    }
    Assert ($refused -and -not (Test-Path -LiteralPath $rejected)) 'Excess helper inventory created a capture'
    [IO.File]::Delete($overflow)
    [IO.File]::WriteAllBytes($original, [byte[]]::new(1048577))
    $refused = $false
    try { [Deployment.WindowsControllerCapture]::Create($source, $project, (Join-Path $root 'oversize-capture')).Dispose() }
    catch {
        if ($_.Exception.ToString() -cnotmatch 'byte budget') { throw }
        $refused = $true
    }
    Assert $refused 'Increased helper count removed the per-file byte limit'
    [IO.File]::WriteAllBytes($original, [byte[]]::new(1048576))
    foreach ($file in Get-ChildItem -LiteralPath $helperDirectory -File |
        Where-Object FullName -ine $original | Select-Object -First 15) {
        [IO.File]::WriteAllBytes($file.FullName, [byte[]]::new(1048576))
    }
    $refused = $false
    try { [Deployment.WindowsControllerCapture]::Create($source, $project, (Join-Path $root 'total-oversize-capture')).Dispose() }
    catch {
        if ($_.Exception.ToString() -cnotmatch 'byte budget') { throw }
        $refused = $true
    }
    Assert $refused 'Increased helper count removed the total byte limit'
    Write-Output 'PASS: private external controller captures immutable dependencies and retires only original captures after actor handles close'
} finally {
    if ($controller) { $controller.Dispose() }
    if ($capture) { $capture.Dispose() }
    Remove-Item -LiteralPath $root -Recurse -Force
}
