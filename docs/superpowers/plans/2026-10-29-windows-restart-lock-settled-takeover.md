# Windows Restart Lock Settled Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the settler bridge published `inactive-handoff-<restart>-lock-retired.json` and exited, a fresh distinct observer given the exact `restartSettlement` descriptor reopens the absent lock, binds the dead settler's record and reports `restart-lock-settled` without any mutation role; requests that omit or misdescribe the settlement are refused, and a fresh settler cannot replace or duplicate the record.

**Architecture:** `restartSettlement` is threaded through `Open-AgentsChatStoppedHistoryHandoffRestartRetirementObservation` → restart → committed observation, where `Initialize-AgentsChatStoppedHistoryHandoffCommittedObservation` adds the settlement name to the expected namespace and retains the opened record (`HistoryHandoffRestartSettlementObserver`). The settlement record builder accepts a dead settler bridge through `Assert-AgentsChatRetirementCreator`; only publication requires the creator to be the live caller. `Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation` reports `restart-lock-settled` with the settlement descriptor whenever a settlement is retained.

**Tech Stack:** PowerShell 7 native modules, Node test actors, GitHub Actions `deployment-lifecycle.yml` (validation only in Actions).

---

### Task 1: Test contract (red)

- [ ] **Step 1:** Fixture `restartSettlement`; two fresh settled observations, refusal without or with a wrong settlement, duplicate-settler refusal, unchanged bytes; one receipt (60 total).
- [ ] **Step 2:** Dispatch focused validation on a tag. Expected: release shard fails at `restart-retirement-dead-history` because a fresh observer cannot account for the settlement record.

### Task 2: Settled takeover (green)

- [ ] **Step 1:** Implement the production changes listed above.
- [ ] **Step 2:** Dispatch focused validation and Contracts. Expected: all shards and acceptance succeed.

### Task 3: Acceptance

- [ ] **Step 1:** Merge all shard logs and compare actual `PASS:` receipts with the workflow list at the validated SHA.
- [ ] **Step 2:** Record run IDs and commit the acceptance.
