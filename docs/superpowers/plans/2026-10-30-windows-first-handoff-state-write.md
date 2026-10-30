# Windows First-Attempt Handoff State Write (Gate 73) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live first-attempt committed publisher writes the `preflight` state from its gate 72 intent. After that writer dies, a distinct actor observes the exact written transition without gaining lock, runtime or admission authority.

**Architecture:** Gate 72 left the first-attempt committed scope holding `HistoryHandoffStateIntent`. Gate 73 generalizes the restart state write (`windows-stopped-history-handoff-restart-state-write.ps1`) and the state-transition bootstrap (`windows-stopped-history-state-transition.ps1`) so that the following parts accept either committed binding (first attempt or restart):
- the staged `state.json.lock` publish;
- the `PublishSourceFile` swap;
- the ninth-record verification.

The phase literal (`stopped-history-handoff-state-intent` or `...-restart-state-intent`) selects the binding. The restart receipts stay byte-identical. Handoff-aware admission of the written first-attempt state is still refused; that belongs to gate 74.

**Tech Stack:** PowerShell strict native retained proofs; Node.js fixtures in `tests/`; `.github/workflows/deployment-lifecycle.yml`. All validation runs only in GitHub Actions.

---

### Task 1: Contract (expect red)

**Files:**
- Modify: `tests/deployment-windows-history-handoff-commit.ps1`
  - New `HoldAt` value `StateWritten`. After `Complete-AgentsChatStoppedHistoryHandoffCommit`, it calls `Publish-AgentsChatStoppedHistoryHandoffStateIntent` and then `Write-AgentsChatStoppedHistoryHandoffState`.
  - The `ready` value adds `stateIntent` and `state` descriptors.
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
  - Optional `-StateIntent*` and `-State*` descriptor parameters, passed through as `stateIntent` and `state` in the observation request.
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
  - `lockStages['crash-lock-state-written-history'] = lockStages['resume-lock-state-written-history'] = 'StateWritten'`.
  - The `lockResume` branch for `StateWritten`:
    - Assert that `state.json` bytes equal the intent's `nextState` raw JSON plus `\n`, and that its identity differs from the original.
    - Observe with the state descriptors and assert `status: 'committed-handoff-state-observed'`, `runtimeAuthority`/`lockAuthority`/`taskAuthority` false.
    - Assert that a replaced `state.json` (same bytes, new inode) is refused.
    - Assert that `openWindowsInactiveRollbackHistoryArchive` and `releaseLock` are refused.
    - Restore the original state bytes and remove the handoff evidence and the lock.
- Modify: `tests/deployment-windows-inactive-task.ps1`
  - Add boundary `lock-state-written-history`, crash mode `crash-lock-state-written-history`, resume mode `resume-lock-state-written-history`.
- Modify: `.github/workflows/deployment-lifecycle.yml`
  - Receipt 79: `PASS: actual first-attempt state writer death preserves the exact written preflight transition for a distinct observer without lock runtime or admission authority`.

- [ ] Commit, tag `gate73-contract`, dispatch the stopped-history run; expect red (missing `Write-AgentsChatStoppedHistoryHandoffState`).

### Task 2: Shared native write and transition

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart-state-write.ps1`
  - Extract `Write-AgentsChatStoppedHistoryHandoffStateBody $Context $Binding`, where `$Binding` has `Label`, `Text` (a scriptblock returning verified next text), `Observe` (a scriptblock that re-observes the committed handoff) and `Record`.
  - The restart wrapper keeps its messages.
- Modify: `scripts/deployment/windows-stopped-history-handoff-state-intent.ps1`
  - Add `Write-AgentsChatStoppedHistoryHandoffState`. It requires `HistoryHandoffLockPublisher`, a retained `HistoryHandoffStateIntent`, and no `HistoryHandoffState`.
- Modify: `scripts/deployment/windows-stopped-history-state-transition.ps1`
  - Accept the request pair `stateIntent`/`state` with phase `stopped-history-handoff-state-intent`, as well as the restart quartet.
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`
  - When `stateIntent` and `state` are present, initialize the transition, pin the intent through `Assert-AgentsChatStoppedHistoryHandoffStateIntent` in observer mode (creator = the dead controller), and report `committed-handoff-state-observed`.

- [ ] Green stopped-history run (79 receipts) plus a same-SHA Contracts run; record acceptance here.
