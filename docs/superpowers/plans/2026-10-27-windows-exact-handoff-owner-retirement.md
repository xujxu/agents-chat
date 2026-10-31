# Exact Handoff Owner Retirement Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Natively delete only the exact dead committed owner's file under its immutable retirement intent, then prove a fresh actor can observe that partial cleanup after real executor death.

**Architecture:** Add an independent native executor to the accepted retirement-observer scope. Transfer the exact owner pin to the existing native retirement handle factory, recheck full original proof with that handle held, then delete through that handle. The validated intent explicitly permits the owner-absent/empty-original-directory stage; ordinary readers and directory-only states without such intent remain unchanged.

**Tech Stack:** PowerShell 7, WindowsPrivateFile.RetainForRetirement, existing native JSON/archive/task/runtime proofs, Windows Actions.

---

### Task 1: Actual owner removal and executor death contracts

**Files:**
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-lock-retirement-observation.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add fixture `RetireOwner`, allowed only with `ObserveRetirement`; allow `Hold` with this action as well as existing intent publication. Require a missing executor role to refuse before any mutation, then set only `HistoryHandoffLockRetirementExecutor` and call:

```powershell
$observation = Remove-AgentsChatStoppedHistoryHandoffLockOwner $scope `
    $ControllerPid $ControllerIdentity
```

  On success require actual `owner.json` absence, the same native directory identity and zero children. Return/hold only the bounded native retirement observation. Do not remove the directory.

- [ ] Add host `lock-owner-retired-history` boundary. Follow existing first committed owner death and second intent publisher death. Start a distinct third executor actor, verify native owner removal and held bridge identity, kill that exact Node actor and await its exact bridge. A fourth actor resumes using preserved descriptor-only metadata with separate original-owner, intent-publisher and latest-executor identity tuples.

  Keep the existing 120-second actor/15-second bridge budgets. Do not nest complete prior metadata repeatedly; retain original record descriptors once and actor identity tuples separately.

- [ ] The fresh actor must prove all prior identities absent, exact prepared/committed/retirement record bytes/hash/dev/ino unchanged, original state/completion unchanged, same original new-lock directory identity, and exactly zero directory children. Native observation must return the existing eleven fields with status `lock-retirement-owner-retired`, original recorded owner descriptor and both authority flags false.

  Require idempotent native owner retirement after a fresh reopen to return that same owner-retired status without changing anything. A foreign/pending child or changed original state must refuse without deleting it. Ordinary acquire/release and the old observer entry must remain refused. Ordinary archive opening must still refuse while the new directory remains.

  Only after all checks may fixture cleanup remove the now-empty exact directory and exact handoff records, then perform existing archive restoration. There is no production directory deletion in this increment.

- [ ] Add required actual receipts:

```text
PASS: native exact dead handoff owner retirement deletes only its pinned owner under immutable intent
PASS: actual owner retirement executor death leaves an exact empty directory for a fresh native partial-cleanup observer
```

  Commit/push tests, dispatch focused history and download actual red. Require
  the missing native owner-removal module/function after successful
  third-actor intent observation, not a timeout or changed older contract.

### Task 2: Explicit owner-retired native proof stage

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-intent.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-observation.ps1`

- [ ] With an explicitly supplied retirement descriptor only, permit committed bootstrap to pin the original directory while `owner.json` is absent. Retain the immutable committed record's exact original owner descriptor; pin and fully validate the retirement intent and original owner absence as before. Without the supplied intent, continue opening the actual owner and refusing absence.

  This is a declared partial-retirement stage, not a missing-input default. Native directory checking must require the original directory identity and zero children; malformed, pending, foreign or case-variant children block. Directory absence remains unsupported.

- [ ] Add a shared original-owner descriptor accessor: present owner uses its actual retained native descriptor; in-progress retirement uses the exact native retirement target's checked original descriptor; owner-absent stage requires explicit retained retirement-observer/intent proof and the exact recorded descriptor. Never substitute this descriptor in an ordinary context.

  Use the checked accessor in committed-record reconstruction. Keep the
  retirement-record builder free of physical lock-verifier calls and rebuild
  its original lock fields from the captured descriptor; this lets the
  physical verifier require a strict intent assertion in partial stages
  without recursion. Intent publication still explicitly checks the physical
  lock immediately before its create-only write.

  Full strict comparisons of both pinned records, original prepared binding,
  original archive/state/task/runtime settlement and original actor/creator
  absence remain mandatory before an observer scope returns.

