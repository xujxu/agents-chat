# Native Prepared Handoff JSON Binding Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare a decoded native prepared record against an independently derived native binding without accepting duplicate keys, type changes or order-dependent object comparisons.

**Architecture:** Add a read-only JsonElement comparator beside the native handoff record builder. Object keys use exact ordinal matching and recursive comparison; arrays retain order; scalar JSON types and values remain exact. This is a prerequisite for native pinned-record revalidation, not a parser that grants authority.

**Tech Stack:** PowerShell 7, System.Text.Json, Windows GitHub Actions Contracts.

---

### Task 1: Focused native contracts

**Files:**
- Create: `tests/deployment-windows-handoff-json.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Create the native contract script. Parse a reference containing the
  prepared record's nullable runtime shape; require object-order independence:

```powershell
$expected = [Text.Json.JsonDocument]::Parse('{"owner":{"pid":42,"identity":"42:123"},"runtime":null,"items":[true,1,"x"]}')
$reordered = [Text.Json.JsonDocument]::Parse('{"items":[true,1,"x"],"runtime":null,"owner":{"identity":"42:123","pid":42}}')
try {
    Assert-AgentsChatStoppedHandoffJsonBinding $reordered.RootElement $expected.RootElement
} finally { $reordered.Dispose(); $expected.Dispose() }
```

  Reject nested duplicate keys, case changes, missing and extra keys, changed
  strings, numeric/string substitutions, boolean/null substitutions, changed
  numbers and reordered arrays. Reject duplicate reference keys as well.
  Require explicit `Prepared handoff JSON binding differs` errors, not arbitrary
  exceptions. The fixture must dispose every JsonDocument.

- [ ] Add one private Windows Contracts step after native owner identity:

```powershell
& (Get-Command pwsh).Source -NoProfile -NonInteractive -File ./tests/deployment-windows-handoff-json.ps1
if ($LASTEXITCODE -ne 0) { throw 'Native handoff JSON binding contracts failed.' }
```

- [ ] Commit/push tests and dispatch:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_restore_only=true -f windows_contracts_only=true
```

  Require actual red logs in the new step due to the missing production
  comparator module. Do not run local validation.

### Task 2: Exact recursive binding

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-json.ps1`

- [ ] Implement the complete recursive comparator:

```powershell
function Assert-AgentsChatStoppedHandoffJsonBinding(
    [Text.Json.JsonElement]$Actual, [Text.Json.JsonElement]$Expected
) {
    if ($Actual.ValueKind -ne $Expected.ValueKind) {
        throw 'Prepared handoff JSON binding differs: value kind.'
    }
    switch ($Expected.ValueKind) {
        ([Text.Json.JsonValueKind]::Object) {
            $fields = [Collections.Generic.Dictionary[string,Text.Json.JsonElement]]::new([StringComparer]::Ordinal)
            foreach ($field in $Expected.EnumerateObject()) {
                if (-not $fields.TryAdd($field.Name, $field.Value)) {
                    throw 'Prepared handoff JSON binding differs: duplicate reference key.'
                }
            }
            foreach ($field in $Actual.EnumerateObject()) {
                $value = [Text.Json.JsonElement]::new()
                if (-not $fields.Remove($field.Name, [ref]$value)) {
                    throw 'Prepared handoff JSON binding differs: unexpected or duplicate key.'
                }
                Assert-AgentsChatStoppedHandoffJsonBinding $field.Value $value
            }
            if ($fields.Count) { throw 'Prepared handoff JSON binding differs: missing key.' }
            return
        }
        ([Text.Json.JsonValueKind]::Array) {
            if ($Actual.GetArrayLength() -ne $Expected.GetArrayLength()) {
                throw 'Prepared handoff JSON binding differs: array length.'
            }
            for ($index = 0; $index -lt $Expected.GetArrayLength(); $index++) {
                Assert-AgentsChatStoppedHandoffJsonBinding $Actual[$index] $Expected[$index]
            }
            return
        }
        ([Text.Json.JsonValueKind]::String) {
            if ($Actual.GetString() -cne $Expected.GetString()) {
                throw 'Prepared handoff JSON binding differs: string.'
            }
            return
        }
        ([Text.Json.JsonValueKind]::Number) {
            if ($Actual.GetRawText() -cne $Expected.GetRawText()) {
                throw 'Prepared handoff JSON binding differs: number.'
            }
            return
        }
        ([Text.Json.JsonValueKind]::Null) { return }
        ([Text.Json.JsonValueKind]::True) { return }
        ([Text.Json.JsonValueKind]::False) { return }
        default { throw 'Prepared handoff JSON binding differs: unsupported value.' }
    }
}
```

  Numeric spelling remains exact rather than normalizing exponent/decimal
  forms. Native owner PID and descriptor byte counts are emitted as integers;
  alternate number spellings need not be accepted.

- [ ] Commit/push production module and repeat the same Actions selection.
  Require the complete Contracts job and actual new PASS receipt.
- [ ] Record SHA/run/job evidence and push the accepted result.

## Self-review

The reference comes from independent native derivation, not the same untrusted
decoded record. The comparator handles null without using the retirement
converter that rejects null. No file I/O, process absence proof, lock authority,
publication, or generic JSON transport changes are included. The later pinned
record reader must retain original bytes/hash/identity separately and invoke
this comparator against the independently derived complete native record.
