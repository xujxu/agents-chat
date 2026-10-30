# Windows Restart Handoff-Aware Inactive Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After gate 67 proves readiness, the handoff-aware inactive transaction completes through the existing `completeWindowsTaskActivation`. It records the accepted state, applies the permanent task policy and releases its original guarded lease. A forged completion before preparation and a duplicate completion stay refused.

**Architecture:** Continues gates 62–67. Native completion records compare definitions by normalized XML. They also require the operation bundle to differ from the admission's configuration, which in the handoff case is the proved original bundle. Both hold for a handoff admission, so no production change is expected. The completed runtime stays under its permanent task, so the fixture stops the task before re-registering the archived definition.

**Tech Stack:** `tests/deployment-windows-restart-preparation.mjs` (`commitment` shard), `.github/workflows/deployment-lifecycle.yml` (74 receipts). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

- [x] A forged `complete` before preparation is refused. `completeWindowsTaskActivation` with the inspected providers writes `accepted` (previous phase `activating`) and returns `completed`. The transaction then checks `accepted`, and a duplicate `complete` is refused.
- [x] `inactive-complete-complete.json` binds the preparation digest and the accepted state digest.
- [x] Cleanup asserts the completed runtime is still alive, disables and stops the task, waits for the runtime identity to disappear, removes every replacement, startup and completion receipt, and re-registers the archived definition disabled.
- [x] Receipt `PASS: handoff-aware inactive transaction completes with accepted state and permanent task policy through its original guarded lease while forged and duplicate completion remain refused`.

### Task 2: Production

- [ ] Only if Actions shows a gap.

### Task 3: Acceptance

- [ ] Stopped-history run green on all 10 shards with 74 receipts, plus a same-SHA Contracts run.
