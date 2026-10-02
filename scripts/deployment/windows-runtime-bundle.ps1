function New-AgentsChatRuntimeBundle {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.Dictionary[string,string]]$Environment
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $frame = [Deployment.WindowsRuntimeDomain]::CommandFrame($File, $Arguments, $WorkingDirectory, $Environment) |
        ConvertFrom-Json -AsHashtable
    if (-not [IO.Path]::IsPathFullyQualified($Source) -or [IO.Path]::GetFullPath($Source) -ine $Source) {
        throw 'A canonical trusted runtime source directory is required.'
    }
    $helpers = [Deployment.WindowsRuntimeHost]::HelperFiles
    $hashes = [ordered]@{}
    foreach ($name in $helpers) {
        $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $Source $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $directoryLease = [Deployment.WindowsPrivateFile]::CreateDirectory($Directory)
    $retained = [Collections.Generic.List[IDisposable]]::new()
    try {
        foreach ($name in $helpers) {
            $directoryLease.Check()
            $retained.Add([Deployment.WindowsPrivateFile]::CopyTrustedSource(
                (Join-Path $Source $name), $hashes[$name], (Join-Path $Directory $name)))
        }
        foreach ($name in $helpers) {
            if ((Get-FileHash -LiteralPath (Join-Path $Source $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hashes[$name]) {
                throw 'Runtime source changed during publication.'
            }
        }
        foreach ($copy in $retained) { $copy.Check() }
        $configuration = Join-Path $Directory 'configuration.json'
        $command = [ordered]@{
            file=$frame.command.file; args=$frame.command.args; cwd=$frame.command.cwd; environment=$frame.command.env
        }
        $text = [ordered]@{ version=1; helpers=$hashes; command=$command } | ConvertTo-Json -Depth 16 -Compress
        $published = [Deployment.WindowsPrivateFile]::Publish($configuration, $text)
        $retained.Add($published)
        $directoryLease.Check()
        foreach ($copy in $retained) { $copy.Check() }
        return [pscustomobject]@{ Directory=$Directory; Configuration=$configuration; Sha256=$published.Sha256 }
    } catch {
        $cause = $_.Exception.GetBaseException()
        throw [InvalidOperationException]::new(
            "Runtime bundle publication failed; retain incomplete directory $Directory. Cause: $($cause.GetType().Name): $($cause.Message)",
            $_.Exception)
    } finally {
        $failures = [Collections.Generic.List[Exception]]::new()
        foreach ($resource in @($retained.ToArray()) + @($directoryLease)) {
            try { $resource.Dispose() }
            catch { $failures.Add($_.Exception) }
        }
        if ($failures.Count) { throw [AggregateException]::new('Runtime bundle handles did not close.', $failures) }
    }
}
