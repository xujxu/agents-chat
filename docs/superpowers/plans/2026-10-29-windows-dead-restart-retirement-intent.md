# Windows Dead Restart Owner Retirement Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the committed restart owner actually dies with its exact `lock` and eight records in place and the original `state.json` untouched (`restart-committed-dead-history`), a distinct retirer proves the owner and its bridge dead and publishes only `inactive-handoff-<restart>-lock-retirement.json`, leaving the lock, the original state and every refusal of ordinary authority exact.

**Architecture:** Implements the first step of "dead-owner cleanup requires full original archive proof and exact lock retirement" (`docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md`, Interruption and cleanup, row "Committed, original state unchanged"). A new module `scripts/deployment/windows-stopped-history-handoff-restart-retirement.ps1` runs on the restart committed observer context under the independent role `HistoryHandoffRestartRetirer`. It re-runs the committed observation, verifies the original state bytes, proves the committed owner actor and bridge absent twice (`Assert-AgentsChatCompletionProcessAbsent`), publishes phase `stopped-history-handoff-restart-lock-retirement-prepared` with the dead `owner` (the committed record's creator) and the retirer `creator`, and re-observes twice. The committed namespace admits the record under `HistoryHandoffRestartRetirement`; reconciliation already reports `lock-retiring`. Owner/directory retirement and settlement are later gates.

**Tech Stack:** PowerShell 7 native modules, Node fixtures under `tests/`, GitHub Actions (`deployment-lifecycle.yml`, stopped-history `commitment` shard). All validation runs only in GitHub Actions.

---

### Task 1: Test contract (red)

**Files:**
- Modify: `tests/deployment-windows-history-handoff-restart-observation.ps1` (request field `retireRestart: true`, only with `restartCommitted` and without state descriptors)
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs` (committed-dead branch)
- Modify: `.github/workflows/deployment-lifecycle.yml` (two receipts)

- [ ] Without its role the fixture is refused with `Restart lock retirement requires its independent native role.` and retains nothing.
- [ ] With the role the result is `{status:'restart-lock-retirement-prepared', attemptId, prepared, committed, retirement, lockIdentity, lock, state, runtimeAuthority:false, lockAuthority:false, taskAuthority:false}`; `lock\owner.json` remains; a duplicate in the same scope is refused with `Restart lock retirement failed; retain evidence.`.
- [ ] Node verifies the record field-for-field: binding of the release record plus `owner` (exact dead committed creator), `creator` (this controller and a now-dead distinct bridge), `createdAt` between `committedAt` and now; identity-pinned descriptor, `nlink` 1.
- [ ] A fresh committed observer and a fresh retirer are both refused once the ninth record exists.
- [ ] Reconciliation stays blocked on the original operation and reports the restart attempt `['prepared','committed','lock-retirement']` as `lock-retiring`; nine snapshots stay exact.
- [ ] Receipts `PASS: distinct restart lock retirer proves the committed owner dead and publishes only its exact retirement intent while lock and original state remain without authority` and `PASS: ordinary reconciliation reports the dead restart attempt as lock-retiring while staying blocked without authority`.
- [ ] Actions red: commitment shard fails because `windows-stopped-history-handoff-restart-retirement.ps1` does not exist.

### Task 2: Production module (green)

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-retirement.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1` (namespace admits `HistoryHandoffRestartRetirement`)

- [ ] Role check, poison check, duplicate check, no state keys and no `state.json.lock*`; any failure poisons and throws `Restart lock retirement failed; retain evidence.`.

### Task 3: Acceptance

- [ ] Focused and Contracts runs green; all six shard logs merged and every required receipt present.
