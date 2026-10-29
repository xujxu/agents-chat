# Windows Handoff Reconciliation Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ordinary reconciliation reports the prepared, committed, abandoned, lock-retiring/settled and state-transition status of stopped-history handoff attempts on Windows. The report grants no mutation authority (spec "Lock and command integration": "Reconciliation reports prepared, committed or interrupted handoff status without granting mutation authority").

**Architecture:** A new dependency-free module `scripts/deployment/windows-stopped-history-handoff-report.mjs` exports `describeWindowsStoppedHistoryHandoffEntries(names)`. It groups `inactive-handoff-<guid>-<kind>.json` names (case-insensitive) by attempt and reports these fields:
- `records`: the kinds in a fixed order;
- `status`: a single derived status per attempt;
- `unrecognized`: names that do not match exactly;
- `authority: false`.

The report is computed from names only. It never reads or validates record bytes and never infers ownership. On Windows, `reconcileInterruptedOperation` still returns `status: 'blocked'` with its existing message and adds a `handoff` field only when such names exist. Lock, release, acquire and maintenance gates are unchanged.

Kinds, in order: `prepared`, `committed`, `abandoned`, `lock-retirement`, `lock-retired`, `state-intent`.

Attempt status is the first rule that matches:
1. No `prepared` record: `incomplete`.
2. `state-intent`: `state-transition`.
3. `lock-retired`: `lock-settled`.
4. `lock-retirement`: `lock-retiring`.
5. `abandoned`: `abandoned`.
6. `committed`: `committed`.
7. Otherwise: `prepared`.

**Tech Stack:** Node ESM, `node:test` Contracts on windows-2022, native Windows boundary fixture, GitHub Actions only.

---

### Task 1: Test contract

**Files:**
- Modify: `tests/deployment-windows-inactive-task.test.mjs` (pure report contract)
- Modify: `tests/deployment-state.test.mjs` (Windows reconcile report stays blocked)
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs` (native nine-record report in `restart-state-dead-history`)
- Modify: `.github/workflows/deployment-lifecycle.yml` (receipt)

- [ ] The pure contract covers these cases:
  - three attempts with mixed case;
  - an incomplete attempt;
  - unrecognized names (`-snapshot.json`, `inactive-handoff-malformed.json`, zero GUID);
  - non-handoff names are ignored;
  - the result is frozen and deeply detached.
- [ ] Windows reconcile returns `blocked`, the same message as before, and an exact `handoff` report. Owner bytes are unchanged.
- [ ] Native: after the dead restart state writer, ordinary reconciliation returns `blocked` with `operationId` equal to the written state's operation. It reports three attempts:
  - the original attempt as `lock-settled`;
  - the successor as `abandoned`;
  - the restart as `state-transition`.
  It reports no unrecognized names, and all evidence bytes and identities remain unchanged.
- [ ] Required receipt: `PASS: ordinary reconciliation reports nine exact handoff records as three attempts while staying blocked without authority`.
- [ ] Actions red: missing `windows-stopped-history-handoff-report.mjs` (Contracts) and the native receipt.

### Task 2: Production

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-report.mjs`
- Modify: `scripts/deployment/state.mjs` (`reconcileInterruptedOperation` maintenance branch)
- Modify: `scripts/deployment/saved-worker-engine.mjs` and `tests/deployment-saved-worker.test.mjs`, if the saved closure includes `state.mjs` imports.

- [ ] Implement the module and the reconcile field. Every other result keeps its exact current shape.
- [ ] Actions green with every required receipt; Contracts green.
