$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$pwsh = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
$original = $env:DEPLOYMENT_TEST_PRIVATE_RUNNER_SCENARIO
try {
    foreach ($scenario in @('failure', 'timeout')) {
        $env:DEPLOYMENT_TEST_PRIVATE_RUNNER_SCENARIO = $scenario
        $output = & $pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'deployment-windows-private-tests.ps1') `
            -Tests tests/deployment-windows-private-runner-fixture.mjs -TimeoutSeconds 5 2>&1
        $code = $LASTEXITCODE
        $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
        if ($code -eq 0) { throw "Private runner accepted intentional $scenario." }
        foreach ($marker in @('PRIVATE_RUNNER_STDOUT', 'PRIVATE_RUNNER_STDERR')) {
            if (-not $text.Contains($marker)) { throw "Private runner lost $scenario output ($marker):`n$text" }
        }
        $expected = if ($scenario -eq 'timeout') { 'Private Windows tests timed out.' } else { 'Private Windows tests failed with exit code 1.' }
        if (-not $text.Contains($expected)) { throw "Private runner lost its primary $scenario failure:`n$text" }
        if ($scenario -eq 'failure' -and -not $text.Contains('PRIVATE_RUNNER_EXPECTED_FAILURE')) {
            throw "Private runner lost test failure details:`n$text"
        }
        Write-Output "Private runner preserves $scenario diagnostics and fails explicitly."
    }
} finally {
    $env:DEPLOYMENT_TEST_PRIVATE_RUNNER_SCENARIO = $original
}
