# Windows Restart Handoff-Aware Activation Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The exact live restart owner publishes its distinct runtime bundle at preflight through the handoff-aware inactive scope. Through the gate 63 transaction it then creates and rotates its stopped snapshot, advances to `activating`, and prepares activation. The preparation record binds its handoff admission digest, its operation bundle and the proved (generated) task definition. Copied contexts and duplicate preparation stay refused.

**Architecture:** Continues gates 62–63. The runtime bundle, configuration inspection, snapshot and rotation use only the scope's native `check`, so they should already accept the handoff scope. Two production gaps are expected:

- The handoff controller grants only `check`, `close` and `capture-handoff-admission`. After its handoff admission is published, it must also grant the inactive transaction methods (`prepare-inactive-activation` first).
- `New-AgentsChatInactiveActivationPreparation` records `NativeDefinition`. It must record the proved definition when present, as admission does (gate 62).

**Tech Stack:** `tests/deployment-windows-restart-preparation.mjs` (`commitment` shard), `scripts/deployment/windows-managed-task-controller.ps1`, `scripts/deployment/windows-inactive-task.ps1`, `.github/workflows/deployment-lifecycle.yml` (70 receipts). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

- [x] At preflight, after the foreign-lock refusal, a copied scope cannot publish the runtime bundle. The handoff scope publishes exactly `{directory, configuration, sha256}` for `runtime-<operationId>`.
- [x] After the gate 63 copying stage, the transaction creates `handoff-transaction-snapshot` with the stopped task binding, writes `rotating`, rotates (the backup verifies as the manifest), and advances through `activating`.
- [x] A copied context cannot prepare activation. The preparation record binds `activation-prepared`, the handoff admission digest, the proved definition and the bundle configuration. A duplicate preparation is refused, and `task-maintenance` holds only the admission and the preparation.
- [x] Cleanup removes both maintenance files after the scope closes.
- [x] Receipt `PASS: handoff-aware inactive transaction snapshots rotates and prepares activation with its distinct operation bundle and proved task definition while copied contexts and duplicate preparation remain refused`.
- [ ] Actions red at the activation preparation.

### Task 2: Production

- [ ] Controller: a handoff-aware scope grants the inactive transaction methods only after its own handoff admission is published in the scope (`AdmissionSha256` set by `capture-handoff-admission`). Before that, it keeps refusing them.
- [ ] `New-AgentsChatInactiveActivationPreparation` records the proved definition when the context has one.

### Task 3: Acceptance

- [ ] Stopped-history run green on all 10 shards with 70 receipts, plus a same-SHA Contracts run.
