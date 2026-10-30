# Windows Stopped-History Public Repeat Update and Rollback (Gate 78) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real public `update.ps1` of archived stopped history is accepted, publishes its deployment receipt and finalizes. A public rollback update and a repeat update of the now running task then also accept with fresh receipts, and the history archive stays exact.

**Architecture:**
- The inactive runner (`windows-inactive-deployment.mjs`) adds a `publish-receipt` stage after its accepted transaction is sealed. It mirrors the live runner:
  1. inspects the accepted managed task with `inspectWindowsManagedTask`;
  2. opens its configuration with `inspectWindowsConfiguration`;
  3. captures acceptance with `captureWindowsDeploymentAcceptance`;
  4. publishes `deployment.json` with `publishDeploymentReceipt`.

  It reports `closeoutRequired` only after the receipt is published. The public supervisor then runs the finalize entry, which closes out through the gate 77 inactive branch.
- Native deployment retirement inventories do not include `deployment.json`, so the receipt survives closeout like a live update's receipt.
- After closeout the task is running, so the next public update uses the live runner. The retired history archives stay untouched as unrelated control files.

**Tech Stack:** Node.js, PowerShell 7 public entry and supervisor, GitHub Actions stopped-history matrix. All validation runs in Actions.

---

### Task 1: Contract (expect red)

**Files:**
- Create: `tests/deployment-windows-first-handoff-repeat.mjs`
  - `writeFirstHandoffRepeatContext` names the fixture project and task for a distinct actor.
  - `assertPublicHandoffRepeatUpdate` runs without Windows admission. It drives `scripts/update.ps1 -Revision <rev> -Json` three times: forward, rollback, then forward again. The revisions are chosen from `main` and `main~1` of the fixture source repository, and the first differs from `HEAD`.
  - Each run must report `accepted` with `closeoutStatus: completed`, and must leave no lock, handoff records, task maintenance or workers. `state.json` must name the revision, `deployment.json` must hold the operation id and `identity.source`, and Git `HEAD` must equal the revision.
  - Run order and expectations:
    1. The first run has `priorRuntime: stopped`.
    2. The rollback run has `priorRuntime: running`, `sourceCommit` equal to the forward revision, and a fresh backup.
    3. The repeat run must have a fresh operation id.
  - Both retired history archives keep their exact bytes.
  - The `finally` block restores the fixture:
    - the task is stopped, re-registered from its original definition and left disabled;
    - Git `HEAD`, `health-mode` and the original state bytes are restored;
    - new control entries and the controller capture parent are removed.
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
  - Mode `resume-lock-state-repeated-history` writes the context and defers.
  - The `first-repeat` step runs the assertion before taking Windows admission.
- Modify: `tests/deployment-windows-inactive-task.ps1`
  - Adds boundary `lock-state-repeated-history` and shard `firstrepeat`, which is now the last boundary.
  - Shifts the shard index checks.
  - Starts a distinct `first-repeat` actor with a 60-minute timeout.
- Modify: `.github/workflows/deployment-lifecycle.yml`
  - Adds the `firstrepeat` matrix shard, its required shard file and its PASS receipt.

- [ ] Commit the contract with `[skip ci]`, tag `gate78-contract` and dispatch the stopped-history run. Expect `firstrepeat` to fail: the first public update reports `handoffRetained` and no receipt.

### Task 2: Production

**Files:**
- Modify: `scripts/deployment/windows-inactive-deployment.mjs`
  - Adds the `publish-receipt` stage after `seal()` when the state is `accepted`.
  - Closes the accepted task and configuration observations with the other retained authorities.
  - Sets `closeoutRequired` on failure only after the receipt is published.

- [ ] Commit, tag `gate78-production` and dispatch the stopped-history and Contracts runs at the same SHA. All 16 shards must be green, including `firstrepeat`.

### Task 3: Regression matrix and documentation

- [ ] Dispatch the latest same-SHA Linux and Windows regression matrix (default workflow inputs) and record the run IDs.
- [ ] Update the user-facing deployment docs: public `update` of archived stopped history, its receipt and closeout, and that rollback is a public `update -Revision <older>`.
- [ ] Record acceptance here and in the block 3 routing plan.

## Red run finding (41027478918)

The first public `update.ps1` returned `DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED` before any handoff evidence existed.
The public context always resolves the canonical sibling control `.<project>.deployment`, while the history harness used
`<project>-inactive-control`; the public command therefore saw an empty control and took the running-task path. The
`firstrepeat` shard now creates its fixture control at the canonical location, and the test keeps its context file and
working directory beside (not inside) the control used as actor `TEMP`.
