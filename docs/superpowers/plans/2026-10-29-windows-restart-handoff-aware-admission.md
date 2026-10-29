# Windows Restart Handoff-Aware Inactive Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The exact live restart owner that wrote its acknowledged next preflight state and still holds its committed `lock` can publish inactive task admission (`task-maintenance/admission.json`) only through a handoff-aware path. That path verifies the full stopped-history handoff chain with the shared native verifier. Copied, foreign, ordinary and duplicate admission stay refused.

**Architecture:** Continues `docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md`. The spec's "Lock and command integration" section asks for explicit handoff-aware internal paths that share one verifier, and says that subsequent states use existing transaction checks.

Admission must run inside the native inactive-scope worker (`windows-managed-task-controller.ps1 -Inactive`). Downstream inactive transactions rely on the `Admission*` context that `New-AgentsChatManagedTaskAdmission` sets there.

The new worker method `capture-handoff-admission` opens the restart-state observation (`Open-AgentsChatStoppedHistoryHandoffRestartStateObservation`) in a new **owner-admission** mode before publication, then rechecks the retained proof handles and live owner after publication.

Earlier observers require every prior actor to be dead. Owner-admission mode accepts the observer's controller only when it is the exact live restart owner. That owner's pid and identity must match three things: the restart prepared `newOwner`, the committed creator, and the state-intent creator. The publisher bridges must still be absent and not the current process.

**Tech Stack:** Node fixtures under `tests/`, `scripts/deployment/windows-managed-task.mjs`, the native PowerShell controller and handoff modules, GitHub Actions (`deployment-lifecycle.yml`, stopped-history `commitment` shard, whose last boundary is `restart-state-written-history`). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

**Files:**
- Modify: `tests/deployment-windows-restart-preparation.mjs` (`refuseAdmission` block, `restartHandoff` capture, PASS line)
- Modify: `.github/workflows/deployment-lifecycle.yml` (one receipt, 68 total)
- Modify: `tests/deployment-windows-inactive-task.ps1` (fresh history actor takeover budget 600 s; native handoff verification adds multi-pass ancestor checks)

- [x] Copied handoff evidence must be refused, each case in a fresh inactive scope. The three cases are a written `restartState` with the wrong digest, a `restartCommitted` swapped for the original committed record, and a missing `restartStateIntent`. In each case ordinary admission is still refused, handoff admission rejects with `DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED`, and no `task-maintenance` exists afterwards.
- [x] A foreign lock token is refused before any native request.
- [x] The valid handoff admission returns exactly `{admission, sha256}`, and `task-maintenance` contains only `admission.json`. The record equals `createWindowsInactiveTaskAdmissionRecord({observation, lock: owner, state: writtenState})`. `assertWindowsInactiveTaskAdmissionBinding` returns the validated written state.
- [x] After publication, ordinary and duplicate handoff admission are both refused, and the admission bytes are unchanged.
- [x] Receipt `PASS: handoff-aware inactive admission publishes only the exact live restart owner written preflight binding through the shared native verifier while copied foreign ordinary and duplicate admission remain refused`.
- [ ] Actions red: `commitment` shard fails because `captureWindowsInactiveTaskHandoffAdmission` is not exported.

### Task 2: Native owner-admission verifier

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart.ps1` (`Test-AgentsChatStoppedHistoryHandoffRestartOwnerAdmitter`, `Assert-AgentsChatStoppedHistoryHandoffRestartOwnerCreator`, live owner record in `Get-AgentsChatStoppedHistoryHandoffRestartBinding`)
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart-commit.ps1`, `scripts/deployment/windows-stopped-history-handoff-restart-state-intent.ps1` (owner-admitter creator branch)
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1` (`restartOwnerAdmission` request field, only with written restart state; sets `HistoryHandoffRestartOwnerAdmitter`)
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart-observation.ps1`, `scripts/deployment/windows-stopped-history-handoff-restart-state-observation.ps1` (`-OwnerAdmission` switch)
- Create: `scripts/deployment/windows-stopped-history-handoff-admission.ps1` (`Open-` / `Assert-AgentsChatStoppedHistoryHandoffAdmissionProof`, plus `Assert-AgentsChatStoppedHistoryHandoffAdmissionProofRetained` for the post-publication recheck, because the new `task-maintenance` entry is outside the stopped cleanup inventory)

- [ ] Owner-admission mode turns on only through the `restartOwnerAdmission` request field, and only when written restart state is present. Every check repeats all of these conditions:
  - the restart owner is live;
  - it equals the observer controller;
  - it is not the native process;
  - it is an observer, not a preparer or publisher.
