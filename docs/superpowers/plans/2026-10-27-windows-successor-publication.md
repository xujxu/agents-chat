# Native Successor Publication Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish exactly one fresh successor preparation while retaining every predecessor record and granting no lock or runtime authority.

**Architecture:** Reuse the accepted native successor derivation and add a separate publisher role. Extend only its retained context's namespace with a strictly rederived fifth file; ordinary four-record readers continue to refuse it. A nonrecursive binding helper is required because namespace verification cannot call the full settlement getter that invokes namespace verification.

**Tech Stack:** PowerShell native retained files, strict JSON binding, Node.js interruption fixtures, GitHub Actions only.

---

### Task 1: Publication contract first

**Files:**
- Create: `tests/deployment-windows-history-handoff-successor-publication.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-lock-settlement-observation.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [x] Accept derivation `c5ea3f08`: focused `40476262515` /
  `122095142472` passed all 29 actual required receipts; same-SHA
  Contracts `40476266395` / `122095156418` passed.
- [ ] Add fixture-only `PublishSuccessor`, requiring `PrepareSuccessor`.
  First derive and verify the full preparation, then load the missing
  publication module. Require independent publisher-role refusal before
  mutation, publish under the separate role, inspect the exact bounded
  observation and refuse a duplicate publication without changing bytes.
- [ ] Require the actual fifth file's hash/length/dev/ino and strict JSON
  to match native derivation. Reuse the original preparation assertions,
  add the fifth file to unchanged evidence checks, keep ordinary
  acquire/release refused and the lock absent, and require plain
  four-record reopening to refuse the unexpected successor.
- [ ] Require the 30th actual receipt:

```text
PASS: native successor publication retains every predecessor and creates one exact preparation without continuation authority
```

Push test-only and inspect focused Actions failure on missing
`windows-stopped-history-handoff-successor-publication.ps1`, not a timeout
or an earlier failure.

### Task 2: Nonrecursive binding and create-only publication

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-successor.ps1`
- Create: `scripts/deployment/windows-stopped-history-handoff-successor-publication.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`

- [ ] Extract `Get-AgentsChatStoppedHistoryHandoffSuccessorBinding` with the
  current scalar parameters and unchanged role, GUID, owner, time, size and
  original-binding checks. Derive predecessor descriptors directly from
  retained native files after strict terminal assertion. Read the original
  fourteen-field template only from the actual pinned prepared file;
  validate its exact schema and derive the previous state timestamp from
  its pinned `oldState` bytes. Replace only phase, attempt and native live
  owner, then add predecessor descriptors. It must not call full settlement
  observation, namespace verification or `Get-AgentsChatStoppedHistoryHandoffBinding`:
  the latter opens state files and runs full cleanup, which is not an
  appropriate callback for repeated namespace assertions. Keep
  `Get-AgentsChatStoppedHistoryHandoffSuccessorRecord` as the full getter:
  validate scalar inputs through the binding helper, recheck full settlement,
  rederive the binding and recheck full settlement again before returning.
  The full settlement getter still invokes the existing retired prepared
  binding verifier, which rederives actual task/state/configuration/runtime
  evidence. Thus the template is not trusted caller JSON or a replacement
  for original native proof, and namespace assertions add no state handles.
- [ ] Add `Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared(Context)`.
  Require both independent preparer/publisher roles and retained successor
  file/request. Match actual descriptor and strict fifteen-field JSON
  against the nonrecursive binding helper, including actual live owner and
  predecessor descriptors.
- [ ] Add this namespace branch after the terminal assertion:

```powershell
if ($Context.ContainsKey('HistoryHandoffSuccessorPrepared')) {
    Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared $Context
    $names += $Context.HistoryHandoffSuccessorPrepared.Descriptor.path
}
```

Do not change ordinary bootstrap schemas or accept a caller's extra
filename list. Only a retained publisher scope can verify the fifth file
in this increment.
- [ ] Implement `Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared`
  with the same scalar parameters as the existing record factory.
  Require `HistoryHandoffSuccessorPublisher` before mutation. Refuse an
  already-retained successor, derive the record through the full getter,
  verify the physical absent lock immediately before create-only
  `WindowsPrivateFile.Publish`, and retain `File`, `Descriptor`, `Request`.
  Twice recheck complete settlement plus strict successor binding.
  Return only the native descriptor; poison publication failures and
  preserve every file.
- [ ] Implement `Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation`
  with context/controller parameters. Recheck full settlement and strict
  successor binding twice. Return exactly:

```powershell
[ordered]@{
    status='successor-prepared'
    attemptId=$record.attemptId
    previousAttemptId=$record.predecessor.attemptId
    previousOperationId=$record.previousOperationId
    project=$record.project
    prepared=$Context.HistoryHandoffSuccessorPrepared.Descriptor
    predecessor=$record.predecessor
    runtimeAuthority=$false
    lockAuthority=$false
}
```

- [ ] Push implementation and require same-SHA focused history plus
  Windows Contracts; inspect all 30 actual receipts and persist evidence.

### Next boundary

Actual successor-publisher death and explicit five-record native reopening
must pass before new-lock publication. Neither this fifth file nor its
prospective owner is a continuation capability. State continuity, release,
public routing and actual repeat application lifecycle remain unimplemented.

## Fixture budget correction before valid red

Test-only `90134a4fa0b957dafc22385a8270a0e1a9e467c9`, focused run
`40479237413`, job `122105078348`, timed out in the sixth actor at
`2026-10-27T09:46:44.4788061Z`. It combined all accepted settlement
negative cases, derivation and the added publication invocation in the
existing 120-second takeover budget. This is not accepted publication red.

Keep all checks but separate responsibilities: a sixth
`check-lock-settled-history` actor runs settlement proof and derivation,
checks unchanged evidence and ordinary refusal, then exits without deleting
records or restoring the archive fixture. A seventh
`resume-lock-settled-history` actor independently reopens the full native
settlement and runs publication, duplicate/refusal checks and original
fixture restoration. Both actors retain their individual 120-second host
budgets, native invocations retain 45 seconds, and all bridge-death waits
remain 15 seconds. Push this fixture split with the native publication
module still absent; require actual missing-module red before implementation.
