# Windows Archived Stopped-History Public Update Routing (Gate 76) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The public Windows `update` command recognizes archived stopped history, runs the gate 75 first-attempt admission, and drives the existing inactive task transaction through a dedicated inactive runner. Lock release while handoff evidence exists stays refused; retirement and closeout are gate 77.

**Architecture:**
- `windows-deployment-command.mjs` keeps refusing every blocked status, except one: an `update` whose control directory holds only archived `retired-*-inactive-rollback-history-*` maintenance entries, with no lock, in-flight `inactive-handoff-*`, `task-maintenance`, recovery or worker-retirement evidence. That case routes into a new module, `windows-stopped-history-update-command.mjs`.
- The new module admits through `admitWindowsStoppedHistoryUpdate` under the supplied or a fresh Windows admission. It reads the runtime configuration from the handoff-aware scope, then calls `runWindowsInactiveDeployment` (`windows-inactive-deployment.mjs`).
- The inactive runner drives `runDeployment` like `runWindowsLiveDeployment`, using the inactive primitives:
  - `prepareWindowsInactiveSourceBuild` and `admitWindowsInactiveCompatibility`;
  - `prepareWindowsInactiveRuntimeBundle`;
  - `beginWindowsInactiveTaskTransaction`, then `createWindowsInactiveTaskSnapshot`, then `rotateWindowsInactiveTaskSnapshot`;
  - `prepareWindowsInactiveTaskActivation`, then `replaceWindowsInactiveTask`, then `startWindowsInactiveTask`;
  - `completeWindowsTaskActivation`.
- The handoff-written preflight state is the transaction's preflight, so it is never rewritten. Every refusal or failure keeps the lock, the handoff descriptors and the admission, and marks the error with `handoffRetained` and `operationId`.

**Tech Stack:** Node.js, PowerShell 7 native helpers, GitHub Actions stopped-history matrix. All validation runs in Actions.

---

### Task 1: Contract (expect red)

**Files:**
- Modify: `tests/deployment-windows-inactive-task.ps1`
  - Add a new last boundary, `lock-state-updated-history`, in shard `firstupdate`. Its crash mode is `crash-completed-history` and its resume mode is `resume-lock-state-updated-history`.
  - The handoff writes the shared `state.json`, so this boundary must end its shard.
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
  - Only in `resume-lock-state-updated-history`, after the retained preparation is removed:
    - Public `deploy --revision <missing>` refuses with `DEPLOYMENT_RECOVERY_REQUIRED` and leaves everything untouched.
    - Public `update --revision <missing>` routes, admits and refuses before downtime with `handoffRetained: true` and the lock's `operationId`. After the refusal:
      - the lock owner is this process;
      - the written preflight state is retained;
      - `task-maintenance/admission.json` and the three handoff descriptors remain;
      - `releaseLock` refuses;
      - reconcile reports one `state-transition` attempt;
      - a second public `update` refuses with `DEPLOYMENT_RECOVERY_REQUIRED` and changes nothing.
    - Cleanup removes the new entries, restores the state bytes and sets `firstStateAdmitted`.
- Modify: `.github/workflows/deployment-lifecycle.yml`, adding the shard `firstupdate` and receipt 82.

- [x] Red: only `firstupdate` fails, because update still refuses with `DEPLOYMENT_RECOVERY_REQUIRED`.
  - Red run `41016901261` at `e0f8d5fd` (`gate76-contract`).

### Task 2: Production

**Files:**
- Modify: `scripts/deployment/windows-compatibility.mjs`
  - Add `admitWindowsInactiveCompatibility`. It shares the body and uses `inspectWindowsInactiveWorkerScope` and `inspectWindowsInactiveConfiguration`.
- Create: `scripts/deployment/windows-inactive-deployment.mjs`, the inactive runner described above.
- Create: `scripts/deployment/windows-stopped-history-update-command.mjs`, which does the routing check, admission and runner call.
- Modify: `scripts/deployment/windows-deployment-command.mjs`
  - Accept an optional retained `admission`.
  - Route archived stopped-history `update` before the recovery refusal.
- Modify: `scripts/deployment/saved-worker-engine.mjs` and `tests/deployment-saved-worker.test.mjs`, only if a saved copy needs the new modules.

- First production `8c47a550` (`gate76-production`) still refused in `firstupdate`. Its Contracts run `41017095647` passed.
  - Diagnostic `5b5021b6` (`gate76-diag`) made the refusal report its blocked status and control entries. Run `41020454114` showed that the archived rollback keeps its relocated `inactive-rollback-runtime` and `inactive-rollback-runtime-evidence` directories. The routing predicate treated them as in-flight evidence.
  - Fix `b5f21c60` (`gate76-production2`) excludes exactly those two names from the in-flight pattern.
- [ ] Green stopped-history run (82 receipts) plus a same-SHA Contracts run; record acceptance here.
