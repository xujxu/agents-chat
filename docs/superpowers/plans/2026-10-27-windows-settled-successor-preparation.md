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
