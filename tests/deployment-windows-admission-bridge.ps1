$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot '../scripts/deployment/WindowsPrivateFile.cs')
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$parent = & node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve native admission fixture parent.' }
$control = Join-Path $parent "agents-admission-bridge-$([guid]::NewGuid())"
$other = "$control-other"
try {
    foreach ($directory in @($control, $other, (Join-Path $control 'lock'))) {
        $created = [Deployment.WindowsPrivateFile]::CreateDirectory($directory)
        try { $created.Check() } finally { $created.Dispose() }
    }
    $ownerPath = Join-Path $control 'lock/owner.json'
    $record = [ordered]@{
        version=1; token=[guid]::NewGuid().ToString('D'); project=$other; operationId=[guid]::NewGuid().ToString('D')
        pid=$PID; processIdentity="$PID`:$([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks)"
        createdAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    }
    $owner = [Deployment.WindowsPrivateFile]::Publish($ownerPath, ($record | ConvertTo-Json -Compress))
    try { $before = $owner.Sha256 } finally { $owner.Dispose() }
    Write-Output 'PASS: native bridge fixture has private control directories and original evidence'
    & node (Join-Path $PSScriptRoot 'deployment-windows-admission-bridge.mjs') suite $control $other $pwsh
    if ($LASTEXITCODE -ne 0) { throw 'Native admission bridge fixture failed.' }
    if ((Get-FileHash -LiteralPath $ownerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before) {
        throw 'Admission bridge changed original operation evidence.'
    }
    if ((Get-Item -LiteralPath (Join-Path $control 'windows-admission.lock')).Length -ne 0) {
        throw 'Admission bridge changed the persistent empty gate.'
    }
    Write-Output 'PASS: bridge close and original-controller loss preserve durable operation evidence'
} finally {
    foreach ($directory in @($control, $other)) {
        if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
    }
}
