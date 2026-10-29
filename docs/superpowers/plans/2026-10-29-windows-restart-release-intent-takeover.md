# Windows Restart Release Intent Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** If the live pre-write restart releaser publishes its exact tenth record (`-lock-retirement.json`, phase `stopped-history-handoff-restart-release-prepared`) and then actually dies before deleting any lock child, distinct fresh actors take over from that exact intent. They prove the owner is dead, retire only the owner file, retire the empty directory, settle, and take over the settled stage. None of them gains runtime, lock, or task authority.

**Architecture:** This follows the spec's interruption table: "Committed, original state unchanged → dead-owner cleanup requires exact lock retirement."

- **Production split.** `windows-stopped-history-handoff-restart-release.ps1` splits `Publish-AgentsChatStoppedHistoryHandoffRestartReleaseIntent` out of `Remove-AgentsChatStoppedHistoryHandoffRestartLock`. Remove then deletes only from the retained intent, and still makes exactly two ancestor passes.
- **Retirement observer.** `windows-stopped-history-handoff-restart-retirement.ps1` accepts the release intent as a dead-owner retirement record:
  - It has no `owner` field.
  - Its `creator` equals the committed creator.
  - It refuses a post-write release intent with `Post-write restart release takeover requires new-operation recovery.`
- **Unchanged roles.** The owner-retirement, directory-retirement, and settlement roles are generic. Their consumers fall back to `creator` when `owner` is absent.

**Tech Stack:** PowerShell 7, Node fixtures, and the GitHub Actions `takeover` shard.

---

### Task 1: Test contract (expected red)

- [x] **Release-intent proof frames.** `tests/deployment-windows-restart-publication-progress.{ps1,mjs}` adds the `release-intent` publication. It makes exactly two ancestor passes: one by the intent publisher and one by the held releaser.
- [x] **Release helper.** `tests/deployment-windows-history-handoff-restart-release.ps1` adds `-IntentOnly`, which does the following:
  - Refuses both the intent and the removal without the role.
  - Returns `restart-release-prepared`.
  - Leaves the lock, owner bytes, records, and original state unchanged, with no `-lock-retired.json`.
- [x] **Bridge fixture.** `tests/deployment-windows-history-handoff-committed-observation.ps1` adds `-HoldRestartReleaseIntent`, which requires `-ReleaseRestart` and refuses `-PrepareRestartState` and `-HoldRestartReleased`.
- [x] **Node fixtures.** `tests/deployment-windows-restart-release-publication.mjs` adds `holdIntent`, and `tests/deployment-windows-restart-preparation.mjs` adds `holdReleaseIntent`. Together they emit `INACTIVE_HISTORY_RESTART_RELEASE_INTENT_HELD`.
- [x] **Session modes.** `tests/deployment-windows-lost-runtime-session.mjs` adds `crash-restart-release-intent-history` and `resume-restart-release-intent-dead-history`.
- [x] **Death harness.** `tests/deployment-windows-restart-directory-death.ps1` adds `-ReleaseIntent`. It kills the actual releaser and requires the exact tenth record, the owner-only lock, no `-lock-retired.json`, and the original state.
- [x] **Distinct observer.** In `tests/deployment-windows-successor-abandoned-observation.mjs`, `blockedReleaseIntent` reuses `assertDeadRestartRetirement({ release: true })` and the lock-settled reconciliation.
- [x] **Boundary and shard.** `tests/deployment-windows-inactive-task.ps1` adds the boundary `restart-release-intent-dead-history` as the single-boundary `takeover` shard. The workflow matrix and the acceptance shard list both gain `takeover`.
- [x] **Receipt.** Add the required receipt `PASS: actual restart releaser death after its exact release intent lets distinct fresh actors retire and settle only the dead owner lock without authority`, bringing the total to 64.
- [x] **Commit and expect red.** Commit, tag `gate59-contract`, and dispatch the focused and Contracts runs. Expected red: `Publish-AgentsChatStoppedHistoryHandoffRestartReleaseIntent` is not recognized.

Red evidence: focused run `40905206163` on `gate59-contract` (`c95f8916`) failed only in the `postwrite`, `takeover`, and `release` shards, each with `Publish-AgentsChatStoppedHistoryHandoffRestartReleaseIntent` is not recognized (the expected red). Contracts run `40905213745` passed.

### Task 2: Production

- [ ] **Release intent split.** Change `windows-stopped-history-handoff-restart-release.ps1`:
  - Add the intent publisher, which carries every precondition of the current remover. It runs one ancestor pass, publishes the tenth record, asserts the lock, and returns `restart-release-prepared` with authority false.
  - The remover publishes the intent unless one is already retained, and refuses if the release is already retained. It deletes only from the retained descriptor and creator, then makes its single final ancestor pass.
- [ ] **Retirement observer.** Change `windows-stopped-history-handoff-restart-retirement.ps1` so that initialization and record reading accept the `release-prepared` phase:
  - Require the observer role.
  - Require `creator` to equal the committed creator.
  - Require the owner to be absent.
  - Require no `stateIntent` in the record.
- [ ] **Owner fallback.** In both the observation and `windows-stopped-history-handoff-restart-retirement-settlement.ps1`, fall back from `owner` to `creator`.
- [ ] **Green run.** Commit, tag `gate59-green`, and dispatch. Merge the logs from all nine shards and require all 64 receipts.

### Task 3: Acceptance

- [ ] Record the red and green run IDs here and update the Windows handoff spec's interruption table.
