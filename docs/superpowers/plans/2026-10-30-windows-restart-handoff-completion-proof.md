# Windows Restart Handoff Completed-Operation Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the handoff-aware inactive transaction completes (gate 68) and both the transaction and its scope release their leases, the existing read-only inactive completion proof observes the completed handoff operation. The active proof stays refused. This is the entry point for the completed-operation closeout that must happen before the lock is released (design: "After a write, release must follow new-operation retirement and settlement").

**Architecture:** Use `openWindowsInactiveTaskCompletionProof` unchanged. It verifies the completion-record chain, controller and bridge absence, the retired runtime's empty Job and its single runtime history record. The handoff scope's control directory also holds the pinned handoff records and the retired history archives; these sit outside the proof's `task-maintenance` inventory. The proof runs before the fixture stops the completed task, because it binds the running runtime.

**Tech Stack:** `tests/deployment-windows-restart-preparation.mjs` (`commitment` shard) and `.github/workflows/deployment-lifecycle.yml` (75 receipts). All validation runs only in GitHub Actions.

---

### Task 1: Test contract

Revision: the first in-process contract (`gate69-contract`) failed in run `40994368192`. The proof refuses while the original completion controller is alive, and that controller is the lock owner, which is the fixture process itself. Production behaves the same way: the deploy process exits and a distinct actor closes out. So closeout now runs in a fresh actor.

- [x] After `scope.close()`, the completed owner (`resume-restart-state-written-history`) skips its local cleanup. It publishes a closeout context outside the control directory (`os.tmpdir()/agents-chat-handoff-closeout-<sha16(control)>.json`, flag `wx`) and exits without the final state assertion.
- [x] The harness then starts a distinct actor with the same mode, the same previous actor and the extra argument `handoff-closeout` (`tests/deployment-windows-restart-handoff-closeout.mjs`). That actor asserts the owner is dead, the runtime is alive and the state digest matches.
- [x] `openWindowsTaskCompletionProof` stays refused. `openWindowsInactiveTaskCompletionProof` observes `status: observed`, `mutationAuthority: false`, `lease: released`, the owner's operation id, the archived task name, the accepted state digest and the activated runtime identity. `check()` returns the same observation, and after `close()` it is refused.
- [x] The closeout actor restores the archived fixture: it stops the task, re-registers the original definition, and removes the owner, lock, handoff records and state. It then continues the existing archive assertions.
- [x] Receipt `PASS: handoff-aware completed operation is observable through the read-only inactive completion proof after its owner exits while the active proof remains refused`.

### Task 2: Production

- [ ] Only if Actions shows a gap, for example the retired runtime history location for a handoff admission.

### Task 3: Acceptance

- [ ] Stopped-history run green on all 10 shards with 75 receipts, plus a same-SHA Contracts run.
