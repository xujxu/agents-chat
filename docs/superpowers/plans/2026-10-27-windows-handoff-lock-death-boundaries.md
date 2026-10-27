# Native Handoff Lock Death Boundaries Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill real owners at directory-only, exact-owner and committed publication boundaries and prove a distinct actor cannot turn those artifacts into ordinary operation authority.

**Architecture:** Split the existing native publisher into three explicit retained-context stages without introducing test callbacks, sleeps or public routing. The fixture selects a durable stage and holds its original native scope until the host kills its watched Node actor. A fresh actor verifies exact evidence and ordinary refusal; only fixture-owned, identity-checked cleanup restores the shared test environment.

**Tech Stack:** PowerShell 7, retained native archive/lock handles, Node actor fixtures, Windows GitHub Actions only.

---

### Task 1: Add real interruption contracts before staged implementation

**Files:**
- Modify: `tests/deployment-windows-history-handoff-commit.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add optional fixture `HoldAt` with exact values `Directory`, `Owner`, `Committed`. Preserve the existing default full-publication contract and missing-role refusal. The held path calls these distinct native stages:

```powershell
$retained = New-AgentsChatStoppedHistoryHandoffLock $scope $descriptor `
    $ControllerPid $ControllerIdentity $AttemptId $OperationId $Token $CreatedAt
if ($HoldAt -cne 'Directory') {
    Publish-AgentsChatStoppedHistoryHandoffLockOwner $scope
}
if ($HoldAt -ceq 'Committed') {
    $committed = Complete-AgentsChatStoppedHistoryHandoffCommit $scope
}
```

  Before announcing readiness, require complete native archive/lock proof. Return a bounded frame containing actual native bridge PID/start identity, attempt, stage, prepared descriptor, directory identity, optional owner descriptor and optional committed descriptor. Keep the bridge scope retained by waiting for controller death through the existing watcher; never add a production hold flag.

- [ ] Extend the history branch with `crash-lock-directory-history`, `crash-lock-owner-history`, `crash-lock-committed-history` and matching resume modes. The crash actor uses the existing production preparation API, publishes and checks the prepared descriptor, closes that preparation bridge, then starts the staged commit fixture with its own exact PID/start identity and original owner scalars. Relay readiness only after checking the returned native bridge identity and stage.

  Preserve the 120-second actor readiness budget and 15-second bridge-exit budget. The host captures the specific bridge process handle before killing the specific Node actor, then waits for that exact bridge to exit. Do not infer death from a closed stdout stream.

- [ ] A distinct resumer checks original state/completion bytes, prepared bytes/hash/dev/ino, exact lock directory identity and exact child inventory. Directory-only means zero children and no committed receipt. Owner means exactly `owner.json`, exact seven owner fields matching prepared, actual descriptor and no committed receipt. Committed additionally means the receipt binds the original prepared descriptor, exact directory/owner descriptors and original actor/bridge identities.

  Require both original actor and native bridge identities to be absent. Ordinary archive opening, ordinary lock acquisition and ordinary release must refuse without changing evidence, including when given the original owner fields. An incomplete directory must remain a blocker, not be interpreted as ownership.

  Before fixture-only cleanup, recheck every retained byte/identity and exact namespace. Remove only the recorded committed file if present, exact owner file if present, now-empty exact lock directory and original prepared file; production gains no cleanup authority from these tests. Continue the existing archive restoration. Assert original state remains unchanged after cleanup.

- [ ] Add three required executed receipts:

```text
PASS: actual handoff directory publisher death preserves an empty exact lock and ordinary refusal
PASS: actual handoff owner publisher death preserves exact prepared owner evidence without committed authority
PASS: actual committed handoff publisher death preserves exact receipt and blocks ordinary continuation
```

- [ ] Commit/push the fixture contracts and dispatch focused history. Download the actual job log and require missing `New-AgentsChatStoppedHistoryHandoffLock` at the new directory boundary, not a timeout or changed older contract.

### Task 2: Split native publication into retained proof stages

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-commit.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock.ps1`

- [ ] Move existing pre-publication request construction, exact prepared pinning, two live binding checks, time check and create-only directory allocation into `New-AgentsChatStoppedHistoryHandoffLock` with the original publisher's scalar signature. Retain the prepared handle, attempt, request and owner in `Context.HistoryHandoffCommit`; retain the directory through existing `HistoryHandoffLock`. Return only a small directory observation. Repeated begin refuses without replacing retained evidence.

- [ ] Move existing create-only owner publication into `Publish-AgentsChatStoppedHistoryHandoffLockOwner(Context)`. Require the independent publisher role, retained commit context, directory-only stage, exact sole prepared namespace, complete live binding and empty exact directory before writing. Retain the owner handle/descriptor, repeat original proof and return only the descriptor. Repeated owner publication refuses and preserves evidence.

- [ ] Move existing immutable committed-record publication into `Complete-AgentsChatStoppedHistoryHandoffCommit(Context)`. Require retained owner stage, exact live binding and directory/owner proof before writing. Preserve the existing root schema, native timestamp checks, two post-publication passes and descriptor-only response. Repeated completion refuses without rewriting.

- [ ] Keep the existing full publisher as the same independent-role entry and compose the stages:

```powershell
$null = New-AgentsChatStoppedHistoryHandoffLock $Context $Descriptor `
    $ControllerPid $ControllerIdentity $AttemptId $OperationId $Token $CreatedAt
$null = Publish-AgentsChatStoppedHistoryHandoffLockOwner $Context
return Complete-AgentsChatStoppedHistoryHandoffCommit $Context
```

  Preserve the existing contextual failure/poisoning convention for every stage. No stage failure deletes directory, pending file, owner, prepared record or receipt. No new JS production capability, saved helper dependency or public command is introduced by this split.

- [ ] Push implementation and dispatch focused history plus Windows Contracts on the same SHA. Verify all previous fourteen receipts and three new actual death receipts. Record run/job/SHA evidence in this plan and push it.

## Executed evidence

- Test-only `45d8df05`: focused run `40428135763`, job `121938941614`,
  failed at the new directory boundary because
  `New-AgentsChatStoppedHistoryHandoffLock` did not exist. The native fixture
  diagnostic, rather than a timeout or missing receipt alone, established red.
- Implementation `98ec82607cc006345bc55252bd65a1e809e13136`:
  focused run `40430192385`, job `121945706424`, and Windows Contracts
  `40430195586`, job `121945715236`, both passed on that exact SHA.
- Actual focused logs contain all seventeen required executed receipts.
  Directory, owner and committed death receipts were emitted at
  `01:20:51Z`, `01:21:37Z` and `01:22:25Z` on 2026-10-27 respectively.
  Each boundary killed its real Node owner and awaited its specific native
  bridge before a distinct resumer checked exact evidence and ordinary refusal.
- Contracts logs confirm the saved-helper closed manifest, native live/dead
  owner checks and strict native JSON binding. All execution was in Actions;
  no local validation or server was used.

## Required subsequent gates

This increment proves interruption and refusal only. It does not implement native dead-owner lock retirement, reopen a committed capability, permit fresh-attempt admission after settlement, write state, start workers or relax public deploy/update. Exact native recovery, state snapshots/transition intents, handoff-aware release and actual application repeat lifecycles remain separate mandatory gates under the approved design.
