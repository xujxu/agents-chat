# Windows First-Attempt Update Admission Composition (Gate 75) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One production call admits a fresh `update` against archived stopped history. It runs the full first-attempt handoff and returns the handoff-aware inactive scope, the live lock owner, the handoff descriptors and the published admission.

**Architecture:** Gates 70–74 proved each step only through test harnesses. A new module `scripts/deployment/windows-stopped-history-update-admission.mjs` composes the existing production primitives:
1. the retained preparation bridge (`openWindowsStoppedHistoryHandoffPreparation`);
2. a new one-shot native controller `windows-stopped-history-handoff-commit-controller.ps1`, which runs lock, owner, commit, state intent and preflight write for the live controller, then exits;
3. `inspectWindowsInactiveTaskHandoff`;
4. `captureWindowsInactiveTaskHandoffAdmission`.

No new authority is introduced. Lock release stays refused while handoff evidence exists, and public command routing stays refused until gate 76.

**Tech Stack:** Node.js bridge, PowerShell 7 native controller, GitHub Actions stopped-history matrix. All validation runs in Actions.

---

### Task 1: Contract (expect red)

**Files:**
- Modify: `tests/deployment-windows-inactive-task.ps1`
  - Add a new last boundary `lock-state-routed-history` in shard `firstroute`. Its crash mode is `crash-completed-history` and its resume mode is `resume-lock-state-routed-history`.
  - The write replaces the shared original `state.json` inode, so the boundary must end its shard.
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
  - In the non-held first-attempt path, only in `resume-lock-state-routed-history`, after the retained preparation is removed:
    - `admitWindowsStoppedHistoryUpdate` refuses a copied admission, an aborted signal and a foreign project, leaving no handoff evidence, no lock and unchanged state.
    - The exact call returns `{scope, lock, handoff, admission, sha256}`:
      - `lock` equals `lock/owner.json` and the live process;
      - `handoff` is `{attemptId, prepared, committed, stateIntent, state}`, and `state.sha256` matches the written `state.json`, the preflight `nextState`;
      - the admission record equals `createWindowsInactiveTaskAdmissionRecord`, and the binding verifies;
      - `releaseLock` refuses;
      - reconciliation reports `blocked` with the attempt status `state-transition`.
    - Cleanup restores the original bytes.
- Modify: `.github/workflows/deployment-lifecycle.yml`
  - Add `firstroute` to the matrix and aggregation lists.
  - Receipt 81: `'PASS: production stopped-history update admission composes preparation commit state intent preflight write and handoff-aware admission for one live owner while lock release with handoff evidence remains refused'`.

- [x] Commit, tag `gate75-contract`, dispatch stopped-history. Expect `firstroute` to fail on the missing module, with every other shard green.

### Task 2: Production

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-commit-controller.ps1`
  - Watch the controller, then open `-HistoryArchive` with `HistoryHandoffLockPublisher`.
  - Run `Publish-AgentsChatStoppedHistoryHandoffCommitted`, then `Publish-AgentsChatStoppedHistoryHandoffStateIntent`, then `Write-AgentsChatStoppedHistoryHandoffState`.
  - Print `{committed, stateIntent, state}` and close the scope.
- Create: `scripts/deployment/windows-stopped-history-update-admission.mjs`: `admitWindowsStoppedHistoryUpdate({project, control, taskName, pwsh, admission, signal})`.
  - Refusal code: `DEPLOYMENT_WINDOWS_HANDOFF_ADMISSION_REFUSED`, with `recoveryAllowed: false`. All evidence is retained.
- Modify: `scripts/deployment/saved-worker-engine.mjs` and `tests/deployment-saved-worker.test.mjs`: add both files to the saved helper list.

- [x] Commit, tag `gate75-production`. Run a green stopped-history run (81 receipts) plus a same-SHA Contracts run, and record acceptance here.
  - Red: run `41014976295` (tag `gate75-contract2`, `4cb2ca10`) failed only in `firstroute`.
  - **Accepted**: stopped-history run `41014979196` (acceptance job `123940031797`) and same-SHA Contracts run `41014982736`, both green at `a7154557` (tag `gate75-production2`).
