# Windows Restart Handoff Retirement Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Through its retained inactive completion proof, the completed handoff operation prepares the existing version-two inactive retirement intent and checkpoint. The checkpoint binds the archived retired runtime as the prior runtime. This is the first step of new-operation retirement before settlement and lock release.

**Architecture:** Use `prepareWindowsInactiveTaskRetirement` and `prepareWindowsInactiveTaskRetirementCheckpoint` unchanged. They write `task-retirement.json` and `task-retirement-checkpoint.json` in the control directory. The intent lists every `task-maintenance` receipt, starting with `admission.json` and ending with `inactive-complete-complete.json`. The handoff records and retired history archives remain outside this inventory.

**Tech Stack:** the distinct closeout actor in `tests/deployment-windows-restart-handoff-closeout.mjs` (`commitment` shard; see the gate 69 revision) and `.github/workflows/deployment-lifecycle.yml` (76 receipts). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

- [x] A copied proof is refused.
- [x] The intent is version 2 and binds the proof observation. Its files are exactly the `task-maintenance` receipts, from `admission.json` to `inactive-complete-complete.json`. Preparing it again returns the same intent.
- [x] The checkpoint is version 2 and binds the intent. Its prior runtime is the archived retired runtime, with a generation distinct from the activated runtime. Preparing it again returns the same checkpoint, and the proof observation is unchanged.
- [x] The closeout actor's fixture restoration removes both retirement records.
- [x] Receipt `PASS: handoff-aware completed operation prepares its exact inactive retirement intent and checkpoint with the archived retired runtime while copied proofs remain refused`.

### Task 2: Production

- [x] Not needed. Only if Actions shows a gap.

### Task 3: Acceptance

- [x] Stopped-history run green on all 10 shards with 76 receipts, plus a same-SHA Contracts run.
- [x] Accepted on `a3f630d1` (tag `gate71-contract3`): stopped-history run `41003468341` green on all 10 shards, aggregate job `123900906165` verified 77 receipts; same-SHA Contracts run `41003504175` (job `123893066026`) green.
