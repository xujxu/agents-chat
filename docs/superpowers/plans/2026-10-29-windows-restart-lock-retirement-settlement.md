# Windows Restart Lock Retirement Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a distinct directory retirer removed the exact empty restart lock directory and exited, a fresh distinct observer reopens the absent lock from the exact retirement intent, reports `restart-lock-retirement-directory-retired`, and with the independent settler role publishes only `inactive-handoff-<restart>-lock-retired.json` (phase `stopped-history-handoff-restart-lock-retired`); ordinary reconciliation then reports the restart attempt as `lock-settled` and stays blocked.

**Architecture:** `Open-AgentsChatStoppedHistoryHandoffRestartLockObservation` accepts an absent lock directory only when `restartRetirement` is requested, retaining the committed directory identity and owner descriptor with `OwnerRetired`/`DirectoryRetired` and the pending marker until the intent is bound. The directory-retired branch of `Assert-AgentsChatStoppedHistoryHandoffRestartLock` requires the retained intent (or the pending marker), not a deletion role. A new module `windows-stopped-history-handoff-restart-retirement-settlement.ps1` builds, publishes, retains and re-binds the settlement record (`HistoryHandoffRestartSettler`), returns `restart-lock-settled`, and is idempotent; the committed namespace includes the retained settlement.

**Tech Stack:** PowerShell 7 native modules, Node test actors, GitHub Actions `deployment-lifecycle.yml` (validation only in Actions).

---

### Task 1: Test contract (red)

- [ ] **Step 1:** Fixture `settleRestart`; takeover observation, settlement record and reconciliation assertions; two receipts (59 total).
- [ ] **Step 2:** Dispatch focused validation on a tag. Expected: release shard fails at `restart-retirement-dead-history` because a fresh observer cannot open the absent lock.

### Task 2: Takeover and settlement (green)

- [ ] **Step 1:** Implement the production changes listed above.
- [ ] **Step 2:** Dispatch focused validation and Contracts. Expected: all shards and acceptance succeed.

### Task 3: Acceptance

- [ ] **Step 1:** Merge all shard logs and compare actual `PASS:` receipts with the workflow list at the validated SHA.
- [ ] **Step 2:** Record run IDs and commit the acceptance.
