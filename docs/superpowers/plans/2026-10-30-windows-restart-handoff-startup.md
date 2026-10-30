# Windows Restart Handoff-Aware Inactive Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After gate 65 replaces the inhibited task, the handoff-aware inactive transaction starts one distinct guarded runtime from its operation bundle. Closing the unfinished transaction settles that runtime. Copied contexts and duplicate startup stay refused.

**Architecture:** Continues gates 62–65. `start-inactive` is already granted to the handoff scope after its admission (gate 64). Native startup derives its guarded definition from `ReplacementDefinition`, not from the native or proved original definition, so no definition change is expected. The new readiness record is written into the operation bundle, which is distinct from the proved original bundle that the scope observes.

**Tech Stack:** `tests/deployment-windows-restart-preparation.mjs` (`commitment` shard), `.github/workflows/deployment-lifecycle.yml` (72 receipts). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

- [x] After the gate 65 replacement, a copied context cannot start. The handoff transaction starts: `guarded-running`, the original task name, and a runtime whose identity and generation differ from the retired runtime and whose configuration digest is the bundle's. A duplicate start is refused. The `inactive-start-running` receipt binds the preparation digest, the bundle configuration and the runtime.
- [x] After the transaction closes, the runtime process identity disappears within 30 seconds.
- [x] Cleanup removes every replacement and startup receipt (and only those) before the task definition is restored.
- [x] Receipt `PASS: handoff-aware inactive transaction starts one distinct guarded runtime from its operation bundle and settles it on close while copied contexts and duplicate startup remain refused`.

### Task 2: Production

- [x] None required.

### Task 3: Acceptance

- [x] Stopped-history run green on all 10 shards with 72 receipts, plus a same-SHA Contracts run.

## Acceptance (2026-10-30)

Test-only change; no production change was required because native startup derives its guarded definition from the replacement definition.

- Stopped-history run `40987533377` at `1b7c8115` (`gate66-contract2`) succeeded on all ten shards: commitment `123841942778`, completion `123841942898`, successor `123841942930`, release `123841942943`, restart `123841942972`, takeover `123841943036`, state `123841943062`, baseline `123841943093`, postwrite `123841943136` and postintent `123841943267`. The aggregate job (`123849750005`) verified all 72 required receipts, including gates 64, 65 and 66.
- Same-SHA Contracts run `40990019890` / Contracts (windows-2022) `123849897262` succeeded.
