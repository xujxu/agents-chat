# Fresh Restart Preparation Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive a fresh live prospective owner after a settled dead successor, binding the entire six-record chain without publishing or granting continuation.

**Architecture:** Keep the ninth actor solely read-only and preserve its accepted six-record proof. A distinct tenth actor reopens that proof, then requires a separate restart-preparer role. Derive a fifteen-field preparation from the original native pinned template with a linked predecessor containing the dead successor preparation, its abandonment terminal and the original predecessor chain.

**Tech Stack:** PowerShell strict native retained proof, bounded Node.js transports, GitHub Actions only.

---

### Task 1: New preparation contract before implementation

**Files:**
- Create: `tests/deployment-windows-history-handoff-restart.ps1`
- Create: `tests/deployment-windows-restart-preparation.mjs`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [x] Accept `8a6e9a8e8b49ee363b915f5f8b703b2d5f87ca76`, focused
  `40546364628` / `122337988969`, all 33 actual receipts, plus Contracts
  `40546370785` / `122337995657`.
- [ ] Keep all ninth-observer assertions, print its actual identity and
  exit without removing evidence or restoring the archive fixture. Start a
  distinct tenth actor under a separate unchanged 120-second budget.
- [ ] Tenth actor proves prior controller/publishing-bridge identities
  absent, six exact files and original state/completion identities. Open
  native six-record observation, validate its bounded ready frame and
  accept only `{"type":"prepare"}` before loading the missing factory.
  Bootstrap and preparation requests each retain 45-second bounds.
- [ ] First invoke this scalar-request factory without a new role and
  require `Restart preparation requires its independent native role.`:

```powershell
Get-AgentsChatStoppedHistoryHandoffRestartRecord -Context $scope `
  -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity `
  -AttemptId $attempt -OperationId $operation -Token $token -CreatedAt $created
```

- [ ] Enable only `HistoryHandoffRestartPreparer`; reject reused original
  operation, reused dead-successor attempt/token, pairwise duplicate new
  identifiers and time before abandonment. Valid identifiers must avoid all
  seven original/successor owner GUIDs and be pairwise distinct.
- [ ] Compare the complete actual native fifteen-field result, including
  all original template fields and exact live owner, using typed JSON
  binding before returning a bounded five-field fixture projection. Do not
  widen the shared wire parser or send a possible 1-MiB preparation through
  its 128-KiB frame. Production factory still returns the complete record
  with a strict 1-MiB bound.

```text
phase=stopped-history-handoff-restart-prepared
attemptId=<fresh attempt>
newOwner=<fresh exact live watched controller>
predecessor={
  attemptId:<dead successor attempt>,
  prepared:<exact successor preparation>,
  abandoned:<exact successor abandonment>,
  predecessor:{attemptId,prepared,committed,retirement,terminal}
}
```

- [ ] Preserve every original field except phase, attempt and new owner,
  add only predecessor, and require no new file/lock/state writes.
  Keep ordinary acquire/release refused even for the new live owner.
  Only fixture cleanup removes the six input records afterward.
- [ ] Require the actual 34th receipt:

```text
PASS: native restart preparation derives a fresh live owner bound to settled six-record evidence without publication or authority
```

Push test-only and run:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
```

Require actual missing `windows-stopped-history-handoff-restart.ps1` after
the tenth actor's verified six-record ready frame and explicit prepare
command. Earlier failure or timeout is not valid red.

### Task 2: Native fresh-owner derivation

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart.ps1`

- [ ] Require the independent restart-preparer plus six-record abandoned
  observer, no live successor-preparer/publisher or abandoner role, and the
  exact watched current controller. A read-only record is not a capability.
- [ ] Validate scalar inputs before full proof. Fresh IDs cannot equal
  the original operation/attempt/owner IDs or the dead successor's
  attempt/owner IDs; time must be canonical and at least abandonment time.
- [ ] Derive the original fourteen-field template only from its actual
  native pinned file with nullable parsing explicitly enabled. Reuse the
  native live-owner helper and actual descriptors to produce the fifteen
  fields and linked predecessor above, never caller JSON.
- [ ] Bracket derivation with complete existing abandoned observation;
  that parent retains both native terminal proofs. Keep pure scalar/
  binding validation nonrecursive and free of file/state writes.
- [ ] Require same-SHA focused 34 actual receipts plus Windows Contracts,
  persist exact SHA/run/job evidence before acceptance.

Publication and actual preparer death must pass separately before
new-lock publication. Live committed capability, original-state snapshot,
first state transition, handoff-aware release, public routing and actual
application repeat lifecycle remain later gates.

## Valid missing-factory red

Test-only `401fadac637cbb12f45f472e3f71a1e117437d60`, focused run
`40554490371` / job `122366776316`, reproduced the accepted ninth-actor
six-record receipt at `2026-10-27T18:24:14.9188612Z` and preserved all six
records for the actual distinct tenth actor. At
`2026-10-27T18:24:40.1965469Z`, its verified six-record bootstrap and
explicit prepare request reached the missing
`windows-stopped-history-handoff-restart.ps1`. The missing module produced
exit 1, not a timeout or earlier fixture failure.

## Native implementation

The independent restart-preparer derives a full fifteen-field record from
the original pinned fourteen-field template. Scalar preflight excludes all
seven old owner/attempt IDs and pairwise duplicate new IDs, binds the exact
watched controller, and requires canonical time at or after abandonment.
The existing live-owner helper verifies native identity; exact native file
descriptors bind the six-record ancestry. Complete abandoned observation
brackets derivation. No file, lock, task, runtime or state is published.
The fixture compares the complete typed record before sending only its
bounded five-field projection through the unchanged worker wire.
