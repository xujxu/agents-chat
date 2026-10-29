# Windows Post-Write Restart Releaser Death Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the exact live restart owner has written its acknowledged next state and released its committed `lock` (gate 57: eleven records, written `state.json`, `lock` absent), the releaser actually dies; a distinct observer must preserve the eleven records and the written state, receive no lock, runtime or task authority, and refuse to continue.

**Architecture:** Continues `docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md` (Validation and delivery gates item 2, interruption after exact-owner release). The post-write release from gate 57 is held (`-HoldRestartReleased` with `-WriteRestartState`, marker `INACTIVE_HISTORY_RESTART_RELEASED_HELD`), the bridge and actor are killed by `tests/deployment-windows-restart-directory-death.ps1 -State -Released` (crash mode `crash-restart-state-released-history`), and boundary `restart-state-released-dead-history` resumes through `assertSuccessorAbandonedAfterDeath({ blockedState: true, blockedReleased: true })`. The generic reader must refuse on the written state's missing archive intent, the restart state observer must refuse with `Restart state observation failed; retain evidence.`, and ordinary name-only reconciliation reports the restart attempt with records `prepared, committed, lock-retirement, lock-retired, state-intent` as `state-transition` while staying blocked on the written state's operation. The boundary writes state, so it runs alone in the new `postwrite` shard.

**Tech Stack:** PowerShell 7 native modules, Node fixtures under `tests/`, GitHub Actions (`deployment-lifecycle.yml`, stopped-history `postwrite` shard). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

**Files:**
- Modify: `tests/deployment-windows-restart-directory-death.ps1` (`-State -Released`, release command `-StateWritten`, written-state check)
- Modify: `tests/deployment-windows-lost-runtime-session.mjs` (modes `crash-restart-state-released-history`, `resume-restart-state-released-dead-history`)
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs` (`blockedState` with `blockedReleased`)
- Modify: `tests/deployment-windows-inactive-task.ps1` (boundary `restart-state-released-dead-history`, shard `postwrite`)
- Modify: `.github/workflows/deployment-lifecycle.yml` (shard `postwrite`, two receipts, 63 total)

- [x] Releaser death verified: eleven records hashed, `lock` absent, no `state.json.lock*`, `state.json` equals the held written-state hash and differs from the original.
- [x] Distinct observer: release records bind `stateIntent` and `writtenState`, release intent not before the state intent, both observers refuse, reconciliation `state-transition` and blocked, eleven snapshots exact.
- [x] Receipts `PASS: actual post-write restart releaser death preserves eleven records and written state for a distinct observer without authority` and `PASS: ordinary reconciliation reports the post-write released restart attempt as a state transition while staying blocked without authority`.
- [ ] Actions: focused and Contracts runs on the contract commit. Gate 57 production is expected to already refuse, so a first green run is accepted; any failure is diagnosed from the `postwrite` shard log.

### Task 2: Acceptance

- [ ] Focused and Contracts runs green; all eight shard logs merged and every required receipt present.
