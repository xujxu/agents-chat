# Windows Restart Releaser Death Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the exact live restart owner has released its committed `lock` (gate 49: ten records, `lock` absent, original `state.json` untouched), the releaser actually dies; a distinct observer must preserve the ten records and the original state, receive no lock, runtime or task authority, and refuse to continue.

**Architecture:** Continues `docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md` (Validation and delivery gates item 2, interruption after exact-owner release). The live release from gate 49 is held (`-HoldRestartReleased`, marker `INACTIVE_HISTORY_RESTART_RELEASED_HELD`), the bridge and actor are killed by `tests/deployment-windows-restart-directory-death.ps1 -Released` (crash mode `crash-restart-released-history`), and boundary `restart-released-dead-history` resumes through `assertSuccessorAbandonedAfterDeath({ blockedReleased: true })`. The ordinary restart-prepared observer must refuse with `Retired prepared handoff namespace differs.`, the committed observer must refuse with `Restart committed observation failed; retain evidence.`, and ordinary reconciliation reports the restart attempt as `lock-settled` with records `prepared, committed, lock-retirement, lock-retired` while staying blocked.

**Tech Stack:** PowerShell 7 native modules, Node fixtures under `tests/`, GitHub Actions (`deployment-lifecycle.yml`, stopped-history `release` shard). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

**Files:**
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1` (`-HoldRestartReleased`, requires `-ReleaseRestart`)
- Modify: `tests/deployment-windows-history-handoff-restart-release.ps1` (`-Continue` returns the result before the duplicate refusal)
- Modify: `tests/deployment-windows-restart-release-publication.mjs` (consume the held `ready` frame)
- Modify: `tests/deployment-windows-restart-preparation.mjs` (`holdReleased`, held descriptors `restartRelease`/`restartReleased`)
- Modify: `tests/deployment-windows-restart-directory-death.ps1` (`-Released`)
- Modify: `tests/deployment-windows-inactive-task.ps1` (boundary `restart-released-dead-history`, last in shard `release`)
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`, `tests/deployment-windows-successor-abandoned-observation.mjs` (`blockedReleased`)
- Modify: `.github/workflows/deployment-lifecycle.yml` (two receipts)

- [x] Releaser death verified: release records hashed, `lock` absent, no `state.json.lock*`, state hash unchanged.
- [x] Distinct observer: ten exact records, original state, `lock` ENOENT, both refusals, reconciliation `lock-settled` and blocked.
- [x] Receipts `PASS: actual restart releaser death after exact lock release preserves ten records and original state for a distinct observer without authority` and `PASS: ordinary reconciliation reports the released restart attempt as lock-settled while staying blocked without authority`.
- [ ] Actions: focused and Contracts runs on the contract commit. Production code from gate 49 is expected to already refuse, so a first green run is accepted; any failure is diagnosed from the release shard log.

### Task 2: Acceptance

- [ ] Focused and Contracts runs green; all six shard logs merged and every required receipt present.
