# Successor Settlement Publisher Death Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the actual successor-abandonment publisher and reopen its six exact records under an independent ninth native actor without continuation authority.

**Architecture:** Add a separate held terminal boundary, preserving the accepted normal publication and duplicate-refusal case. Extend bootstrap only with an explicit successor-abandoned descriptor and independent observer role; retain the ordinary five-record reader's refusal of the sixth file.

**Tech Stack:** PowerShell native retained handles and exact process proofs, Node.js transports, GitHub Actions only.

---

### Task 1: Actual interruption contract first

**Files:**
- Create: `tests/deployment-windows-successor-abandoned-observation.mjs`
- Modify: `tests/deployment-windows-successor-abandonment.mjs`
- Modify: `tests/deployment-windows-history-handoff-successor-abandonment.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [x] Accept `bef3ce03b9e102e68856c55ea3a658ccae1f833e`, focused
  `40531894343` / `122286660891`, all 32 actual receipts, plus Contracts
  `40531901243` / `122286681656`.
- [ ] Keep normal terminal publication's full original checks. In a separate
  `successor-abandoned-history` boundary, reproduce the six publisher deaths
  and seventh read-only proof, then hold the actual eighth native publisher
  after successful sealing. Only held publication skips duplicate refusal
  so that it retains an unpoisoned scope.
- [ ] Reuse the two acknowledged 45-second requests. Capture eighth
  Node/bridge identities and actual terminal descriptor, emit
  `INACTIVE_HISTORY_SUCCESSOR_ABANDONED_HELD`, kill that exact Node and wait
  for its captured native bridge handle within 15 seconds. Verify six file
  digests, original state and absent lock before starting the ninth actor.
- [ ] The ninth actor proves all eight preceding Node identities absent,
  the seven publishing bridge identities absent, and six exact file
  bytes/hash/dev/ino unchanged. Check actual terminal creator against the
  eighth tuple and successor prospective owner against the sixth tuple.
- [ ] Call the missing native reader with explicit descriptors and require
  exactly these twelve observation fields:

```text
status=successor-abandoned-observed
attemptId=<dead successor attempt>
previousAttemptId=<original handoff attempt>
previousOperationId=<original archived operation>
project=<original canonical project>
prepared=<successor prepared descriptor>
abandoned=<successor abandoned descriptor>
predecessor={attemptId,prepared,committed,retirement,terminal}
creator={pid,processIdentity,bridgePid,bridgeIdentity}
settledAt=<actual terminal timestamp>
runtimeAuthority=false
lockAuthority=false
```

- [ ] Reject wrong terminal inode, same-bytes replacement and a foreign
  lock directory without changing input; restore only fixture-owned
  negative inputs and revalidate. Require plain five-record reader and
  ordinary acquire/release refusal, unchanged original state/completion
  bytes and identities, and exact six-file namespace. Only fixture cleanup
  may remove those six records.
- [ ] Require this actual 33rd receipt:

```text
PASS: actual successor abandonment publisher death preserves six exact records for a distinct ninth native observer without continuation authority
```

Push test-only and run:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
```

Require actual missing
`windows-stopped-history-handoff-successor-abandoned-observation.ps1`
after the eighth publisher/bridge death. No earlier failure or timeout is
valid red.

### Task 2: Explicit six-record read-only native reopening

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-successor-abandoned-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-successor-abandonment.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock-settlement-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-successor-observation.ps1`

- [ ] Add optional `successorAbandoned` only with `successor` and terminal.
  Validate the same successor GUID terminal name and 64-KiB descriptor,
  pin all six files, initialize successor first and abandonment last.
- [ ] Parse exact ten-field terminal using the default strict non-nullable
  reader. Require actual creator Node and bridge absence, canonical settled
  time and strict complete binding, retaining only
  `HistoryHandoffSuccessorAbandonedObserver`, not abandoner authority.
- [ ] Extend the nonrecursive terminal binding to exactly one independent
  publisher or observer role, never mixed. The publishing branch still
  requires its actual live watched controller/bridge; the observer branch
  requires actual retired creator identities. Keep the public terminal
  factory unavailable to read-only observers.
- [ ] Open through the complete native successor/terminal chain and assert
  the terminal. The bounded observation getter brackets a complete existing
  successor observation with strict terminal assertions; that parent
  observation retains both full terminal proofs. Return the twelve fields
  above and no runtime, lock or state-write capability.
- [ ] Require same-SHA focused 33 actual receipts and Windows Contracts,
  persist exact SHA/run/job evidence before acceptance.

Fresh-attempt admission, production committed capability, immutable state
snapshot/transition, release, public routing and actual application repeat
lifecycle remain separate gates. No record alone grants continuation.
