$ErrorActionPreference = 'Stop'
foreach ($file in @('scripts/setup.ps1', 'scripts/deploy.ps1', 'scripts/start.ps1',
    'scripts/install-scheduled-task.ps1', 'scripts/voice/windows/configure.ps1')) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path (Get-Location) $file), [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw "PowerShell syntax errors in ${file}: $errors" }
}
foreach ($file in @('scripts/start.ps1', 'scripts/service-watchdog.ps1')) {
    $source = [IO.File]::ReadAllText((Join-Path (Get-Location) $file))
    if ($source.Contains('Invoke-VoiceConfiguration') -or $source.Contains('configure-voice.mjs')) {
        throw 'Startup/watchdog must not invoke voice configuration.'
    }
}
Write-Host 'PowerShell syntax and no-prompt startup contracts passed.'
