# Windows Restart State Writer Death Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the native restart publisher has written `state.json` from its ninth record and then actually dies, a distinct fresh observer preserves the nine records, the restart lock owner and directory, and the written state, and refuses to continue without gaining state, lock, runtime or task authority.

**Architecture:** Mirror gate 42 (`restart-committed-dead-history`). The held restart publisher gains `-HoldRestartState`: after the write it reports `INACTIVE_HISTORY_RESTART_STATE_HELD` with every descriptor (including `restartStateIntent` and `restartState`) and blocks. `tests/deployment-windows-restart-directory-death.ps1` gains `-State`, kills the actual publisher, and starts the distinct observer mode `resume-restart-state-dead-history`. `tests/deployment-windows-successor-abandoned-observation.mjs` gains `blockedState`: it checks the ninth record exactly, requires `state.json` bytes to equal `JSON.stringify(intent.nextState) + "\n"` with `nlink=1` and the held inode, requires no `state.json.lock*`, then requires the production observer to refuse with `Retired prepared handoff namespace differs.`. After asserting, the fixture restores the original state bytes in place so the later archival hash check is unchanged.

**Tech Stack:** PowerShell 7, Node fixtures, GitHub Actions `commitment` shard only.

---

### Task 1: Test contract (red or immediate green)

- [x] `-HoldRestartState` in `tests/deployment-windows-history-handoff-committed-observation.ps1` (requires `-WriteRestartState`), with `Test-AgentsChatStoppedHistoryHandoffRestartStateWrite -Continue` skipping the duplicate/poison step.
- [x] `crash-restart-state-history` / `resume-restart-state-dead-history` in `tests/deployment-windows-lost-runtime-session.mjs`.
- [x] Boundary `restart-state-dead-history` in all `tests/deployment-windows-inactive-task.ps1` boundary arrays after `restart-state-written-history`.
- [x] Required receipt `PASS: actual restart state writer death preserves its written state nine records owner and directory for a distinct observer without authority`.
- [ ] Because production already refuses at the namespace, this gate may be green on first Actions run; record that as the expected outcome rather than inventing a red.
