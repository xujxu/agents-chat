# Windows Restart Lock Owner Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the restart lock retirer dies with only its exact intent published, a distinct observer that is given the independent owner-retirement role deletes only the dead committed owner's `lock\owner.json` and keeps the empty lock directory, the intent, every record and the original state.

**Architecture:** A new module `windows-stopped-history-handoff-restart-retirement-owner.ps1` adds `Remove-AgentsChatStoppedHistoryHandoffRestartLockOwner`, which requires `HistoryHandoffRestartOwnerRetirer` on a retirement observation scope, reopens the owner only by its retained descriptor (`RetainForRetirement`), rechecks the controller identity, deletes it, and marks `OwnerRetired`. `Assert-AgentsChatStoppedHistoryHandoffRestartLock` accepts an owner-retired directory only with that role and the retained intent; the retirement observation then reports `restart-lock-retirement-owner-retired`. A repeated call is idempotent. Validation stays inside the existing `restart-retirement-dead-history` boundary of the release shard.

**Tech Stack:** PowerShell 7 native modules, Node test actors, GitHub Actions `deployment-lifecycle.yml` (validation only in Actions).

---

## File Structure

- Create `scripts/deployment/windows-stopped-history-handoff-restart-retirement-owner.ps1`: the owner deletion executor.
- Modify `scripts/deployment/windows-stopped-history-handoff-restart-lock.ps1`: owner-retired branch.
- Modify `scripts/deployment/windows-stopped-history-handoff-restart-retirement.ps1`: owner-retired observation status.
- Modify `tests/deployment-windows-history-handoff-restart-observation.ps1`: `retireOwner` request; refusal without role, then deletion and an identical repeat.
- Modify `tests/deployment-windows-restart-retirement-death.mjs`: expect the owner-retired observation, absent owner, same empty directory, unchanged intent.
- Modify `tests/deployment-windows-successor-abandoned-observation.mjs`: final inventory without the owner file; receipt.
- Modify `.github/workflows/deployment-lifecycle.yml`: one acceptance receipt (56 total).

### Task 1: Test contract (red)

- [ ] **Step 1:** Add the fixture request, assertions and receipt listed above.
- [ ] **Step 2:** Dispatch focused stopped-history validation on a tag at the contract commit. Expected: release shard fails at `restart-retirement-dead-history` with `Native restart observation fixture failed` because the owner-retirement module does not exist.

### Task 2: Owner deletion (green)

- [ ] **Step 1:** Implement the production changes listed above.
- [ ] **Step 2:** Dispatch focused validation and Contracts at HEAD. Expected: all six shards and acceptance succeed with every required receipt.

### Task 3: Acceptance

- [ ] **Step 1:** Merge all shard logs and compare actual `PASS:` receipts with the workflow list at the validated SHA.
- [ ] **Step 2:** Record run IDs and commit the acceptance.
