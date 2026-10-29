# Windows Restart State Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a distinct read-only native actor prove the nine-record restart history after the restart state writer dies. The actor must resolve the original `state.json` only through the ninth record's immutable `oldState` and prove the exact written next state. This is the state-continuity prerequisite for dead-owner settlement and reconciliation.

**Architecture:** The committed-handoff observation request gains an optional `restartStateIntent` and `restartState` pair. Before archival recovery begins, `Open-AgentsChatStoppedWorkerCleanup` arms one explicit transition (`HistoryStateTransition`) from the intent, after checking all of these:
- the `oldState` digest equals the intent's original state descriptor;
- the retained current `state.json` has a different identity;
- its bytes are exactly `nextState` + LF.

Every historical read of the original state goes through `Open-AgentsChatStoppedHistoryState`. Those reads are archival recovery, rollback cleanup, the prepared binding, the previous `updatedAt` and the state intent record. Without a transition, the helper behaves exactly as before. With one, it serves only the exact original descriptor, as an immutable snapshot, and re-checks the retained written file on every read. A new `HistoryHandoffRestartStateObserver` role satisfies the state intent assertion. In that role the intent creator is bound to the dead restart owner rather than to the observer.

**Tech Stack:** PowerShell 7 native modules, `Deployment.WindowsPrivateFile`, Node fixtures, GitHub Actions only.

---

### Task 1: Test contract

**Files:**
- Modify: `tests/deployment-windows-history-handoff-restart-observation.ps1`. Accepts optional `restartStateIntent`/`restartState` (both required together) and requires refusal of the state intent and state write mutations.
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs`. In `blockedState`:
  - committed-only observation is refused;
  - two identical state observations succeed;
  - intent-only observation is refused;
  - each of these is refused: a wrong written ino, the original state descriptor offered as current, a wrong intent path and a wrong intent ino.
- Modify: `.github/workflows/deployment-lifecycle.yml` (receipt)

- [x] Add the distinct state observation to the `restart-state-dead-history` resume.
- [x] Require receipt `PASS: distinct restart state observer resolves original state only through its ninth record and proves the exact written state without lock or task authority`.
- [x] Actions red (deviation): run `40837753938` at `614e3c11` failed before the observer module was reached because the written/dead state boundaries returned early and skipped archive restoration (`inactive-rollback-history-intent.json` missing at `tests/deployment-windows-inactive-task.ps1:1078`). `bdd528b6` replaced the early return with a required generic archive refusal; the production module (`7e18dc4f`) was already committed, so the module-missing red was not separately observed.

### Task 2: Production

**Files:**
- Create: `scripts/deployment/windows-stopped-history-state-transition.ps1` (transition, snapshot, `Open-AgentsChatStoppedHistoryState`)
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-state-observation.ps1`
- Modify:
  - `windows-inactive-worker-cleanup.ps1` (arms the transition before archival recovery);
  - `windows-inactive-history-recovery.ps1`, `windows-inactive-rollback-cleanup.ps1`, `windows-stopped-history-handoff-record.ps1`, `windows-stopped-history-handoff-restart-state-intent.ps1` (state reads through the resolver);
  - `windows-stopped-history-handoff-committed-observation.ps1`, `windows-stopped-history-handoff-restart-observation.ps1` (request keys, namespace, observer initialization);
  - `windows-stopped-history-handoff-restart-state-intent.ps1` (intender XOR observer).

- [ ] The observer returns `{status:'restart-state-observed', attemptId, previousAttemptId, previousOperationId, project, prepared, committed, stateIntent, state, lockIdentity, lock, runtimeAuthority:false, lockAuthority:false, taskAuthority:false}`.
- [ ] The writer path still opens the real original state; no global state path substitution.
- [ ] Actions green with every required receipt; Contracts green.