- [ ] Other observers keep the existing absent-actor checks unchanged.
- [ ] The proof binds three things: the observed restart lock owner digest, the written state digest, and the live controller.

### Task 3: Worker and JS admission

**Files:**
- Modify: `scripts/deployment/windows-managed-task-controller.ps1` (`capture-handoff-admission` inactive method with `handoff`; loads `WindowsPrivateFile.SourceSecurity.cs` and the admission module)
- Modify: `scripts/deployment/windows-task-admission.ps1` (`-Handoff`: inactive only; handoff evidence present if and only if `-Handoff`; full proof verified before publication, retained proof handles and live owner rechecked after publication and closed in `finally`)
- Modify: `scripts/deployment/windows-managed-task.mjs` (`captureWindowsInactiveTaskHandoffAdmission`, strict handoff descriptor validation, duplicate publication refusal, written state digest pre-check, 300 s native budget)

- [ ] Ordinary admission without handoff evidence is unchanged.
- [ ] Actions green, with all ten shard logs merged and all 68 receipts present.

## Redesign: Handoff-Aware Inactive Inspection (contract run 40933139938)

The first contract run's `commitment` shard printed:

```
INACTIVE_HANDOFF_BUNDLE {"bundle":"...-inactive-control\\inactive-rollback-runtime-evidence",
  "entries":[..., "configuration.json", "runtime-3100-639288961101249953.json", ...]}
Managed task observation refused: managed-task-open. Inactive task requires exactly one original readiness record and no guarded launch.
```

The proved prepared record's `observation.configuration` names the relocated physical bundle, which holds exactly
one readiness record. The unchanged task action still names the original `inactive-rollback-runtime` bundle,
whose readiness was relocated, so ordinary inspection refuses before any admission. Gate 61's ordinary-admission
refusal is therefore unreachable after a released rollback, and gate 62 must inspect through the handoff proof.

### Contract changes

- `tests/deployment-windows-restart-preparation.mjs`: ordinary `inspectWindowsInactiveTask` must reject with
  `DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED`; `open()` uses
  `inspectWindowsInactiveTaskHandoff({ taskName, project, pwsh, control, handoff })` and its observation must
  deep-equal `original.observation`. Ordinary admission on that scope must refuse with
  "requires its handoff-aware admission"; copied handoffs must refuse.

### Production changes

- `windows-managed-task.mjs`: export `inspectWindowsInactiveTaskHandoff`; it captures the handoff with a fixed
  descriptor key order, resolves the control root and starts the controller with `-HandoffControl` and a base64
  `-Handoff`. The retained scope remembers the handoff; handoff admission must present the identical handoff and
  ordinary admission on a handoff scope refuses.
- `windows-managed-task-controller.ps1`: with `-HandoffControl`/`-Handoff` (inactive only), open the owner proof via
  `Get-AgentsChatStoppedHistoryHandoffProvedObservation`, then `Open-AgentsChatInactiveTask` with that observation.
  The scope accepts only `check`, `close` and `capture-handoff-admission`, whose raw handoff and control must equal
  the inspection's.
- `windows-stopped-history-handoff-admission.ps1`: shared `Open-AgentsChatStoppedHistoryHandoffOwnerProof`;
  `Get-AgentsChatStoppedHistoryHandoffProvedObservation` reads the proved prepared record's `observation` and
  closes the proof.
- `windows-inactive-task.ps1`: `Open-AgentsChatInactiveTask` accepts an optional proved observation. Its project,
  task name, definition, security descriptor, principal SID and configuration SHA-256 must equal the live task; the
  proved canonical `configuration.json` path then replaces the action path for readiness and repeated assertions.

### Production follow-ups found in Actions

- Handoff evidence is only `inactive-handoff-*.json`. Retired `inactive-rollback-history-{intent,complete}`
  archives persist after ordinary archival and must not force handoff admission (run 40943467695 refused every
  ordinary admission).
- The saved worker engine must ship the full dot-source closure of the controller, including the new admission
  file and the 22 handoff verifiers it loads (run 40946568281 failed with a missing engine file).
- The proved prepared record is read with `-AllowNull`, like the other prepared-record readers (run 40947584248).
- Nested native verifiers compounded two passes per level: one restart retirement observation ran 273 worker
  cleanups and 18603 process checks (62 s, and 300 s timeouts at owner retirement). `Get-AgentsChatVerificationPasses`
  returns one pass when an ancestor call frame is inside another verifier pass loop (located from the parsed
  script extents); outermost verifiers keep two passes, and every inner check still runs inside each outer pass.
  Observations dropped to about 10 s and the takeover, release and postwrite shards passed (run 40953688458).
