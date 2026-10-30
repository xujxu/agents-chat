# Windows First-Attempt Handoff and Public Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public Windows `update` against archived stopped history goes through the stopped-history handoff and finishes with the lock released and no residual handoff evidence. Running-task and first-install behavior stay unchanged (spec `docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md`, "Lock and command integration" and "Validation and delivery gates").

**Architecture:** Gates 44–71 delivered the full new-operation chain only on the restart ladder, the recovery path after a dead successor. That chain covers state intent, state write, handoff-aware admission, the inactive transaction, the separate-process closeout proof and task receipt retirement. A fresh public update reaches only the first-attempt committed handoff (`windows-stopped-history-handoff-commit.ps1`). This plan generalizes, rather than duplicates, the restart state-intent, state-write and admission natives. They become one verifier parameterized by the committed handoff they bind: the first attempt (`HistoryHandoffCommit`) or the restart (`HistoryHandoffRestart*`). The restart receipts stay byte-identical. After that, public routing and the final lock release are added. Each gate keeps refusing the next, not-yet-supported increment.

**Tech Stack:** PowerShell strict native retained proofs; Node.js bridges in `scripts/deployment/`; fixtures in `tests/deployment-windows-*`; `.github/workflows/deployment-lifecycle.yml`. All validation runs only in GitHub Actions.

---

## Gates

| Gate | Increment | Must still refuse |
|---|---|---|
| 72 | First-attempt state-transition intent for the exact live committed owner | first-attempt state write |
| 73 | First-attempt state write plus dead-writer takeover | first-attempt handoff-aware admission |
| 74 | Handoff-aware admission accepts the first-attempt written preflight (shared verifier) | public routing |
| 75 | Public `update` routes archived stopped history through the handoff (prepare → lock → commit → intent → write → admission → existing inactive transaction) | lock release with handoff evidence present |
| 76 | Deployment retirement retires handoff evidence (`inactive-handoff-*`), then the worker evidence and the lock; closeout routing in `closeWindowsDeployment` for inactive accepted updates | — |
| 77 | Actual application repeat-update and rollback end to end with real workers; same-SHA Linux and Windows matrix; user docs | — |

### Task 1 (gate 72): First-attempt state intent contract

**Files:**
- Modify: `tests/deployment-windows-history-handoff-commit.ps1` (new `-PrepareState` switch, applied after `Complete-AgentsChatStoppedHistoryHandoffCommit` with `-HoldAt Committed`)
- Modify: `tests/deployment-windows-lost-runtime-session.mjs` (the committed-lock fixture path near line 684)
- Modify: `.github/workflows/deployment-lifecycle.yml` (receipt 78)

- [ ] Committed fixture: with `-PrepareState`, the live committed publisher publishes `inactive-handoff-<attempt>-state-intent.json`. The record has version 1, phase `stopped-history-handoff-state-intent`, `prepared` and `committed` descriptors, `newOwner`, `lockIdentity`, `lock`, `state`, `oldState` equal to the original bytes, and a `nextState` built exactly like the restart intent (preflight, `priorRuntime: stopped`, `runtimeIdentity` = the retired generation, `startedAt` = the owner's `createdAt`). It also records `creator` (the live publisher plus its bridge) and `createdAt`.
- [ ] A copied scope, a foreign creator, a second intent and a write attempt are refused. `state.json` is byte- and identity-identical.
- [ ] Receipt `PASS: first-attempt committed handoff publishes its exact state-transition intent for the live committed owner while copied foreign duplicate and write authority remain refused`.
- [ ] Commit tagged `gate72-contract`; dispatch the stopped-history run and expect red in production.

### Task 2 (gate 72): Shared native intent

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart-state-intent.ps1`
  - Extract the `nextState` and record builder into `Get-AgentsChatStoppedHistoryHandoffStateIntentBody`, taking the committed binding (`attemptId`, `prepared`, `committed`, `newOwner`, `lock`, `state`, `oldState`, `generation`).
  - The restart wrapper keeps its phase and fields byte-identical.
- Create: `scripts/deployment/windows-stopped-history-handoff-state-intent.ps1`
  - The first-attempt wrapper. It requires `HistoryHandoffLockPublisher` and a published `HistoryHandoffCommit.Committed`, and publishes through `[Deployment.WindowsPrivateFile]::Publish`.
- Modify: `scripts/deployment/saved-worker-engine.mjs`, adding the new file to the saved helper list.

- [x] Green stopped-history run (78 receipts) plus a same-SHA Contracts run; record acceptance here.
  - **Accepted** at `9f9daf14` (tag `gate72-production2`).
    - Red: run `41006686134` failed as expected; the baseline shard could not find `windows-stopped-history-handoff-state-intent.ps1`.
    - Stopped-history run `41008918518` passed on all ten shards. The acceptance job `123918523535` required all 78 receipts.
    - Same-SHA Contracts run `41008905588` passed. The saved-engine helper order is pinned in both lists.

### Tasks 3–7 (gates 73–77)

Each gate gets its own plan file, written when its predecessor is accepted. That way the contract reflects the code as it actually landed. Each follows the same steps: contract first (expect red) → shared production change → green stopped-history run → same-SHA Contracts → acceptance.