- [ ] Extend the exact native lock verifier with these tightly scoped stages:
  - present owner: unchanged actual file descriptor/text/inventory proof;
  - native retirement target: independent executor role, target handle Check, original descriptor and exactly one owner child;
  - owner absent: retained read-only retirement role plus pinned intent, original directory identity, zero children and absent original owner process.

  Require the complete strict intent assertion in both target-held and
  owner-absent stages, not just role/marker presence. Reject any other
  combination. The getter reports `lock-retirement-owner-retired` only for
  the verified owner-absent stage; existing owner-present responses retain
  their shape/status.

### Task 3: Native handle-bound owner deletion

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-owner.ps1`

- [ ] Require independent `HistoryHandoffLockRetirementExecutor`, complete accepted retirement-observer scope and current executor PID/start identity. Call the full native retirement observer before mutation. If owner already absent under the validated intent, return verified owner-retired observation without writes.

- [ ] Capture the actual owner descriptor. Dispose/remove only its old read pin, then call:

```powershell
$target = [Deployment.WindowsPrivateFile]::RetainForRetirement(
    (Join-Path $Context.Control 'lock\owner.json'),
    $descriptor.sha256, $descriptor.dev, $descriptor.ino, $descriptor.bytes)
```

  Retain the target in Context.Files and the dedicated lock retirement-target slot. This factory must match exact dev/ino/bytes/hash; do not use pathname deletion or reacquire an unchecked file.

- [ ] With the target handle retained, repeat full native retirement observation, exact child inventory, original state/task/runtime proof and current actor identity. Delete only through `$target.Delete()`. Remove the disposed target from Context.Files, clear its target slot and explicitly transition to owner-absent proof. Twice revalidate the complete owner-retired observation and unchanged original directory/records/state.

  Every failure poisons the scope, closes retained handles through existing aggregate cleanup and preserves all durable evidence. Never undo intent publication, replace an owner, remove a foreign file or remove the directory.

- [ ] Push implementation and dispatch focused history plus Windows Contracts on one SHA. Verify all twenty-one prior actual receipts plus both new receipts. Record actual red/green SHA/run/job evidence and push it.

## Next deletion and settlement boundary

The original directory remains a blocker after this increment. Native directory retirement must separately pin its exact identity, survive actual executor death after directory disappearance and publish immutable terminal settlement. Fresh-attempt admission, first state transition, handoff-aware release and public inactive routing remain later gates; no worker authority follows from owner-file removal.

## Accepted execution evidence

- Tests: `09e858be`; focused red
  [40445415945](https://github.com/xujxu/agents-chat/actions/runs/40445415945),
  job `121995420709`. The actual third actor reached the missing native
  `windows-stopped-history-handoff-lock-retirement-owner.ps1` module; this was
  not a timeout or an earlier contract failure.
- Implementation: `04b89949967f40546ffed185e08f75a9e567fbd8`.
  Same-SHA focused history
  [40447653263](https://github.com/xujxu/agents-chat/actions/runs/40447653263),
  job `122002648989`, and Windows Contracts
  [40447656298](https://github.com/xujxu/agents-chat/actions/runs/40447656298),
  job `122002657672`, both succeeded.
- All 23 required receipts were matched to actual timestamped `Z PASS:`
  execution lines, not workflow source echoes. Owner deletion passed at
  `2026-10-27T04:24:07Z`; actual executor death and fresh partial-cleanup
  observation passed at `2026-10-27T04:24:56Z`.
- The fresh actor proved unchanged original empty-directory identity,
  immutable records/state/completion, wrong-intent-identity refusal,
  foreign-child and changed-state refusal, and idempotent native retry.
  Ordinary gates remained refused. Production did not remove the directory
  or grant any new-operation authority.
- All execution was in GitHub Actions. This focused acceptance does not
  replace the pending full Linux/Windows matrix or public repeat lifecycle.
