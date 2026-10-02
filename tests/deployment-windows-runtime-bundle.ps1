$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/deployment'))
. (Join-Path $source 'windows-runtime-bundle.ps1')
$helpers = @('WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
    'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsRuntimeHost.cs',
    'windows-worker-launcher.ps1', 'windows-runtime-host.ps1')
Add-Type -Path @($helpers | Where-Object { $_.EndsWith('.cs') } | ForEach-Object { Join-Path $source $_ })
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$node = (Get-Command node).Source
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize bundle fixture'
$root = Join-Path $parent "agents-runtime-bundle-$([guid]::NewGuid()) space"
$rootLease = [Deployment.WindowsPrivateFile]::CreateDirectory($root)
try {
    $project = Join-Path $root 'project'
    [Deployment.WindowsPrivateFile]::CreateDirectory($project).Dispose()
    $directory = Join-Path $root 'bundle'
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $environment.Add('LITERAL', '" %n $HOME \')
    $arguments = @('', 'literal %n $HOME " space', 'tail\')
    $originalSecurity = @{}
    foreach ($name in $helpers) { $originalSecurity[$name] = (Get-Acl -LiteralPath (Join-Path $source $name)).Sddl }
    $bundle = New-AgentsChatRuntimeBundle -Source $source -Directory $directory -File $node `
        -Arguments $arguments -WorkingDirectory $project -Environment $environment
    Assert ($bundle.Directory -ceq $directory -and $bundle.Configuration -ceq (Join-Path $directory 'configuration.json')) `
        'Published runtime paths differ'
    $retained = [Deployment.WindowsPrivateFile]::Open($bundle.Configuration, $bundle.Sha256)
    try { $configuration = $retained.ReadText() | ConvertFrom-Json }
    finally { $retained.Dispose() }
    Assert ($configuration.version -eq 1 -and $configuration.command.file -ceq $node -and
        $configuration.command.cwd -ceq $project -and $configuration.command.environment.LITERAL -ceq $environment['LITERAL'] -and
        ($configuration.command.args | ConvertTo-Json -Compress) -ceq ($arguments | ConvertTo-Json -Compress)) `
        'Runtime publication changed the literal command'
    Assert (@(Get-ChildItem -LiteralPath $directory).Count -eq $helpers.Count + 1 -and
        @($configuration.helpers.PSObject.Properties).Count -eq $helpers.Count) 'Unexpected runtime bundle inventory'
    $candidate = [Deployment.WindowsRuntimeHost]::Open($bundle.Configuration, $bundle.Sha256, $directory)
    try {
        $candidate.Check()
        foreach ($file in @($bundle.Configuration, (Join-Path $directory $helpers[0]))) {
            $refused = $false
            try { [IO.File]::WriteAllText($file, 'changed') }
            catch { $refused = ($_.Exception.GetBaseException().HResult -band 0xffff) -eq 32 }
            Assert $refused 'Candidate admission did not retain its configuration and helpers'
        }
        Assert (@(Get-ChildItem -LiteralPath $directory -Filter 'runtime-*.json').Count -eq 0) `
            'Read-only candidate admission started a runtime'
    } finally { $candidate.Dispose() }
    $lease = [Deployment.WindowsPrivateFile]::OpenDirectory($directory)
    try { $lease.Check() }
    finally { $lease.Dispose() }
    foreach ($name in $helpers) {
        $original = Join-Path $source $name
        $hash = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert ($configuration.helpers.$name -ceq $hash -and (Get-Acl -LiteralPath $original).Sddl -ceq $originalSecurity[$name]) `
            'Publication changed source bytes or permissions'
        $retained = [Deployment.WindowsPrivateFile]::Open((Join-Path $directory $name), $hash)
        try { $retained.Check() }
        finally { $retained.Dispose() }
    }
    $collision = $false
    try {
        New-AgentsChatRuntimeBundle -Source $source -Directory $directory -File $node `
            -Arguments $arguments -WorkingDirectory $project -Environment $environment | Out-Null
    } catch { $collision = $true }
    Assert ($collision -and (Get-FileHash -LiteralPath $bundle.Configuration -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $bundle.Sha256) `
        'Runtime publication adopted or overwrote an existing bundle'
    $refusedPath = Join-Path $root 'invalid-command'
    $refused = $false
    try {
        New-AgentsChatRuntimeBundle -Source $source -Directory $refusedPath -File 'relative.exe' `
            -Arguments @() -WorkingDirectory $project -Environment $environment | Out-Null
    } catch { $refused = $true }
    Assert ($refused -and -not (Test-Path -LiteralPath $refusedPath)) 'Invalid command created a runtime bundle'
    $copy = Join-Path $root 'wrong-digest.cs'
    $refused = $false
    try { [Deployment.WindowsPrivateFile]::CopyTrustedSource((Join-Path $source $helpers[0]), ('0' * 64), $copy).Dispose() }
    catch { $refused = $_.Exception.GetBaseException().Message -ceq 'Private configuration digest differs.' }
    Assert ($refused -and -not (Test-Path -LiteralPath $copy)) 'Wrong source digest published executable code'
    $hardlink = Join-Path $root 'hardlink.cs'
    $original = Join-Path $root 'original.cs'
    [IO.File]::WriteAllBytes($original, ([byte[]]@(239, 187, 191) + [Text.Encoding]::UTF8.GetBytes("trusted source`r`n")))
    $sourceAcl = Get-Acl -LiteralPath $original
    $sourceAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $original -AclObject $sourceAcl
    $sourceSecurity = (Get-Acl -LiteralPath $original).Sddl
    $sourceHash = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourceCopy = [Deployment.WindowsPrivateFile]::CopyTrustedSource($original, $sourceHash, (Join-Path $root 'copied.cs'))
    try { Assert ($sourceCopy.Sha256 -ceq $sourceHash) 'Trusted UTF-8 copy changed BOM or line endings' }
    finally { $sourceCopy.Dispose() }
    Assert ((Get-Acl -LiteralPath $original).Sddl -ceq $sourceSecurity) 'Trusted copy repaired source permissions'
    $refused = $false
    try { [Deployment.WindowsPrivateFile]::Open($original, $sourceHash).Dispose() }
    catch { $refused = $_.Exception.GetBaseException().Message -ceq 'Private configuration permissions are unsupported.' }
    Assert $refused 'Trusted copy weakened ordinary private-file admission'
    New-Item -ItemType HardLink -Path $hardlink -Target $original | Out-Null
    $hash = (Get-FileHash -LiteralPath $hardlink -Algorithm SHA256).Hash.ToLowerInvariant()
    $refused = $false
    try { [Deployment.WindowsPrivateFile]::CopyTrustedSource($hardlink, $hash, $copy).Dispose() }
    catch { $refused = $_.Exception.GetBaseException().Message -ceq 'Private configuration file type or links are unsupported.' }
    Assert ($refused -and -not (Test-Path -LiteralPath $copy)) 'Linked source published executable code'
    Write-Output 'PASS: production runtime bundle is exact and natively private without ACL repair; invalid commands, collisions and changed or linked sources are refused'
} finally {
    $rootLease.Dispose()
    Remove-Item -LiteralPath $root -Recurse -Force
}
