param([Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Relative)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @(
    (Join-Path $source 'WindowsPrivateFile.cs'),
    (Join-Path $source 'WindowsPrivateFile.SourceSecurity.cs'),
    (Join-Path $source 'WindowsPrivateFile.SourceReparse.cs'))
$lease = [Deployment.WindowsPrivateFile]::OpenSourceReparse($Project, $Relative)
try {
    $lease.Check()
    $metadata = $lease.Metadata
    [Console]::Out.WriteLine((@{
        kind=$lease.Kind; target=$lease.RelativeTarget; data=$lease.ReparseData
        attributes=$metadata.Attributes; securityDescriptor=$metadata.SecurityDescriptor
        dev=$metadata.Dev; ino=$metadata.Ino
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -cne 'check') { throw 'Expected original retained reparse check.' }
    $lease.Check()
} finally { $lease.Dispose() }
