# Windows Restart Lock Retirer Death Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a distinct retirer publishes the restart lock retirement intent for a dead committed owner and then actually dies, a further distinct observer proves the retirer and owner dead from that exact intent, cannot duplicate it, and nothing is deleted.

**Architecture:** The generic committed observation accepts an optional `restartRetirement` descriptor after `restartCommitted`. `windows-stopped-history-handoff-restart-retirement.ps1` gains a read-only observation role (`HistoryHandoffRestartRetirementObserver`) that reopens the intent, rebinds it to the retained committed proof, and proves both the owner and the recorded retirer (actor and bridge) absent. The boundary `restart-retirement-dead-history` closes the release shard.

**Tech Stack:** PowerShell 7 native modules, Node test actors, GitHub Actions `deployment-lifecycle.yml` (validation only in Actions).

---

## File Structure

- Modify `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`: accept `restartRetirement` (requires `restartCommitted`, excludes restart state), add it to the expected namespace, initialize the observation after the committed restart record.
- Modify `scripts/deployment/windows-stopped-history-handoff-restart-retirement.ps1`: observation initializer, record binding for a dead recorded retirer, observation getter, and the `Open-…RestartRetirementObservation` wrapper that reports `Restart lock retirement observation failed; retain evidence.`
- Create `tests/deployment-windows-restart-retirement-death.ps1`: controller kills the held retirer and its bridge and checks every record, the owner, the directory and original state.
- Create `tests/deployment-windows-restart-retirement-death.mjs`: held retirer (`INACTIVE_HISTORY_RESTART_RETIREMENT_HELD`) and the distinct observer assertions.
- Modify `tests/deployment-windows-history-handoff-restart-observation.ps1`: `-Hold` for a fresh retirement and the `restartRetirement` observer path.
- Modify `tests/deployment-windows-successor-abandoned-observation.mjs`, `tests/deployment-windows-lost-runtime-session.mjs`, `tests/deployment-windows-inactive-task.ps1`: new modes and boundary.
- Modify `.github/workflows/deployment-lifecycle.yml`: two acceptance receipts.

### Task 1: Test contract (red)

- [ ] **Step 1:** Add the boundary, fixture, actors and receipts listed above.
- [ ] **Step 2:** Dispatch focused stopped-history validation on a tag at the contract commit. Expected: release shard fails at `restart-retirement-dead-history` with `Native restart observation fixture failed` because `Open-AgentsChatStoppedHistoryHandoffRestartRetirementObservation` does not exist.

### Task 2: Read-only retirement observation (green)

- [ ] **Step 1:** Implement the production changes listed above.
- [ ] **Step 2:** Dispatch focused validation and Contracts at HEAD. Expected: all six shards and acceptance succeed with every required receipt.

### Task 3: Acceptance

- [ ] **Step 1:** Merge all shard logs and compare actual `PASS:` receipts with the workflow list at the validated SHA.
- [ ] **Step 2:** Record run IDs and commit the acceptance.
