# Windows First-Attempt Handoff Closeout (Gate 77) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The public completed closeout (`closeCompletedWindowsDeployment`) closes out an accepted update of a stopped task that was admitted through the first-attempt stopped-history handoff. Its deployment retirement also retires the three handoff records (`inactive-handoff-<attempt>-{state-intent,committed,prepared}.json`) before the lock.

**Architecture:**
- `windows-completed-closeout.mjs` gains an inactive branch for `priorRuntime: 'stopped'` and phase `accepted`. It requires operation `update`, previous phase `activating` and no error code. The branch:
  1. opens the inactive completion proof;
  2. prepares the inactive task retirement intent and checkpoint;
  3. retires each task receipt through `openWindowsInactiveTaskRetirement`;
  4. begins inactive deployment retirement.

  It resumes from `task-retirement-checkpoint.json` or `worker-retirement.json` when either is present.
- Native deployment retirement uses manifest version 4 when handoff records exist. Version 4 places the exact first-attempt triple after `worker-operation.ndjson` and before `task-retirement.json`. Each record is bound to the committed record's new owner, its lock identity and its lock descriptor, and requires the inactive scope. Without handoff records the manifest stays at version 3.
- The JavaScript manifest reader accepts version 3 or 4 and verifies the triple in place.
- Restart-ladder handoff sets are not the first-attempt triple, so they stay refused.

**Tech Stack:** Node.js, PowerShell 7 native helpers, GitHub Actions stopped-history matrix. All validation runs in Actions.

---

### Task 1: Contract (expect red)

**Files:**
- Create: `tests/deployment-windows-first-handoff-closeout.mjs`
  - `acceptFirstHandoffUpdate` admits through `admitWindowsStoppedHistoryUpdate`, then:
    1. saves and creates the worker operation;
    2. publishes the runtime bundle;
    3. drives the inactive transaction through snapshot, rotation, activation, replacement and start;
    4. waits for readiness;
    5. records `accepted` through `completeWindowsTaskActivation`;
    6. seals the workers.

    It then closes its authority and publishes a context file in the temp directory.
  - `assertFirstHandoffCloseout` asserts in a distinct actor that the owner is dead, the runtime is alive and the accepted state digest is exact. It then calls `closeCompletedWindowsDeployment` and requires that:
    - no handoff records, lock, `task-maintenance`, worker evidence or retirement markers remain;
    - the accepted state bytes and the runtime are unchanged.

    It finally restores the archived fixture: it stops the task, re-registers the original disabled definition, restores the health mode, removes leftovers and restores the original state bytes.
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
  - Mode `resume-lock-state-closed-history` runs the acceptance and defers.
  - The same mode with terminal step `first-closeout` runs the closeout first and then the archive assertions with `firstStateAdmitted`.
- Modify: `tests/deployment-windows-inactive-task.ps1`
  - Add a new last boundary, `lock-state-closed-history`, in shard `firstcloseout`, with crash mode `crash-completed-history`.
  - After the resume actor exits, start a distinct `first-closeout` actor.
- Modify: `.github/workflows/deployment-lifecycle.yml`, adding the shard `firstcloseout` and two receipts.

- [x] Red: `firstcloseout` fails (`firstupdate` also fails, because the contract SHA predates the gate 76 routing fix).
  - Red run `41021102135` at `8ff0baa3` (`gate77-contract`).
  - The fixture stopped before closeout: `prepareWindowsInactiveRuntimeBundle` refused, because the routed admission had already published `task-maintenance`. The inactive runner calls it at preflight in the same order, so this is a production defect as well.

### Task 2: Production

**Files:**
- Modify: `scripts/deployment/windows-completed-closeout.mjs` (inactive accepted branch).
- Modify: `scripts/deployment/windows-deployment-retirement-evidence.ps1`
  - Add `Get-AgentsChatDeploymentHandoffEvidence`.
  - Emit manifest version 4 with the handoff triple.
- Modify: `scripts/deployment/windows-deployment-retirement.ps1` (allow-list, version 4 plan validation and inventory).
- Modify: `scripts/deployment/windows-deployment-retirement-record.mjs` (version 4 parsing).
- Modify: `scripts/deployment/windows-runtime-publication.mjs`
  - Inactive publication accepts the routed `admission` and `sha256`.
  - It verifies the retained binding and that `task-maintenance` holds only `admission.json`, and excuses only that entry.
- Modify: `scripts/deployment/windows-inactive-deployment.mjs` to pass the routed admission at preflight.
- Modify: `scripts/deployment/windows-task-completion-controller.ps1` and `windows-task-completion-proof.mjs`
  - New same-bridge transfer `begin-inactive-retirement` (`beginWindowsInactiveTaskRetirement`), mirroring the active `begin-retirement`.
  - Run `41024351479` (`1947baff`) accepted the update, but the closeout then closed its proof and reopened retirement from the same controller. The native creator check correctly refused, because the intent's creator controller was still alive. Only a distinct resumer reopens a published checkpoint.
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
  - Run `41026540956` (`135b2686`) printed the closeout PASS.
  - The same distinct actor then reran the generic identity-pinned archive closeout and got "Original retirement evidence was replaced". The closeout had already replaced the original `state.json` inode.
  - Distinct first-attempt actors now skip that rerun. Their later checks already assert that the archive opener refuses.

- [x] Green stopped-history run plus a same-SHA Contracts run; record acceptance here.
  - **Accepted** with gate 78: stopped-history run `41033112568` (all 16 shards; acceptance job `123998684210` required every shard receipt) and same-SHA Contracts run `41033116421`, both green at `6fb7e7dd` (tag `gate78-production4`).
