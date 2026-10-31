# Handoff Lock Terminal Settlement Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one immutable terminal record after complete native lock retirement, without deleting evidence or admitting a new operation.

**Architecture:** Reuse the accepted full directory-retired observation and add an independent settlement publisher plus a separate read-only settlement observer. Bind all three original records, original owner/directory identities, original archive/state/task/runtime settlement and actual publisher identity. A terminal record is evidence, not a continuation capability.

**Tech Stack:** PowerShell 7, native retained private files and strict JSON, Node.js interruption fixtures, GitHub Actions only.

---

### Prerequisite gate

- [x] Accept actual directory-executor death and a distinct fifth actor from
  `2026-10-27-windows-directory-retirement-executor-death.md` before pushing
  this increment. Do not mix its acceptance with the earlier normal
  directory-retirement gate.

### Task 1: Immutable record and independent roles

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-lock-settlement.ps1`
- Create: `scripts/deployment/windows-stopped-history-handoff-lock-settlement-observation.ps1`

The terminal filename is `inactive-handoff-<attempt>-lock-retired.json`.
Its exact fifteen fields are:

```powershell
[ordered]@{
    version=1; phase='stopped-history-handoff-lock-retired'
    attemptId=$retained.AttemptId; control=$Context.Control; project=$Context.Project
    controlIdentity=$Context.HistoryRecord.controlIdentity
    previousOperationId=$Context.OperationId
    prepared=$retained.PreparedDescriptor; committed=$retained.CommittedDescriptor
    retirement=$Context.HistoryHandoffLockRetirementIntent.Descriptor
    newOwner=$owner; lockIdentity=$Context.HistoryHandoffLock.DirectoryIdentity
    lock=$Context.HistoryHandoffLock.OwnerDescriptor
    creator=$Creator; settledAt=$SettledAt
}
```

- [ ] `Get-AgentsChatStoppedHistoryHandoffLockSettlementRecord(Context,
  Creator, SettledAt)` is a nonrecursive native record builder. Require
  current observer identity, strict retained intent assertion, original
  owner absence and explicit directory-retired stage with no owner or
  directory handles/targets. Capture actual prepared/committed descriptors,
  not caller-supplied JSON. Require canonical native UTC not earlier than
  intent creation, using the existing canonical time-order validator.
- [ ] `Assert-AgentsChatStoppedHistoryHandoffLockSettlement(Context)`
  requires exactly one of `HistoryHandoffLockSettler` and
  `HistoryHandoffLockSettlementObserver`, plus the existing retirement
  observer scope and retained terminal file. Match exact terminal descriptor,
  derive the fifteen-field expected record, and compare strict JSON including
  typed values and duplicate-key rejection. Never call physical lock or full
  observation from this assertion: namespace verification will call it.
- [ ] `Publish-AgentsChatStoppedHistoryHandoffLockSettlement(Context,
  ControllerPid, ControllerIdentity)` requires the independent settler role.
  Refuse an already-retained terminal before writing. Run full native
  retirement observation and require `lock-retirement-directory-retired`;
  capture actual controller/bridge identities and native UTC; publish
  create-only and retain `File`, `Descriptor`, `Creator`, `SettledAt` in
  `HistoryHandoffLockSettlement`. Twice recheck complete original native
  proof and strict terminal binding. Return only the terminal descriptor.
  Poison failures and preserve every durable file.

### Task 2: Explicit four-record native reopening

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-observation.ps1`
- Create: `scripts/deployment/windows-stopped-history-handoff-lock-settlement-observation.ps1`

- [ ] Extend the internal committed observation request with optional
  `terminal`, only when `retirement` is also present. Exact schemas are
  still five, six or seven fields; wrong combinations refuse. Validate all
  descriptors and exact namespace before opening native files.
- [ ] After committed/intent bootstrap, initialize terminal observation.
  Require its publisher controller and bridge both natively absent; pin its
  exact file, creator and canonical timestamp, set only the read-only
  settlement role, then run full physical/original proof and strict binding
  before returning a scope. A live publisher cannot be adopted by a fresh
  bridge, even if its controller PID matches.
- [ ] Append the terminal filename in committed namespace verification only
  after the complete nonrecursive terminal assertion. Ordinary two/three
  record scopes still refuse an unexpected fourth file.
