# Windows Restart Commitment Publisher Death Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that actual death of the fresh restart publisher immediately after it publishes the exact eighth `-committed.json` record preserves the owner directory, owner bytes, and all eight records, and that no later actor gains state, task, runtime, or release authority from them.

**Architecture:** Test-only gate 42. The accepted committed-initialization code checks the retired namespace before lock identity, so a fresh native7 reopen that sees an unauthorized eighth file must refuse with `Retired prepared handoff namespace differs.`. No production change is expected; a red would indicate a real gap and must be fixed without weakening refusals.

**Tech Stack:** PowerShell 7 native Windows fixtures, Node.js ESM fixtures, GitHub Actions `deployment-lifecycle.yml`.

---

### Task 1: Hold the committed publisher live

**Files:** `tests/deployment-windows-history-handoff-committed-observation.ps1`, `tests/deployment-windows-restart-commit-publication.mjs`, `tests/deployment-windows-restart-preparation.mjs`

- [x] Add `-HoldRestartCommitted` (requires `-CommitRestart`) so the native bridge emits a `ready` frame wrapping the committed result and stays live.
- [x] Node verifies the held frame's pid/processIdentity/control/controllerIdentity, verifies the exact committed record, and prints `INACTIVE_HISTORY_RESTART_COMMITTED_HELD` with `restartCommitted`, `restartOwner`, and `restartDirectory` descriptors, skipping all cleanup.

### Task 2: Actual death and distinct-actor observation

**Files:** `tests/deployment-windows-lost-runtime-session.mjs`, `tests/deployment-windows-restart-directory-death.ps1`, `tests/deployment-windows-inactive-task.ps1`, `tests/deployment-windows-successor-abandoned-observation.mjs`

- [x] Modes `crash-restart-committed-history` / `resume-restart-committed-dead-history` (lock stage `Committed`).
- [x] Host `Stop-AgentsChatRestartDirectoryPublisher -Committed` sends owner and commit commands, kills Node and bridge, and verifies eight record hashes, the single `owner.json` child, owner bytes, and original state hash.
- [x] Boundary `restart-committed-dead-history` appended to the restart shard and every ancestor array.
- [x] Observer `blockedCommitted` re-verifies the exact 13-field eighth record (`nlink` 1, dev/ino/bytes/hash), requires native7 reopen refusal with `Retired prepared handoff namespace differs.`, keeps ordinary refusals and acquire/release refusals, then fixture-only cleanup owner → directory → eight records.

### Task 3: Validate only in GitHub Actions

- [x] Commit `[skip ci]`, push, dispatch focused stopped-history and Contracts runs.
- [x] Require all 42 receipts across the three native raw logs, including
  `PASS: actual fresh restart committed publisher death preserves its exact eighth record owner directory and seven records without state authority`.
- [x] Record run/job IDs in an acceptance section.

## Acceptance (2026-10-29)

Test-only change `a88db462`; no production change was required because committed initialization refuses the unauthorized eighth file through the namespace check.

- Focused run `40791608534` succeeded: baseline `123177942702`, successor `123177942368`, restart `123177942779`, aggregate `Stopped-history acceptance (all boundaries)` `123193405796`.
- All 42 required receipts present across the three native raw logs (0 missing), including the new receipt at `2026-10-29T00:46:46.2502367Z`.
- Same-SHA Contracts run `40791611930` / `Contracts (windows-2022)` `123177953077` succeeded.
