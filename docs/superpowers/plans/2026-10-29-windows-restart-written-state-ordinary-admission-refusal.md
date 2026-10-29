# Windows Restart Written-State Ordinary Admission Refusal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the exact live restart owner has written its acknowledged next preflight state and still holds its committed `lock`, ordinary inactive task admission (`captureWindowsInactiveTaskAdmission` / native `New-AgentsChatManagedTaskAdmission -Inactive`) must refuse while stopped-history handoff evidence remains, publishing no `task-maintenance`.

**Architecture:** Continues `docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md` ("Lock and command integration": ordinary paths stay conservative; handoff-aware internal paths share one verifier). The spec requires each increment to preserve refusal of the not-yet-supported next increment. The next increment is handoff-aware inactive admission for the live committed owner, so this gate pins the ordinary path's refusal first. The existing `restart-state-written-history` boundary (crash step `crash-lock-committed-history`, mode `resume-restart-state-written-history`) gains the check. After the state-write fixture exits, the Node actor (the lock owner, `record.newOwner.pid === process.pid`) opens an inactive task scope. That scope's observation must equal the prepared record's `observation`. The actor then requests ordinary admission and expects `... requires its handoff-aware admission.`

**Tech Stack:** Node fixtures under `tests/`, `scripts/deployment/windows-managed-task.mjs`, `scripts/deployment/windows-task-admission.ps1`, GitHub Actions (`deployment-lifecycle.yml`, stopped-history `commitment` shard, whose last boundary is `restart-state-written-history`). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

**Files:**
- Modify: `tests/deployment-windows-restart-preparation.mjs` (`refuseAdmission`, inactive scope, refusal, no `task-maintenance`, PASS line)
- Modify: `tests/deployment-windows-lost-runtime-session.mjs` (`refuseAdmission` for `resume-restart-state-written-history`)
- Modify: `.github/workflows/deployment-lifecycle.yml` (one receipt, 67 total)

- [x] Receipt `PASS: ordinary inactive task admission refuses the exact live restart owner written preflight while handoff evidence remains without publishing maintenance`.
- [ ] Actions red: `commitment` shard fails because ordinary admission is not refused (or publishes `task-maintenance/admission.json`).

### Task 2: Production refusal

**Files:**
- Modify: `scripts/deployment/windows-managed-task.mjs` (`captureTaskAdmission` refuses before any native request)
- Modify: `scripts/deployment/windows-task-admission.ps1` (native `-Inactive` refusal, defence in depth)

- [ ] JS: in `captureTaskAdmission`, after `externalWorkerDirectory`, if any control entry matches the Windows handoff namespace (`inactive-handoff-*.json`, `retired-*-inactive-rollback-history-intent.json`, `retired-*-inactive-rollback-history-complete.json`, case-insensitive), throw `refused(new Error('Stopped-history handoff evidence requires its handoff-aware admission.'))`.
- [ ] Native: in `New-AgentsChatManagedTaskAdmission`, before publishing, the same namespace check throws `Stopped-history handoff evidence requires its handoff-aware admission.`.
- [ ] Ordinary admission without handoff evidence is unchanged: the check runs only on the control entry names, and ordinary `acquireLock` already refuses those names, so no existing admission path can see them.

### Task 3: Acceptance

- [ ] Focused and Contracts runs green; all ten shard logs merged and all 67 receipts present.
