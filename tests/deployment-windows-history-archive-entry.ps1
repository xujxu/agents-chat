param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$Name,
    [switch]$Restore
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $Source 'WindowsPrivateFile.cs')
$record = Get-Content -LiteralPath (Join-Path $Control 'inactive-rollback-history-intent.json') -Raw |
    ConvertFrom-Json -AsHashtable
$entries = @($record.entries | Where-Object { $_.path -ceq $Name })
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
