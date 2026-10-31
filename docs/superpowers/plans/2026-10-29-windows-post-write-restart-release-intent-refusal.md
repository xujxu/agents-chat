# Windows Post-Write Restart Release Intent Refusal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suppose the live restart releaser publishes its exact post-write tenth record (`-lock-retirement.json` binding `stateIntent` and `writtenState`) after its acknowledged state write, then actually dies before deleting any lock child. In that case a distinct fresh observer must:
- preserve all ten records, the written state, and the owner and directory;
- refuse archive-only dead-owner lock retirement at every entrance;
- gain no runtime, lock, or task authority.

**Architecture:** This applies the spec rule "never revert to archive-only lock cleanup" after a write.
- **Fixture.** Gate 59's `-HoldRestartReleaseIntent` and `holdReleaseIntent` hold is extended to the post-write release.
- **Death harness.** `tests/deployment-windows-restart-directory-death.ps1` accepts `-State -ReleaseIntent`.
- **Distinct observer.** `blockedState && blockedReleaseIntent` checks the exact post-write intent record. It then requires refusal from four entrances:
  - the state observer;
  - a retirement-only request (`Restart lock retirement observation failed; retain evidence.`);
  - a state-plus-retirement request;
  - a new retirer.
- **Reconciliation.** Ordinary reconciliation reports the attempt as `state-transition`. Its records are `prepared`, `committed`, `lock-retirement`, and `state-intent`.
- **Production.** Gate 59 already refuses at the request and namespace level. The retirement initializer also refuses a `stateIntent`-bearing release intent with `Post-write restart release takeover requires new-operation recovery.`

**Tech Stack:** PowerShell 7, Node fixtures, and the GitHub Actions `postintent` shard. The new boundary writes state, so it must be in its own final shard.

---

### Task 1: Test contract (expected green on gate 59 production)

- [ ] **Session modes.** Add `crash-restart-state-release-intent-history` and `resume-restart-state-release-intent-dead-history` to `tests/deployment-windows-lost-runtime-session.mjs`.
- [ ] **Release hold.** Allow `holdReleaseIntent` and `holdIntent` together with the post-write release in:
  - `tests/deployment-windows-restart-preparation.mjs`
  - `tests/deployment-windows-restart-release-publication.mjs`
  - `tests/deployment-windows-history-handoff-committed-observation.ps1`
  - `tests/deployment-windows-history-handoff-restart-release.ps1`
- [ ] **Shard and receipts.** Add the boundary `restart-state-release-intent-dead-history` as the single-boundary `postintent` shard, then add two required receipts, bringing the total to 66.
- [ ] **Run and record.** Commit, tag `gate60-contract`, and dispatch the focused and Contracts runs. Record the outcome.

### Task 2: Acceptance

- [ ] Merge all ten shard logs and require all 66 receipts.
- [ ] Record the run IDs here.