- [ ] `Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation(Context,
  ControllerPid, ControllerIdentity)` runs complete retirement observation
  plus terminal assertion twice. Return exactly the original eleven fields
  plus `terminal`, with status `lock-retirement-settled` and both authority
  flags false. The original publisher may inspect its retained scope while
  alive; fresh reader initialization requires its death.
- [ ] `Open-AgentsChatStoppedHistoryHandoffLockSettlementObservation(Control,
  ControllerPid, ControllerIdentity, AttemptId, Prepared, Committed,
  Retirement, Terminal)` requires the terminal descriptor and uses the
  explicit native bootstrap above. Aggregate scope-close failures with the
  original error. It grants no publisher/executor role.

### Task 3: First publication contract, before implementation

**Files:**
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-directory-retirement-observation.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add fixture `SettleRetirement`, requiring `ObserveRetirement` and
  excluding owner/directory removal, intent publication and hold. Load the
  settlement module; verify missing independent publisher role refuses
  before mutation, then set the settler role and call publication. Inspect
  its retained terminal observation and return only the bounded twelve-field
  native result. A repeated publication must refuse without changing bytes.
- [ ] In the accepted fifth actor, after all directory-death checks and
  before fixture cleanup, publish settlement. Require the exact terminal
  filename, descriptor and fifteen-field record, matching original scope,
  all original descriptors, original lock identity/owner, actual fifth Node
  and publishing native bridge, and native canonical time ordering.
  Verify all four record bytes/hash/dev/ino plus original state/completion
  after publication.
- [ ] A plain three-record observer must refuse the extra terminal; a fresh
  explicit terminal observer must refuse while the fifth Node publisher
  remains alive. Keep ordinary acquisition/release refused and actual
  directory absent. Only fixture-owned cleanup may remove the four exact
  records after all checks.
- [ ] Require actual receipt:

```text
PASS: native lock retirement settlement seals one exact terminal without changing evidence or granting continuation
```

  Push test-only after the prerequisite gate; dispatch focused history and
  inspect actual missing-settlement-module red. Implement Tasks 1–2, then
  push and run same-SHA focused history plus Windows Contracts. Inspect all
  27 actual receipts and persist red/green SHA/run/job evidence.

### Next interruption boundary

Actual terminal-publisher death and fresh sixth-actor observation must have a
separate retained native fixture/host gate before fresh-attempt admission.
Fresh attempt settlement discovery, production committed capability, original
state snapshot, first transition, handoff-aware release and public inactive
deploy/update remain later gates. No terminal filename or record alone may
clear any ordinary maintenance gate.

## Precondition fixture budget

Test-only `b5298508`, run `40459538657`, job `122040620600`, did not reach
the expected missing terminal module. The earlier owner-retired resumer
combined its partial-cleanup negative cases with the newly added directory
deletion/replacement/reopen cases and subsequent archive restoration; it
hit the existing 120-second actor budget. This is not accepted terminal red.

Separate the owner-retired proof into its own `check-lock-owner-retired-history`
actor. Retain all original identity/record/state/completion, foreign-child,
changed-state, wrong-intent and idempotent-owner checks there, then exit
without deleting any evidence. The following independent directory-removal
actor reopens the full native proof and performs all directory deletion,
replacement, fresh-read and retry checks plus existing fixture restoration.
Keep each 120-second actor budget and every 15-second bridge-death budget
unchanged. Push this fixture split with native terminal modules still absent,
then require the actual missing-module red before committing implementation.

## Accepted validation evidence

- Valid test-only red: `02d7fca9a1227b92783449f15773f06b1caa1b31`,
  focused run `40462486777`, job `122050106669`. Both split actors passed;
  the fifth actor reached settlement and failed on the missing native
  `windows-stopped-history-handoff-lock-settlement.ps1` module.
- Implementation: `21c332ea372be886428ff12c0625080b6619ee45`.
  Same-SHA Windows Contracts run `40465603194`, job `122060123168`,
  completed successfully. Its actual job log is retained in the session
  artifacts.
- Same-SHA focused run `40465600056`, job `122060112902`, completed
  successfully. All 27 required receipts from that SHA's workflow were
  individually matched to actual timestamped `Z PASS:` output in the
  downloaded job log, not to workflow source echoes. The settlement receipt
  occurred at `2026-10-27T07:40:42.1798010Z`.
- Normal immutable terminal publication is accepted. It does not cover
  terminal-publisher death, a sixth actor, fresh-attempt admission, state
  continuity, public routing or actual repeat application lifecycle.
