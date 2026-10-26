$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/deployment/windows-stopped-history-handoff-json.ps1')
$reference = '{"owner":{"pid":42,"identity":"42:123"},"runtime":null,"items":[true,1,"x"]}'
function Assert-JsonBindingRefused([string]$ActualText, [string]$ExpectedText) {
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($ActualText)
        $expected = [Text.Json.JsonDocument]::Parse($ExpectedText)
        try { Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement }
        catch {
            if ($_.Exception.Message -notmatch '^Prepared handoff JSON binding differs:') { throw }
            return
        }
        throw 'Expected native prepared handoff JSON binding refusal.'
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
}
$expected = $reordered = $null
try {
    $expected = [Text.Json.JsonDocument]::Parse($reference)
    $reordered = [Text.Json.JsonDocument]::Parse('{"items":[true,1,"x"],"runtime":null,"owner":{"identity":"42:123","pid":42}}')
    Assert-AgentsChatStoppedHandoffJsonBinding $reordered.RootElement $expected.RootElement
} finally {
    if ($reordered) { $reordered.Dispose() }
    if ($expected) { $expected.Dispose() }
}
foreach ($text in @(
    '{"owner":{"pid":42,"pid":42,"identity":"42:123"},"runtime":null,"items":[true,1,"x"]}',
    '{"owner":{"Pid":42,"identity":"42:123"},"runtime":null,"items":[true,1,"x"]}',
    '{"owner":{"pid":42},"runtime":null,"items":[true,1,"x"]}',
    '{"owner":{"pid":42,"identity":"42:123","extra":null},"runtime":null,"items":[true,1,"x"]}',
    '{"owner":{"pid":42,"identity":"42:124"},"runtime":null,"items":[true,1,"x"]}',
    '{"owner":{"pid":"42","identity":"42:123"},"runtime":null,"items":[true,1,"x"]}',
    '{"owner":{"pid":43,"identity":"42:123"},"runtime":null,"items":[true,1,"x"]}',
    '{"owner":{"pid":42.0,"identity":"42:123"},"runtime":null,"items":[true,1,"x"]}',
    '{"owner":{"pid":42,"identity":"42:123"},"runtime":false,"items":[true,1,"x"]}',
    '{"owner":{"pid":42,"identity":"42:123"},"runtime":null,"items":[false,1,"x"]}',
    '{"owner":{"pid":42,"identity":"42:123"},"runtime":null,"items":[1,true,"x"]}',
    '{"owner":{"pid":42,"identity":"42:123"},"runtime":null,"items":[true,1]}',
    '{"owner":{"pid":42,"identity":"42:123"},"runtime":null,"items":[true,1,"x"],"runtime":null}'
)) {
    Assert-JsonBindingRefused $text $reference
}
Assert-JsonBindingRefused '{"runtime":null}' '{"runtime":null,"runtime":null}'
Write-Host 'PASS: native prepared handoff JSON binding ignores object order but rejects duplicate keys and changed typed values'
