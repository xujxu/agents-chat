# Settled Successor Preparation Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive an exact fresh prospective preparation from natively settled lock history, without publishing another record or granting continuation.

**Architecture:** Keep the existing four-record settlement observer and its namespace unchanged. An independent native successor-preparer role derives the original prepared binding with a new live owner, then binds the four pinned predecessor records. This is preparation only: publication, successor namespace reopening, new-lock admission and state writes remain separate gates.

**Tech Stack:** PowerShell native proof, existing strict owner/binding helpers, Node.js interruption fixture, GitHub Actions only.

---

### Task 1: Contract before implementation

**Files:**
- Create: `tests/deployment-windows-history-handoff-successor.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-lock-settlement-observation.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [x] Accept publisher death and sixth-actor observation on `3dc7c396`:
  focused `40468746459` / job `122070434774` passed all 28 actual required
  receipts; same-SHA Contracts `40468749739` / job `122070444137` passed.
- [ ] Add fixture-only `PrepareSuccessor`, requiring `ObserveSettlement`.
  Reuse its retained scope; do not add another archive opener, hold mode,
  controller request schema or public command exception.
- [ ] In one native invocation, require missing independent role refusal,
  replayed predecessor attempt/operation/token refusal, pairwise fresh GUID
  separation and refusal of a preparation predating terminal settlement.
  Keep the valid scope available after scalar-input refusals.
- [ ] Request a valid preparation for the actual sixth controller. Compare
  the exact fifteen-field result to the original prepared record with only
  phase, attempt, live owner and predecessor changed. Check canonical time,
  fresh GUIDs, four unchanged predecessor descriptors, actual controller
  identity, unchanged state/completion/record bytes and identities, absent
  lock and unchanged ordinary acquire/release refusals.
- [ ] Require the 29th actual receipt:

```text
PASS: fresh native successor preparation derives a distinct live owner from settled evidence without publication or authority
```

Push test-only, dispatch focused history, and require an actual failure on
the missing `windows-stopped-history-handoff-successor.ps1` module. Do not
accept a timeout or an earlier boundary failure as this red.

Accepted test-only red: `c730da606046014de333a9a5f74861a57feafcb1`,
focused run `40472338026`, job `122082185595`. At
`2026-10-27T08:48:47.8084965Z`, the actual sixth actor's explicit
`-ObserveSettlement -PrepareSuccessor` invocation failed on missing
`windows-stopped-history-handoff-successor.ps1`. It reached the new
boundary after the settled-evidence negative/revalidation checks; there
was no actor-budget relaxation or earlier-boundary failure.

### Task 2: Native derived record

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-successor.ps1`

- [ ] Implement this scalar interface:

```powershell
function Get-AgentsChatStoppedHistoryHandoffSuccessorRecord(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
)
```

Require `HistoryHandoffSuccessorPreparer` and the read-only settlement
observer; reject a terminal-publisher scope. Refuse reused predecessor
attempt, operation or token and non-distinct new GUIDs. Validate native
canonical time against settlement. Derive the new owner with
`New-AgentsChatStoppedHistoryHandoffOwner` and the original state timestamp.
Run full `Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation`
before and after derivation, and reuse
`Get-AgentsChatStoppedHistoryHandoffBinding` for the original archive,
state, task, configuration and runtime proof.

Return the original fourteen-field binding with phase
`stopped-history-handoff-successor-prepared` and this fifteenth field,
using descriptors from retained native files rather than caller JSON:

```powershell
$record.predecessor = [ordered]@{
    attemptId=$observed.attemptId
    prepared=$observed.prepared
    committed=$observed.committed
    retirement=$observed.retirement
    terminal=$observed.terminal
}
```

Revalidate the live owner before returning. Do not call ordinary
`Get-AgentsChatStoppedHistoryHandoffPreparedRecord`, whose existing refusal
of all prior handoff files must remain unchanged. No publication,
namespace exception, state substitution, executor role or continuation
capability is part of this increment.

Apply the existing 1 MiB prepared-record bound after adding the predecessor
field. The fixture serializes at depth 12, matching the original binding,
and allows up to 2 MiB of captured process output for this full-record
response rather than the earlier descriptor-only 128 KiB.

- [ ] Push implementation and run same-SHA focused history and Windows
  Contracts. Match all 29 required receipts against actual timestamped
  output and record SHA/run/job evidence.

### Remaining boundary

A derived in-memory preparation is not fresh-attempt admission. Durable
successor publication must retain all predecessor files, explicitly bind
the expanded namespace and cover actual publisher death before new-lock
publication, committed capability or state continuity is implemented.

## Accepted evidence

- Implementation: `c5ea3f08ebaa583832643d6f365b208c269e5745`.
- Same-SHA focused run `40476262515`, job `122095142472`, passed.
  All 29 required receipts from the committed workflow were individually
  matched to actual timestamped `Z PASS:` output in the downloaded log.
  The new preparation receipt occurred at `2026-10-27T09:10:38.3550032Z`.
- Same-SHA Windows Contracts run `40476266395`, job `122095156418`,
  passed; its actual job log is retained separately.
- This accepts native derivation only. No successor file, new lock,
  state write, continuation capability or public admission was introduced.

## Implementation body after the missing-module red

The production file remained absent in the test-only increment. After the
accepted actual missing-module red, implementation uses this module:

```powershell
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock-settlement-observation.ps1')

function Get-AgentsChatStoppedHistoryHandoffSuccessorRecord(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    if (-not $Context.ContainsKey('HistoryHandoffSuccessorPreparer') -or
        $Context.HistoryHandoffSuccessorPreparer -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffLockSettlementObserver') -or
        $Context.HistoryHandoffLockSettlementObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffLockSettler')) {
        throw 'Successor preparation requires its independent native role.'
    }
    $previous = $Context.HistoryHandoffObservedCommit
    $old = $Context.HistoryHandoffLock.OwnerRequest
    $oldIds = @($Context.OperationId, $previous.AttemptId, $old.OperationId, $old.Token)
    foreach ($value in @($AttemptId, $OperationId, $Token)) {
        Assert-AgentsChatCompletionGuid $value
        if ($value -cin $oldIds) {
            throw 'Successor preparation requires fresh distinct owner identifiers.'
        }
    }
    if (@($AttemptId, $OperationId, $Token | Select-Object -Unique).Count -ne 3) {
        throw 'Successor preparation requires fresh distinct owner identifiers.'
    }
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $CreatedAt $Context.HistoryHandoffLockSettlement.SettledAt
    $request = @{
        Project=$Context.Project; PreviousOperationId=$Context.OperationId
        AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
        PreviousUpdatedAt=(Get-AgentsChatStoppedHistoryHandoffStateUpdatedAt $Context)
        ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
    }
    $owner = New-AgentsChatStoppedHistoryHandoffOwner @request
    $observed = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Context $ControllerPid $ControllerIdentity
    $record = Get-AgentsChatStoppedHistoryHandoffBinding $Context $AttemptId $owner
    $record.phase = 'stopped-history-handoff-successor-prepared'
    $record.predecessor = [ordered]@{
        attemptId=$observed.attemptId
        prepared=$observed.prepared; committed=$observed.committed
        retirement=$observed.retirement; terminal=$observed.terminal
    }
    if ([Text.Encoding]::UTF8.GetByteCount(($record | ConvertTo-Json -Depth 12 -Compress)) -gt 1048576) {
        throw 'Native successor preparation response is oversized.'
    }
    $null = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Context $ControllerPid $ControllerIdentity
    $null = New-AgentsChatStoppedHistoryHandoffOwner @request
    return $record
}
```
