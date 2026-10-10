$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$update = Join-Path $repository 'scripts/update.ps1'
Assert (Test-Path -LiteralPath $update -PathType Leaf) 'Missing public Windows update entry'
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$root = Join-Path ([IO.Path]::GetTempPath()) "agents-public-$([guid]::NewGuid()) space"
$missing = Join-Path $root 'absent'
try {
    foreach ($operation in @('deploy', 'update')) {
        $entry = Join-Path $repository "scripts/$operation.ps1"
        $text = & $pwsh -NoProfile -NonInteractive -File $entry -Help -Json -ProjectDir $missing
        Assert ($LASTEXITCODE -eq 0) "$operation public help failed"
        $result = ($text -join "`n") | ConvertFrom-Json
        Assert ($result.status -ceq 'help' -and $result.message.Contains('-Revision')) 'Public help is incomplete'
        Assert (-not (Test-Path -LiteralPath $root)) 'Public help created installation files'
        foreach ($flag in @('-NoWait', '-Verify', '-DryRun', '-RemoveTask', '-NoTunnel')) {
            $text = & $pwsh -NoProfile -NonInteractive -File $entry -ProjectDir $missing -Json $flag
            Assert ($LASTEXITCODE -eq 1) "Public $flag must fail before access to an absent project"
            $result = ($text -join "`n") | ConvertFrom-Json
            Assert ($result.code -ceq 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED') "Public $flag was not explicitly refused"
            Assert (-not (Test-Path -LiteralPath $root)) 'Unsupported public mode created files'
        }
    }
    New-Item -ItemType Directory -Path $root | Out-Null
    $project = Join-Path $root 'project'
    New-Item -ItemType Directory -Path $project | Out-Null
    $nodeOptions = $env:NODE_OPTIONS
    $nodePath = $env:NODE_PATH
    $originalPath = $env:PATH
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $shadow = Join-Path $root 'shadow-tools'
    New-Item -ItemType Directory -Path $shadow | Out-Null
    [IO.File]::WriteAllText((Join-Path $shadow 'node.exe'), 'This later PATH entry must never execute.')
    try {
        $env:NODE_OPTIONS = '--require=agents-public-must-not-load'
        $env:NODE_PATH = Join-Path $root 'must-not-load'
        $env:PATH = "$(Split-Path -Parent $node);$shadow;$originalPath"
        Assert (@(Get-Command node.exe -CommandType Application).Count -gt 1) 'Fixture requires multiple Node tool candidates'
        $text = & $pwsh -NoProfile -NonInteractive -File $update -ProjectDir $project -Status -Json
        $statusCode = $LASTEXITCODE
    } finally {
        $env:NODE_OPTIONS = $nodeOptions
        $env:NODE_PATH = $nodePath
        $env:PATH = $originalPath
    }
    Assert ($statusCode -eq 0) "Read-only public status failed or inherited Node hooks: $($text -join '`n')"
    $result = ($text -join "`n") | ConvertFrom-Json
    Assert ($result.status -ceq 'unmanaged' -and $null -eq $result.phase) 'Fresh public status was not unmanaged'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root '.project.deployment'))) 'Status created control files'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root '.project.deployment-controllers'))) 'Status captured controller files'
    Assert (@(Get-ChildItem -LiteralPath $project -Force).Count -eq 0) 'Status changed project files'
    $text = & $pwsh -NoProfile -NonInteractive -File $update -ProjectDir $project -Revision invalid -Json
    Assert ($LASTEXITCODE -eq 1) 'Invalid revision was not refused'
    $result = ($text -join "`n") | ConvertFrom-Json
    Assert ($result.status -ceq 'failed') 'Invalid revision returned success'
    Assert (@(Get-ChildItem -LiteralPath $root -Force).Count -eq 2) 'Invalid revision created control/capture files'
    Write-Output 'PASS: public Windows help, unsupported modes and status have no deployment side effects'
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
