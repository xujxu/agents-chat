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
- [x] Actions red: focused run `40796944914` passed baseline `123195594605` and successor `123195594822`; restart job `123195594862` reached the fifth explicit command and failed at `2026-10-29T02:15:36Z` in phase `restart-state-intent-before-proof` because `windows-stopped-history-handoff-restart-state-intent.ps1` did not exist. This is the intended missing-module red.

### Shard budget

That restart job took 82 of its 90 minutes (about 21 minutes of setup plus about 9 minutes per restart boundary). Without raising any limit, the stopped-history matrix gains a fourth `commitment` shard starting at `restart-committed-history`; `restart` now ends before it. The aggregate job requires all four shard receipt files.

### Task 2: Production module (green)

- [x] Implement the module and namespace allowance; all 43 receipts in Actions; same-SHA Contracts.

Evidence: production commit `92a18554` published the ninth record in run `40805496808`, but the commitment fixture failed at `restart-state-intent-result` because it read `oldState`, `state`, `operation` and `observation` from the five-field captured restart record. Fixture-only commit `eefc6534` reads them from the original prepared template; production refusals are unchanged.

Accepted at `eefc6534`: focused run `40810119310` passed baseline `123238184637`, successor `123238184679`, restart `123238184688`, commitment `123238184532` (new receipt at `2026-10-29T03:50:27Z`) and aggregate `123253712945`; the merged four native logs contain 43/43 required receipts. Contracts run `40810122588` job `123238195771` passed on the same SHA. Shard durations: 34, 42, 51 and 45 minutes, all under the unchanged 90-minute limit.
