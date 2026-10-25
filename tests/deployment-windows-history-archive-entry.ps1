param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$Name,
    [switch]$Restore,
    [switch]$Intent,
    [string]$OperationId
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $Source 'WindowsPrivateFile.cs')
$intentPath = Join-Path $Control 'inactive-rollback-history-intent.json'
if ($Intent) {
    if ($Name -cne 'inactive-rollback-history-intent.json' -or
        ([guid]$OperationId).ToString('D') -cne $OperationId -or [guid]$OperationId -eq [guid]::Empty) {
        throw 'History intent fixture requires its exact original operation.'
    }
    if ($Restore) { $intentPath = Join-Path $Control "retired-$OperationId-$Name" }
}
$record = Get-Content -LiteralPath $intentPath -Raw |
    ConvertFrom-Json -AsHashtable
if ($Intent) {
    if ($record.operationId -cne $OperationId) { throw 'History intent fixture operation differs.' }
    $hash = (Get-FileHash -LiteralPath $intentPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $proof = [Deployment.WindowsPrivateFile]::Open($intentPath, $hash)
    try {
        $identity = $proof.CaptureIdentity()
        $entries = @(@{
            path=$Name; destination="retired-$OperationId-$Name"
            sha256=$hash; dev=$identity.Dev; ino=$identity.Ino; bytes=$proof.ByteLength
        })
    } finally { $proof.Dispose() }
} else { $entries = @($record.entries | Where-Object { $_.path -ceq $Name }) }
if ($entries.Count -ne 1 -or $Name -cnotmatch '^inactive-rollback-[a-z-]+\.json$' -or
    $record.control -cne $Control -or
    $entries[0].destination -cne "retired-$($record.operationId)-$Name") {
    throw 'History fixture requires one exact prepared native entry.'
}
$entry = $entries[0]
$original = Join-Path $Control $(if ($Restore) { $entry.destination } else { $entry.path })
$destination = Join-Path $Control $(if ($Restore) { $entry.path } else { $entry.destination })
$held = [Deployment.WindowsPrivateFile]::RetainForRetirement(
    $original, $entry.sha256, $entry.dev, $entry.ino, $entry.bytes)
try {
    $held.ArchiveTo($destination)
    $held.Check()
} finally { $held.Dispose() }
