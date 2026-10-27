# Dead Successor Preparation Settlement Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seal the exact dead successor preparation without deleting its five-record predecessor chain or granting continuation.

**Architecture:** Keep the accepted seventh actor exclusively read-only. A distinct eighth actor reopens the same native five-record proof and acquires a separate successor-abandoner role to publish one immutable terminal. Reuse original abandonment's ten-field shape with an explicit successor phase and exact successor prepared descriptor; do not make ordinary archive readers accept extra records.

**Tech Stack:** PowerShell retained native files and process proofs, Node.js controller transport, GitHub Actions only.

---

### Task 1: Test the independent settlement before implementation

**Files:**
- Modify: `tests/deployment-windows-successor-observation.mjs`
- Create: `tests/deployment-windows-successor-abandonment.mjs`
- Create: `tests/deployment-windows-history-handoff-successor-abandonment.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [x] Accept `434f47dc8fe3067aa5340a5cb7546cd3387fa1d8`: focused
  `40517678797` / `122235438643`, 31 actual receipts, plus Contracts
  `40517683485` / `122235457299`.
- [ ] Keep all seventh-observer negative, identity, unchanged-state and
  ordinary refusal checks. Exit without fixture cleanup/restoration.
  Start a distinct eighth actor under its own existing 120-second budget.
- [ ] Reopen the five-record native observer, prove no preparation or
  successor-publication role, emit a bounded `successor-observed` frame,
  then accept only the literal `{"type":"seal"}` request. Bound bootstrap
  and actual settlement responses separately to 45 seconds. Reuse the
  retained native controller and its 15-second exit/cleanup bound.
- [ ] Load the missing native module only after that explicit request.
  First call its three-argument factory without a mutation role and
  require `Successor abandonment requires its independent native role.`;
  then set only `HistoryHandoffSuccessorAbandoner` and publish:

```powershell
Publish-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $scope $ControllerPid $ControllerIdentity
```

- [ ] Require create-only `inactive-handoff-<successorAttempt>-abandoned.json`
  and this exact ten-field record:

```text
version=1
phase=stopped-history-handoff-successor-abandoned
attemptId=<dead successor attempt>
control=<original canonical control>
project=<original canonical project>
controlIdentity=<original pinned identity>
previousOperationId=<original archived operation>
prepared=<exact successor prepared descriptor>
creator={pid,processIdentity,bridgePid,bridgeIdentity}
settledAt=<native canonical UTC, at least successor creation time>
```

- [ ] Verify actual descriptor length/hash/dev/ino, exact JSON and actual
  eighth Node/bridge creator. Require duplicate publication refusal without
  replacing terminal bytes. Preserve all five predecessor files, original
  state/completion bytes and identities, absent lock and ordinary
  acquire/release refusal. Only test-fixture cleanup removes the six files.
- [ ] Add and match this actual 32nd receipt:

```text
PASS: native successor abandonment seals only the exact dead preparation and preserves every predecessor without continuation authority
```

Dispatch focused history with the native settlement module still absent:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
```

Require actual missing `windows-stopped-history-handoff-successor-abandonment.ps1`
after the accepted seventh-observer proof and distinct eighth native ready
frame. Earlier failure or timeout is not valid red.

### Task 2: Native terminal and retained namespace

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-successor-abandonment.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`

- [ ] Require the independent abandoner role, exact dead-successor observer,
  no live preparation/publication role and no previously retained terminal.
  Derive the ten fields from actual retained proof and actual watched
  controller/bridge identities, never a caller's terminal JSON.
- [ ] Run complete native successor observation before and after the
  create-only publication, reassert physical lock absence next to the write,
  retain its exact descriptor and request, and bind the sixth namespace
  member through a nonrecursive strict assertion. Poison any publication
  failure and preserve all inputs. A duplicate cannot be retried as success.
- [ ] Push implementation and require same-SHA focused 32-receipt output
  and Windows Contracts. Save actual SHA/run/job evidence.

This terminal does not permit fresh-attempt reuse, new lock creation,
state writes, public deployment or task/runtime authority. Its own publisher
death and fresh read-only reopening remain the next interruption boundary.
