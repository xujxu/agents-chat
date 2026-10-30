# Windows Restart Handoff-Aware Inactive Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After gate 64 prepares activation, the handoff-aware inactive transaction replaces the inhibited task with its distinct operation bundle. The replacement receipts record the proved original definition. Copied contexts and duplicate replacement stay refused.

**Architecture:** Continues gates 62–64. `replace-inactive` is already granted to the handoff scope after its admission (gate 64). The expected production gap: `Write-AgentsChatInactiveReplacementReceipt` records `NativeDefinition` (the Scheduler-reformatted XML), while the JS binding expects `observation.definition`, which is the proved generated definition in the handoff case. The base for the requested definition stays `NativeDefinition`; the proved definition is OuterXml-equal to it.

**Tech Stack:** `tests/deployment-windows-restart-preparation.mjs` (`commitment` shard), `scripts/deployment/windows-inactive-task-replacement.ps1`, `.github/workflows/deployment-lifecycle.yml` (71 receipts). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

- [x] After the gate 64 preparation, a copied context cannot replace. The handoff transaction replaces the task: the result is replaced and inhibited, the `replacement-complete` receipt binds the preparation digest, the proved original definition and the bundle configuration, and the new definition names the bundle configuration.
- [x] A duplicate replacement is refused. `task-maintenance` holds the admission, the preparation and both replacement receipts.
- [x] Cleanup removes both replacement receipts after the scope closes and re-registers the original inhibited definition so later fixture steps observe the archived task.
- [x] Receipt `PASS: handoff-aware inactive transaction replaces the inhibited task with its operation bundle and records the proved original definition while copied contexts and duplicate replacement remain refused`.

### Task 2: Production

- [x] `Write-AgentsChatInactiveReplacementReceipt` records the proved definition as `originalDefinition` when the context has one.

### Task 3: Acceptance

- [ ] Stopped-history run green on all 10 shards with 71 receipts, plus a same-SHA Contracts run.
