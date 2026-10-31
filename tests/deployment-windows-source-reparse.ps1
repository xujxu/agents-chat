param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Relative,
    [string]$Saved,
    [switch]$Decorate
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @(
    (Join-Path $source 'WindowsPrivateFile.cs'),
    (Join-Path $source 'WindowsPrivateFile.SourceSecurity.cs'),
    (Join-Path $source 'WindowsPrivateFile.SourceReparse.cs'))
$lease = if ($Saved) {
    $record = Get-Content -LiteralPath $Saved -Raw | ConvertFrom-Json
    $policy = [Security.AccessControl.RawSecurityDescriptor]::new($record.securityDescriptor)
    if ($Decorate) {
        $policy.DiscretionaryAcl.InsertAce($policy.DiscretionaryAcl.Count,
            [Security.AccessControl.CommonAce]::new(
                ([Security.AccessControl.AceFlags]::ObjectInherit -bor [Security.AccessControl.AceFlags]::ContainerInherit),
                [Security.AccessControl.AceQualifier]::AccessAllowed,
                [int][Security.AccessControl.FileSystemRights]::Read,
                [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), $false, $null))
        $record.attributes = $record.attributes -bor 1 -bor 2
    }
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
    $targetBefore = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, 'node_modules/dependency', 'directory')
    $fileBefore = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, 'node_modules/dependency/payload', 'file')
    $created = if ($record.kind -ceq 'junction') {
        [Deployment.WindowsPrivateFile]::CreateSourceJunction(
            $Project, $Relative, $record.data, $policy.GetSddlForm($sections), [uint32]$record.attributes)
    } else {
        [Deployment.WindowsPrivateFile]::CreateSourceDirectoryLink(
            $Project, $Relative, $record.data, $policy.GetSddlForm($sections), [uint32]$record.attributes)
    }
    try {
        $targetAfter = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, 'node_modules/dependency', 'directory')
        $fileAfter = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, 'node_modules/dependency/payload', 'file')
        if ($targetBefore.SecurityDescriptor -cne $targetAfter.SecurityDescriptor -or
            $fileBefore.SecurityDescriptor -cne $fileAfter.SecurityDescriptor) {
            throw 'Junction restoration propagated ACLs into its target.'
        }
        $created
    } catch { $created.Dispose(); throw }
} else { [Deployment.WindowsPrivateFile]::OpenSourceReparse($Project, $Relative) }
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
