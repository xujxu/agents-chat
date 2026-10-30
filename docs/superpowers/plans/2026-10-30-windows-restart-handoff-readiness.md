# Windows Restart Handoff-Aware Startup Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After gate 66 starts the guarded runtime, the handoff-aware inactive transaction verifies HTTP readiness only through its retained original Job listener. A premature listener request (port 0) and a foreign port stay refused.

**Architecture:** Continues gates 62–66. `inactive-listener` is already granted to the handoff scope after its admission. The transaction's `listener` binds the activated runtime's Job, and `waitWindowsReadiness` reuses it.

**Tech Stack:** `tests/deployment-windows-restart-preparation.mjs` (`commitment` shard), `.github/workflows/deployment-lifecycle.yml` (73 receipts). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

- [x] Before startup, record the project's `listener.json`. After startup, port 0 is refused, and the new listener pid appears within 30 seconds.
- [x] Write `health-mode` = `ready`, keeping the prior bytes (or absence) for cleanup. `waitWindowsReadiness` with the inspected configuration providers reports `ready` with the activated generation. The owned listener matches the pid and generation. A different port is then refused.
- [x] Cleanup restores `health-mode` after the runtime settles.
- [x] Receipt `PASS: handoff-aware inactive startup readiness verifies HTTP providers only through its retained original Job listener while premature and foreign ports remain refused`.

### Task 2: Production

- [ ] Only if Actions shows a gap.

### Task 3: Acceptance

- [ ] Stopped-history run green on all 10 shards with 73 receipts, plus a same-SHA Contracts run.
