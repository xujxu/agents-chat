function Invoke-VoiceConfiguration {
    param(
        [Parameter(Mandatory=$true)][string]$ProjectDir,
        [string]$Model, [string]$PackageDir, [string]$ManifestSha256,
        [string]$Threads, [string]$ServiceUser, [string]$Receipt,
        [switch]$NonInteractive,
        [Nullable[bool]]$Interactive = $null
    )
    $canPrompt = if ($null -ne $Interactive) { [bool]$Interactive } else {
        [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
    }
    if (-not $Model -and -not $NonInteractive -and $canPrompt) {
        Write-Host '1) Keep current voice settings (default)'
        Write-Host '2) SenseVoiceSmall official GGUF q8 (integration candidate)'
        Write-Host '3) Whisper base-q5_1 (compatibility; not recommended quality/latency)'
        Write-Host '4) Disable voice input (hide microphone)'
        Write-Host 'Native packages require an extracted verified package and trusted manifest SHA256. No automatic public download.'
        $answer = Read-Host 'Voice setup [1]'
        $Model = switch (([string]$answer).Trim()) {
            '' { 'keep' }; '1' { 'keep' }; '2' { 'sensevoice-small-q8' }
            '3' { 'whisper-base-q5_1' }; '4' { 'disabled' }
            default { throw 'Invalid voice selection.' }
        }
    }
    if (-not $Model) { $Model = 'keep' }
    $arguments = @((Join-Path $ProjectDir 'scripts\configure-voice.mjs'), '--project-dir', $ProjectDir,
        '--non-interactive', '--model', $Model)
    foreach ($pair in @(
        @('--package-dir', $PackageDir), @('--manifest-sha256', $ManifestSha256),
        @('--threads', $Threads), @('--service-user', $ServiceUser), @('--receipt', $Receipt)
    )) {
        if ($pair[1]) { $arguments += $pair }
    }
    & node @arguments | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'Voice configuration failed; application activation was not started.' }
    if ($Receipt) {
        $result = [System.IO.File]::ReadAllText($Receipt) | ConvertFrom-Json
        return [bool]$result.changed
    }
}

function Restore-VoiceConfiguration {
    param([string]$ProjectDir, [string]$Receipt)
    & node (Join-Path $ProjectDir 'scripts\configure-voice.mjs') --project-dir $ProjectDir --non-interactive --rollback-receipt $Receipt |
        ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "Voice rollback failed; private recovery receipt retained at $Receipt" }
}

function Set-VoiceSafeEnvironmentUrl {
    param([string]$ProjectDir, [string]$Url)
    & node (Join-Path $ProjectDir 'scripts\voice\windows\environment-url.mjs') (Join-Path $ProjectDir '.env.local') $Url
    if ($LASTEXITCODE -ne 0) { throw 'Environment URL update failed; refusing to start with damaged configuration.' }
}
