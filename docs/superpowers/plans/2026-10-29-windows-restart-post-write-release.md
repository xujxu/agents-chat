# Windows Restart Post-Write Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live restart owner that published its ninth record (`-state-intent.json`) and wrote `state.json` from it releases only its exact committed lock (`lock\owner.json` then `lock`) and publishes the tenth and eleventh records (`-lock-retirement.json`, `-lock-retired.json`), which bind the exact `stateIntent` and `writtenState` descriptors in addition to the original state. The release must not grant runtime, lock, or task authority. A duplicate release is refused, and the scope is poisoned.

**Architecture:** `Remove-AgentsChatStoppedHistoryHandoffRestartLock` stops refusing a completed write. It still refuses an intent without a write, a retained stage, or a different writer. After a completed write, the writer scope lazily installs `HistoryStateTransition` from the retained intent and written descriptors. Existing original-state readers (`Open-AgentsChatStoppedHistoryState`, the generic successor-abandoned observation) then resolve the original state only through the ninth record, the same way fresh state observers do. `Get-AgentsChatStoppedHistoryHandoffRestartReleaseRecord` re-asserts the intent and the written file, and appends `stateIntent` and `writtenState` to both records. The release result also reports them.

**Test boundary:** New task boundary `restart-state-released-history` (resume mode `resume-restart-state-released-history`). It runs intent → write → release in one live owner. Because it replaces the shared original state inode, it ends the list and runs in its own `completion` shard.

**Tech Stack:** PowerShell 7 native modules, Node test actors, GitHub Actions `deployment-lifecycle.yml` (validation only in Actions).

---

### Task 1: Test contract (red)

**Files:** `tests/deployment-windows-inactive-task.ps1`, `tests/deployment-windows-lost-runtime-session.mjs`, `tests/deployment-windows-restart-preparation.mjs`, `tests/deployment-windows-restart-release-publication.mjs`, `tests/deployment-windows-restart-state-write-publication.mjs`, `tests/deployment-windows-restart-release-controller.ps1`, `tests/deployment-windows-history-handoff-committed-observation.ps1`, `tests/deployment-windows-history-handoff-restart-release.ps1`, `.github/workflows/deployment-lifecycle.yml`

- [ ] **Step 1:** Add the boundary, the `completion` shard, and the `-StateWritten` controller mode. Add the `restart-state-written-published` continuation frame and the post-write release in the host fixture. Release-helper state-binding checks, the Node record bindings, and one receipt (61 total).
- [ ] **Step 2:** Dispatch focused validation on a tag. Expected: the `completion` shard fails because production refuses `Restart release follows a state transition.`; the other shards are unaffected.

### Task 2: Post-write release (green)

**Files:** `scripts/deployment/windows-stopped-history-handoff-restart-release.ps1`

- [ ] **Step 1:** Implement the production changes described in Architecture.
- [ ] **Step 2:** Dispatch focused validation and Contracts. Expected: all seven shards and acceptance succeed.

### Task 3: Acceptance

- [ ] **Step 1:** Merge all shard logs and compare actual `PASS:` receipts with the workflow list at the validated SHA.
- [ ] **Step 2:** Record run IDs and commit the acceptance.
