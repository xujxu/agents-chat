# Windows Restart Lock Partial Retirement Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a distinct owner retirer deleted only the dead restart owner file and exited, a fresh distinct observer reopens the partially retired lock from the exact retirement intent, reports `restart-lock-retirement-owner-retired`, and with the independent directory-retirement role deletes only the exact empty lock directory.

**Architecture:** `Open-AgentsChatStoppedHistoryHandoffRestartLockObservation` accepts an empty exact lock directory only when the request carries `restartRetirement`; it retains the committed owner descriptor, marks `OwnerRetired`, and holds `HistoryHandoffRestartOwnerRetiredPending` until `Initialize-…RestartRetirementObservation` binds the intent. `Assert-AgentsChatStoppedHistoryHandoffRestartLock` accepts the owner-retired stage only with that pending marker or the retained intent, and a directory-retired stage only with `HistoryHandoffRestartDirectoryRetirer` and the retained intent. A new module `windows-stopped-history-handoff-restart-retirement-directory.ps1` adds `Remove-AgentsChatStoppedHistoryHandoffRestartLockDirectory` (`RetainDirectoryForRetirement`, controller identity recheck, idempotent repeat). The observation reports `restart-lock-retirement-directory-retired`.

**Tech Stack:** PowerShell 7 native modules, Node test actors, GitHub Actions `deployment-lifecycle.yml` (validation only in Actions).

---

## File Structure

- Modify `scripts/deployment/windows-stopped-history-handoff-restart-committed-observation.ps1`: owner-retired takeover bootstrap.
- Modify `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`: pass the retirement request to the lock bootstrap.
- Modify `scripts/deployment/windows-stopped-history-handoff-restart-lock.ps1`: owner-retired and directory-retired branches.
- Modify `scripts/deployment/windows-stopped-history-handoff-restart-retirement.ps1`: clear the pending marker; directory-retired status.
- Create `scripts/deployment/windows-stopped-history-handoff-restart-retirement-directory.ps1`.
- Modify `tests/deployment-windows-history-handoff-restart-observation.ps1`: `retireDirectory` request; refusal without role, then deletion and an identical repeat.
- Modify `tests/deployment-windows-restart-retirement-death.mjs`, `tests/deployment-windows-successor-abandoned-observation.mjs`, `.github/workflows/deployment-lifecycle.yml` (57 receipts).

### Task 1: Test contract (red)

- [ ] **Step 1:** Add the takeover observation, directory retirement and receipt.
- [ ] **Step 2:** Dispatch focused validation on a tag. Expected: release shard fails at `restart-retirement-dead-history` because a fresh observer cannot open the lock without its owner file.

### Task 2: Takeover and directory retirement (green)

- [ ] **Step 1:** Implement the production changes listed above.
- [ ] **Step 2:** Dispatch focused validation and Contracts. Expected: all shards and acceptance succeed.

### Task 3: Acceptance

- [ ] **Step 1:** Merge all shard logs and compare actual `PASS:` receipts with the workflow list at the validated SHA.
- [ ] **Step 2:** Record run IDs and commit the acceptance.
