# Windows Restart Owner Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After its eighth record (`inactive-handoff-<attempt>-committed.json`) and before any state intent or state write, the exact live restart owner releases only its own committed `lock` (owner file, then directory) through a published release intent and settlement, while the original `state.json`, the eight records and every refusal of ordinary authority stay exact.

**Architecture:** Implements the "exact-owner release" step of `docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md` (Lock and command integration; Validation and delivery gates item 2) for the pre-write case. A new module `scripts/deployment/windows-stopped-history-handoff-restart-release.ps1` runs under the independent role `HistoryHandoffRestartReleaser` on the committer context. It re-runs the full ancestor observation, publishes `inactive-handoff-<restart>-lock-retirement.json` (phase `stopped-history-handoff-restart-release-prepared`), deletes `lock\owner.json` via `RetainForRetirement` and `lock` via `RetainDirectoryForRetirement` (the dead-owner retirement primitives), marks the retained restart lock `Released`, publishes `inactive-handoff-<restart>-lock-retired.json` (phase `stopped-history-handoff-restart-released`), and re-runs the ancestor observation once more. `Assert-AgentsChatStoppedHistoryHandoffRestartLock` accepts the `Released` stage only with the retained release intent and an absent `lock`; the committed namespace adds both new records. The reconciliation report already classifies these suffixes as `lock-settled`.

**Tech Stack:** PowerShell 7 native modules, `Deployment.WindowsPrivateFile`, Node fixtures under `tests/`, GitHub Actions (`deployment-lifecycle.yml`, new stopped-history `release` shard). All validation runs only in GitHub Actions.

---

### Task 1: Test contract (red)

**Files:**
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1` (new `-ReleaseRestart`; requires `-CommitRestart`, refuses `-HoldRestartCommitted` and `-PrepareRestartState`; emits `restart-committed-published` and requires `{"type":"release-restart"}`)
- Create: `tests/deployment-windows-history-handoff-restart-release.ps1`
- Modify: `tests/deployment-windows-restart-publication-progress.ps1/.mjs` (`release` publication)
- Create: `tests/deployment-windows-restart-release-publication.mjs`
- Create: `tests/deployment-windows-restart-release-controller.ps1`
- Modify: `tests/deployment-windows-restart-preparation.mjs` (`releaseRestart`), `tests/deployment-windows-lost-runtime-session.mjs` (`resume-restart-released-history`), `tests/deployment-windows-inactive-task.ps1` (boundary `restart-released-history`, shard `release`)
- Modify: `.github/workflows/deployment-lifecycle.yml` (sixth shard `release`, new required receipt)

- [x] Role refusal `Restart release requires its independent native role.` leaves owner, lock, scope and records unchanged.
- [x] Success: two ancestor proof frames, `lock` absent, original `state.json` hash unchanged, no `state.json.lock*`, prepared and committed bytes unchanged.
- [x] Result `{status:'restart-released', attemptId, prepared, committed, retirement, released, state, runtimeAuthority:false, lockAuthority:false, taskAuthority:false}`; Node verifies both records field-for-field (`createdAt >= committedAt`, `releasedAt >= createdAt`) and identity-pinned descriptors.
- [x] Duplicate refusal `Restart release failed; retain evidence.` poisons the context and preserves both records.
- [x] Ordinary `acquireLock`/`releaseLock` and the plain six-record native rerun remain refused; original state inode and bytes unchanged; namespace is exactly the eight records plus the two release records.
- [x] Boundary `restart-released-history` is the only boundary of shard `release`; the guard requires `restart-state-dead-history` second-last and `restart-released-history` last.
- [x] Receipt `PASS: native live restart owner releases only its exact committed lock before any state write while original state and eight records remain exact without authority`.
- [x] Actions red: release shard fails because `windows-stopped-history-handoff-restart-release.ps1` does not exist.
  Evidence: test contract `f3280d35`, focused run `40876522937`, release shard job `123456655666` failed during `restart-release-before-proof` with "The term ...\windows-stopped-history-handoff-restart-release.ps1 is not recognized".

### Task 2: Production module (green)

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-release.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart-lock.ps1` (accept `Released`)
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1` (namespace adds release records)
- No saved-closure change: restart handoff modules are not part of the saved worker engine closure (same as state-write).

- [ ] Release intent, owner deletion, directory deletion, settlement, second observation; any failure poisons and throws `Restart release failed; retain evidence.`
- [ ] Release refused when a state intent, writer, stage or written state is retained.

### Task 3: Acceptance

- [ ] Focused and Contracts runs green; all six shard logs merged and every required receipt present.
