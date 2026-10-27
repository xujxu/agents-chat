# Lock Settlement Publisher Death Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the real terminal publisher and prove a distinct sixth actor can natively reopen the exact immutable settlement without continuation authority.

**Architecture:** Reuse the terminal publisher/observer after their first-publication gate. Add only fixture hold/modes and a dedicated settlement-death helper. Preserve five separate prior actor identity tuples without recursively nesting metadata.

**Tech Stack:** PowerShell native fixture, Node.js transport, exact process-handle death checks, GitHub Actions only.

---

### Task 1: Isolated held publisher and fresh reader

**Files:**
- Create: `tests/deployment-windows-lock-settlement-observation.mjs`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`

- [x] Accept normal immutable terminal publication before pushing this
  increment. Implementation `21c332ea372be886428ff12c0625080b6619ee45`
  passed focused run `40465600056` / job `122060112902` with all 27
  actual required receipts and Windows Contracts run `40465603194` /
  job `122060123168`. Keep this evidence separate from publisher death.
- [ ] Implement `holdLockRetirementSettlement` using existing fixture
  argument builders and native transport:

```javascript
args: [...fixtureArgs({ source, control, identity, previous }),
  '-ObserveRetirement', ...descriptorArgs('Retirement', previous.retirement),
  '-SettleRetirement', '-Hold']
```

  Require the directory-retired predecessor, exact ready controller/bridge,
  twelve-field native settled result, original descriptors and false
  authority flags. Add `directoryRetirementActor` as the predecessor's four
  identity fields, set the root identity to the actual fifth publisher,
  and preserve the original/intent/owner-executor tuples. Allow fixture
  hold with settlement only; no production hold flag.
- [ ] Implement `assertLockRetirementSettlementAfterDeath`. Prove all five
  prior controllers/bridges absent and distinct from the sixth actor.
  Match all four descriptors against actual bytes/hash/dev/ino, bind
  terminal creator to the actual fifth controller/bridge, and require
  twelve exact native result fields plus actual lock absence.
  Wrong terminal inode, same-bytes terminal replacement and a foreign
  replacement lock directory must refuse and preserve the supplied input.
  Restore only fixture-owned negative inputs and revalidate the native
  result. Require ordinary acquire/release refusal and unchanged original
  state/completion bytes and identities. Remove only the four fixture
  records after all evidence passes.

### Task 2: Real fifth-publisher death and sixth actor

**Files:**
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add crash/resume `lock-settled-history` modes, excluded from ordinary
  committed-lock publication. Crash routes to the held settlement helper;
  resume routes to its fresh verifier.
- [ ] Add a host boundary following the same committed-owner, intent,
  owner-file and directory-executor death sequence. Start the fifth Node:

```powershell
$settler = [Deployment.WindowsControllerProcess]::Start($node,
    @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
        $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
        'crash-lock-settled-history', $historyActor), $control, $environment)
```

  Consume `INACTIVE_HISTORY_LOCK_SETTLED_HELD` within the existing
  120-second budget, capture its exact native bridge process handle, kill
  that exact fifth Node, await Node and bridge within the existing
  15-second budgets, then start `resume-lock-settled-history` as the sixth
  actor. Preserve terminal/state bytes through host checks.
- [ ] Require actual receipt:

```text
PASS: actual lock settlement publisher death preserves exact terminal evidence for a distinct sixth native actor without continuation authority
```

  Run same-SHA focused history plus Windows Contracts and inspect all
  28 actual receipts. This covers implemented production behavior; do not
  manufacture a missing-function red. Persist SHA/run/job evidence.
  Fresh-attempt admission, state continuity and public repeat lifecycle
  remain separate gates.
