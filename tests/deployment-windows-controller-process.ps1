$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$source = Join-Path $PSScriptRoot '../scripts/deployment'
$nativeSources = @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs', 'WindowsControllerProcess.cs')
Add-Type -Path @($nativeSources | ForEach-Object { Join-Path $source $_ })
$node = (Get-Command node).Source
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize native controller fixture'
$root = Join-Path $parent "agents-controller-$([guid]::NewGuid()) space"
$cleanupRoot = $root
$controller = $null
$directory = [Deployment.WindowsPrivateFile]::CreateDirectory($root)
$directory.Dispose()
try {
    @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
console.log(JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: root }));
require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if (message.method === 'echo') {
    fs.writeFileSync(path.join(root, 'private.json'), JSON.stringify(message));
    console.log(JSON.stringify({ text: message.text }));
  } else {
    const child = require('node:child_process').spawn(process.execPath, [path.join(root, 'writer.cjs')],
      { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(root, 'marker'))) {
      if (Date.now() > deadline) throw new Error('Detached writer did not start');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    process.exit(0);
  }
});
'@ | Set-Content -LiteralPath (Join-Path $root 'controller.cjs')
    @'
const fs = require('node:fs');
fs.appendFileSync('marker', 'x');
setInterval(() => fs.appendFileSync('marker', 'x'), 25);
'@ | Set-Content -LiteralPath (Join-Path $root 'writer.cjs')
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $environment.Add('TEMP', $root)
    $environment.Add('TMP', $root)
    $literal = @('', 'a"b', 'tail\', 'space %n $HOME', 'two\\\"three')
    $controller = [Deployment.WindowsControllerProcess]::Start($node,
        (@((Join-Path $root 'controller.cjs')) + $literal), $root, $environment)
    $diagnostic = $controller.StandardError.ReadToEndAsync()
    function Receive-Frame {
        $read = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($controller.StandardOutput, 4096)
        Assert ($read.Wait(15000)) 'Production controller did not reply'
        return $read.GetAwaiter().GetResult() | ConvertFrom-Json
    }
    $hello = Receive-Frame
    Assert ($hello.pid -eq $controller.Id -and $hello.cwd -ceq $root -and
        ($hello.args | ConvertTo-Json -Compress) -ceq ($literal | ConvertTo-Json -Compress)) `
        'Production controller changed literal arguments, cwd or original PID'
    $message = '" %n $HOME \'
    $controller.StandardInput.WriteLine((@{ method='echo'; text=$message } | ConvertTo-Json -Compress))
    Assert ((Receive-Frame).text -ceq $message) 'Production controller stdio changed a literal frame'
    $file = Join-Path $root 'private.json'
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $private = [Deployment.WindowsPrivateFile]::Open($file, $hash)
    try { Assert (($private.ReadText() | ConvertFrom-Json).text -ceq $message) 'Production child file is not private and exact' }
    finally { $private.Dispose() }
    $moved = "$root-moved"
    $denied = $false
    try { [IO.Directory]::Move($root, $moved); $cleanupRoot = $moved }
    catch { $denied = ($_.Exception.GetBaseException().HResult -band 0xffff) -in @(5, 32) }
    Assert $denied 'Production controller did not retain its private working directory'
    $controller.StandardInput.WriteLine('{"method":"spawn-exit"}')
    Assert ($controller.WaitForExit(15000) -and $controller.ExitCode -eq 0) 'Production controller root did not exit'
    $marker = Join-Path $root 'marker'
    $before = (Get-Item -LiteralPath $marker).Length
    Start-Sleep -Milliseconds 200
    Assert ((Get-Item -LiteralPath $marker).Length -gt $before) 'Detached writer did not survive root exit'
    $controller.Kill()
    $after = (Get-Item -LiteralPath $marker).Length
    Start-Sleep -Milliseconds 200
    Assert ((Get-Item -LiteralPath $marker).Length -eq $after) 'Original controller Job still has a writer after stop'
    Assert ($diagnostic.Wait(15000)) 'Controller diagnostic pipe did not close after Job settlement'
    Assert ([string]::IsNullOrEmpty($diagnostic.GetAwaiter().GetResult())) 'Unexpected production controller diagnostics'
    $controller.Dispose()
    $controller = $null
    [IO.Directory]::Move($root, $moved)
    $cleanupRoot = $moved
    Write-Output 'PASS: production controller preserves literal stdio/private ownership, retains cwd and settles detached writers after root exit'
} finally {
    if ($controller) { $controller.Dispose() }
    Remove-Item -LiteralPath $cleanupRoot -Recurse -Force
}
