# Windows Restart Handoff Task Receipt Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the gate 70 checkpoint, a distinct inactive retirement authority retires each `task-maintenance` receipt of the completed handoff operation. The handoff evidence (`inactive-handoff-*`, `retired-*`) and the accepted state stay exact. Inactive deployment retirement stays refused until handoff evidence retirement exists.

**Architecture:** Use `openWindowsInactiveTaskRetirement` and `retireNextWindowsTaskFile` unchanged, from the fresh closeout actor (gate 69 revision). Deployment retirement (`beginWindowsInactiveDeploymentRetirement`) needs worker-operation evidence and ignores handoff evidence. It is therefore the next, not-yet-supported increment and must stay refused here.

**Tech Stack:** `tests/deployment-windows-restart-handoff-closeout.mjs` (`commitment` shard) and `.github/workflows/deployment-lifecycle.yml` (77 receipts). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

Revision: run `40997802478` passed gates 69–70 but refused `openWindowsInactiveTaskRetirement` while the checkpoint preparer (the proof actor) was still alive. Inactive retirement can only be reopened, so the proof/checkpoint actor (`handoff-closeout-proof`) now exits first and a further distinct actor (`handoff-closeout`) retires the receipts and restores the archived fixture.

- [x] `openWindowsTaskRetirement` is refused. `openWindowsInactiveTaskRetirement` starts with `retiredFiles: 0`, and its total equals the `task-maintenance` inventory.
- [x] `beginWindowsDeploymentRetirement` and a copied retirement handle are refused.
- [x] Each `retireNextWindowsTaskFile` advances `retiredFiles` by one, `check()` matches, and the inventory shrinks by one. A further retirement is refused.
- [x] The handoff evidence names and the accepted state digest are unchanged.
- [x] Receipt `PASS: handoff-aware completed operation retires each exact task receipt through its distinct inactive retirement authority while handoff evidence and accepted state remain exact`.

### Task 2: Production

- [ ] Only if Actions shows a gap.

### Task 3: Acceptance

- [ ] Stopped-history run green on all 10 shards with 77 receipts, plus a same-SHA Contracts run.
