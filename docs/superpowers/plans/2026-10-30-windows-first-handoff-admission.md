# Windows First-Attempt Handoff Admission (Gate 74) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handoff-aware inactive admission accepts the exact live first-attempt owner after its gate 73 `preflight` state write, through the shared native verifier. Ordinary, copied, foreign and duplicate admission stay refused.

**Architecture:** Admission today only accepts restart handoffs:
- `Open-AgentsChatStoppedHistoryHandoffOwnerProof` requires the 11 restart fields;
- `captureHandoff` in `windows-managed-task.mjs` requires all 10 restart descriptors.

Gate 74 adds a second, mutually exclusive handoff shape, `{attemptId, prepared, committed, stateIntent, state}`, and dispatches on it.

The first-attempt committed and state observation gains an owner-admission mode, mirroring `Test-/Assert-AgentsChatStoppedHistoryRestartOwner*`. In that mode:
- the owner must be live (`New-AgentsChatStoppedHistoryHandoffOwner`, not the retired owner);
- the committed and state-intent creators equal the controller, and their bridge is absent and is not `$PID`.

The remaining checks are unchanged:
- the `state.sha256` binding against `state.json`;
- the shared verifier;
- the existing inactive transaction.

**Tech Stack:** PowerShell strict native retained proofs; Node.js fixtures; `.github/workflows/deployment-lifecycle.yml`. All validation runs only in GitHub Actions.

---

### Task 1: Contract (expect red)

**Files:**
- Modify: `tests/deployment-windows-history-handoff-commit.ps1`
  - New switch `-WriteState` (non-held). After `-PrepareState` publishes the intent, it calls `Write-AgentsChatStoppedHistoryHandoffState`.
  - The output adds the `state` descriptor; the bridge then exits.
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`, non-held commit path (~line 1447). Pass `-WriteState`, then:
  1. Ordinary `inspectWindowsInactiveTask` admission without the handoff is refused, and nothing is published under `task-maintenance`.
  2. `captureWindowsInactiveTaskHandoffAdmission` is refused for each of these shapes:
     - copied (mixed restart and first-attempt fields);
     - foreign (`state.sha256` altered);
     - stale (`stateIntent.ino` altered).
  3. The exact handoff `{attemptId, prepared, committed, stateIntent, state}` is admitted. `assertWindowsInactiveTaskAdmissionBinding` passes, and a duplicate admission is refused.
  4. Cleanup:
     - `unlink` the published admission;
     - `rmdir` `task-maintenance`;
     - restore the original state bytes;
     - remove the handoff evidence and the lock.
- Modify: `.github/workflows/deployment-lifecycle.yml`
  - Receipt 80: `PASS: handoff-aware inactive admission publishes only the exact live first-attempt owner written preflight binding through the shared native verifier while copied foreign ordinary and duplicate admission remain refused`.

- [ ] Commit, tag `gate74-contract`, dispatch the stopped-history run. Expect red: the handoff shape is refused by `captureHandoff`.

### Task 2: Production

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1` and `windows-stopped-history-handoff-state-observation.ps1`
  - Add an `-OwnerAdmission` switch.
  - With it, swap the retired-owner and creator-absent assertions for live-owner checks:
    - the creator `pid`/`processIdentity` equal the controller;
    - the bridge is absent and is not `$PID`.
- Modify: `scripts/deployment/windows-stopped-history-handoff-observation.ps1`
  - Add a live variant of `RetiredPreparedBinding`, used only when `-OwnerAdmission` is set.
- Modify: `scripts/deployment/windows-stopped-history-handoff-admission.ps1`
  - Dispatch on the exact field set: 11 restart fields, or 5 first-attempt fields. Anything else is refused.
  - `Assert-...AdmissionProof`, `...Retained` and `Get-...ProvedObservation` take the owner from the prepared record of the observed shape.
- Modify: `scripts/deployment/windows-managed-task.mjs`
  - `captureHandoff` accepts either exact descriptor set.
  - `captureTaskAdmission` checks the `state` descriptor's sha256 (first attempt) or `restartState` (restart) against `state.json`.
  - `windowsInactiveTaskHandoffEntries` returns the entries for the captured shape.

- [ ] Commit, tag `gate74-production`, dispatch the stopped-history and Contracts runs on the same SHA. Both must be green, and acceptance must require all 80 receipts.

### Task 3: Acceptance

- [ ] Record the red, green and Contracts run IDs and the SHA here, and tick gate 74 in `2026-10-30-windows-first-handoff-public-routing.md`.
