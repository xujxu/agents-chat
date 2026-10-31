# Directory Retirement Executor Death Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the real directory-deletion controller after native deletion and prove a distinct fifth actor can recover the exact absent stage without mutation authority.

**Architecture:** Extend only fixture modes and reuse accepted native directory retirement. Preserve separate identity tuples for committed owner, intent publisher, owner-file executor and directory executor; do not recursively embed prior metadata. The host captures the exact native bridge process handle before killing each Node controller and waits for that bridge to exit.

**Tech Stack:** Node.js fixture transport, PowerShell native fixture, Windows Actions.

---

### Task 1: Isolated directory-death fixture

**Files:**
- Create: `tests/deployment-windows-directory-retirement-observation.mjs`
- Modify: `tests/deployment-windows-lock-retirement-observation.mjs`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`

- [ ] Export the existing descriptor/fixture argument builders for the new
  focused fixture; do not duplicate protocol argument construction.
- [ ] Implement a held directory executor with this transport request:

```javascript
args: [...fixtureArgs({ source, control, identity, previous }),
  '-ObserveRetirement', ...descriptorArgs('Retirement', previous.retirement),
  '-RetireDirectory', '-Hold']
```

  Require previous `ownerRetired === true`; verify ready controller and
  bridge identities, eleven native result fields, exact original descriptors,
  false authority flags and actual directory absence. Store the previous
  executor's four identity fields as `ownerRetirementActor`, preserve the
  existing `originalActor` and `retirementActor`, and replace only the root
  identity tuple with the actual directory executor.
- [ ] Permit fixture `Hold` with directory retirement, preserving all other
  incompatible-flag refusals. Do not add a production hold flag.
- [ ] Fresh observation validates all four prior Node/bridge identities as
  absent and distinct from the fifth actor. Pin original prepared,
  committed and intent bytes/hash/dev/ino against retained descriptors;
  assert prepared original state, original owner and all three publication
  creator tuples. Require actual owner/directory absence, strict eleven
  field native directory-retired observation and identical native retry.
  Wrong intent identity and changed original state must refuse and retain
  all supplied bytes; restore only fixture-owned negative inputs. Recheck
  records/state/completion identities and both ordinary lock refusals.
  Only after all evidence passes may the fixture remove its three records.

### Task 2: Real controller/bridge death and fifth actor

**Files:**
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add crash/resume `lock-directory-retired-history` modes and exclude the
  special crash mode from ordinary committed-lock publication. Route crash
  to the held directory helper and resume to its fresh verifier.
- [ ] Add host boundary after owner-retired. Run the existing committed
  publisher, intent publisher and owner executor death sequence, then start:

```powershell
$directoryExecutor = [Deployment.WindowsControllerProcess]::Start($node,
    @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
        $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
        'crash-lock-directory-retired-history', $historyActor), $control, $environment)
```

  Consume readiness within the unchanged 120-second actor budget. Capture
  the exact ready bridge process handle, kill this exact Node process,
  await Node and bridge within the existing 15-second budgets, assert
  actual directory absence and unchanged original state, then run
  `resume-lock-directory-retired-history` as a distinct fifth Node actor.
- [ ] Require actual receipt:

```text
PASS: actual directory retirement executor death leaves exact immutable evidence for a distinct fifth native actor without authority
```

  Push only after the preceding normal-directory-deletion gate is accepted.
  Dispatch focused history and Windows Contracts on one SHA. This is new
  interruption coverage of already implemented production behavior, not an
  artificial missing-function red. Inspect all 26 actual receipts and
  persist SHA/run/job evidence. No terminal settlement, fresh operation,
  state write, public routing or worker authority is introduced.

## Accepted execution evidence

- Coverage SHA: `1c12afa285f5511a3cea2445fedff9ee59bc26c5`.
  Same-SHA focused history
  [40457144350](https://github.com/xujxu/agents-chat/actions/runs/40457144350),
  job `122032992880`, and Windows Contracts
  [40457147127](https://github.com/xujxu/agents-chat/actions/runs/40457147127),
  job `122033004997`, both succeeded.
- All 26 required receipts were matched to actual timestamped `Z PASS:`
  lines, not workflow echoes. The real directory-executor death and distinct
  fifth native actor receipt appeared at `2026-10-27T06:07:27Z`.
- Host killed the exact fourth Node controller after native directory
  deletion and waited for its captured native bridge handle to exit within
  unchanged budgets. The fifth actor proved all four prior controller/bridge
  identities absent, exact immutable records/state/completion, actual lock
  absence, native idempotent retry, wrong-intent-identity and changed-state
  refusal, and ordinary acquisition/release refusal.
- There was no new production mutation in this test-only increment and no
  artificial missing-function red. Validation ran only in GitHub Actions.
  Terminal settlement, a fresh operation and the final full matrix remain
  unaccepted.
