# Windows Restart State Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the exact eighth `-committed.json` record, the live fresh restart actor publishes a ninth create-only record `inactive-handoff-<attempt>-state-intent.json` that binds the immutable original `oldState` text and the exact authorized `nextState`, before any state write and without granting state, runtime, or lock authority.

**Architecture:** New native module `scripts/deployment/windows-stopped-history-handoff-restart-state-intent.ps1` mirrors gate 41: record builder, pure retained assertion, and a role-gated publisher that surrounds the create-only publish with full ancestor observations, refuses a poisoned scope, and poisons on any failure. The committed-observation namespace admits the ninth name only after the pure assertion passes.

**Tech Stack:** PowerShell 7 native Windows, Node.js ESM fixtures, GitHub Actions `deployment-lifecycle.yml`.

## Exact next state

The next state is the first write a normal update would make, for the new owner operation, from a stopped runtime:

```json
{"version":1,"operationId":"<newOwner.operationId>","project":"<project>","operation":"update",
 "phase":"preflight","previousPhase":null,"sourceCommit":null,"targetCommit":null,"backupId":null,
 "priorRuntime":"stopped","runtimeIdentity":"<observation.retiredRuntime.generation>",
 "startedAt":"<newOwner.createdAt>","updatedAt":"<intent createdAt>","errorCode":null}
```

`writeState` accepts it from the completed `restored` original state because the operation id differs and the phase is `preflight` with `previousPhase` null.

## Record

`version, phase='stopped-history-handoff-restart-state-intent', attemptId, control, project, controlIdentity, previousOperationId, prepared, committed, newOwner, lockIdentity, lock, state, oldState, nextState, creator{pid,processIdentity,bridgePid,bridgeIdentity}, createdAt` with `committedAt <= createdAt <= now`, at most 1048576 bytes.

### Task 1: Test contract (red)

- [x] Native fixture `-PrepareRestartState` (requires `-CommitRestart`, excludes `-HoldRestartCommitted`): after the commit (which returns via `-Continue` without duplicate poisoning), emit `restart-committed-published`, require `{"type":"prepare-restart-state"}`, then run `Test-AgentsChatStoppedHistoryHandoffRestartStateIntent` (role refusal, two proof frames, copy refusal, duplicate refusal with poison).
- [x] Node `assertRestartStateIntentPublication` prints `INACTIVE_HISTORY_RESTART_COMMITTED_LIVE`, forwards the host command, verifies the exact ninth record, and `state.json` stays byte- and inode-identical.
- [x] Host `Send-AgentsChatRestartStateIntentCommand`; boundary `restart-state-intent-history` (restart shard); mode `resume-restart-state-intent-history`.
- [x] Required receipt: `PASS: native restart state intent binds exact old and next preflight state after its eighth record without writing state or granting authority`.
- [ ] Actions red: missing `windows-stopped-history-handoff-restart-state-intent.ps1`.

### Task 2: Production module (green)

- [ ] Implement the module and namespace allowance; all 43 receipts in Actions; same-SHA Contracts.
