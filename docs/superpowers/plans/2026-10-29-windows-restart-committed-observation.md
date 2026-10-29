# Windows Restart Committed Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a distinct read-only native actor prove the eight-record restart history, including the restart committed record and its exact lock directory and owner, after the restart publisher dies — the prerequisite for state continuity verification and dead-owner settlement.

**Architecture:** Extend the committed-handoff observation request with an optional `restartCommitted` descriptor. When present, the old lock is treated as retired (its terminal record is required) and the root `lock` directory must be the restart lock bound by the restart committed record. New observer roles (`HistoryHandoffRestartLockObserver`, `HistoryHandoffRestartCommittedObserver`) satisfy the existing restart lock / committed assertions without publisher roles. The committed creator is bound to the restart prepared owner rather than the observer's own bridge.

**Tech Stack:** PowerShell 7 native modules, `Deployment.WindowsPrivateFile`, Node fixtures, GitHub Actions only.

---

### Task 1: Test contract

**Files:**
- Modify: `tests/deployment-windows-history-handoff-restart-observation.ps1` (optional `restartCommitted`, mutation refusals)
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs` (at `blockedCommitted && !blockedState`: two identical observations, wrong ino and wrong path refused)
- Modify: `.github/workflows/deployment-lifecycle.yml` (receipt)

- [x] Add the distinct committed observation to the `restart-committed-dead-history` resume.
- [x] Require receipt `PASS: distinct restart committed observer proves eight records dead owner and directory without state lock or task authority`.
- [ ] Actions red: missing `windows-stopped-history-handoff-restart-committed-observation.ps1`.

### Task 2: Production

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-committed-observation.ps1`
- Modify: `windows-stopped-history-handoff-committed-observation.ps1` (request key, namespace, old lock retired when restart committed observed)
- Modify: `windows-stopped-history-handoff-restart-observation.ps1` (initialize committed observation before final prepared assertion)
- Modify: `windows-stopped-history-handoff-restart-lock.ps1`, `windows-stopped-history-handoff-lock.ps1`, `windows-stopped-history-handoff-restart-commit.ps1` (observer roles)

- [ ] Observer returns `{status:'restart-committed-observed', attemptId, previousAttemptId, previousOperationId, project, prepared, committed, lockIdentity, lock, runtimeAuthority:false, lockAuthority:false, taskAuthority:false}`.
- [ ] Commit, state intent and state write remain refused for the observer.
- [ ] Actions green with every required receipt; Contracts green.
