# Lock Retirement Intent Death and Observation Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the real retirement-intent publisher and let a third actor natively revalidate that exact intent and unchanged committed lock without deletion authority.

**Architecture:** Reuse the existing committed-lock death boundary, add a distinct retirement publisher actor with a held native scope, then kill it and await its exact bridge. A separate read-only native retirement observer bootstraps the exact three-record namespace and independently rebuilds all existing bindings. The original two-record observer path remains unchanged and continues refusing an extra intent.

**Tech Stack:** PowerShell 7, exact native descriptors and process-absence proof, retained controller transport, Windows Actions.

---

### Task 1: Real second death and native third-actor contracts

**Files:**
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Create: `tests/deployment-windows-lock-retirement-observation.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add fixture `Hold` permitted only with `PrepareRetirement`. After successful native publication and actual creator bridge verification, emit the standard bounded ready frame with descriptor-only intent value, then retain the original scope by waiting on stdin under the existing controller watcher. Do not add a production hold flag.

- [ ] Add `lock-retirement-history` host boundary. Its first actor executes existing `crash-lock-committed-history`; kill that real owner and await its exact bridge as before. Start distinct `crash-lock-retirement-history` with the original committed metadata. It natively opens original proof and publishes/holds the intent, then emits:

```text
INACTIVE_HISTORY_LOCK_RETIREMENT_HELD <bounded-json>
```

  Metadata preserves original prepared/committed/owner/directory descriptors and original actor/bridge identity separately from the fresh retirement publisher actor/bridge identity. Capture the second native bridge process handle before killing the second Node actor; await both exact exits. Keep 120-second actor and 15-second bridge budgets.

- [ ] Start distinct `resume-lock-retirement-history`. Preserve current history restoration behavior but skip ordinary archive closeout while the new lock/intent exist. Verify both former actors/bridges absent, original prepared owner and committed creator bind the first actor, and retirement creator binds the second actor.

  Co-locate the third-actor record/native-entry checks in the new test helper instead of adding another independent responsibility to the already large runtime-session fixture. Verify exact intent root fields, descriptors, timestamp and all native dev/ino/bytes/hash values.

- [ ] Add native fixture mode `ObserveRetirement` with exact RetirementDev/Ino/Bytes/Sha256 scalars, mutually exclusive with publication/hold. Source the new native retirement-observation module and call:

```powershell
$scope = Open-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Control `
    $ControllerPid $ControllerIdentity $AttemptId $prepared $committed $retirement
$observation = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $scope `
    $ControllerPid $ControllerIdentity
```

  Require exactly eleven bounded response fields: status, attemptId, previousOperationId, project, prepared, committed, retirement, lockIdentity, lock, runtimeAuthority and lockAuthority. Status is `lock-retirement-observed`; both authority flags are false. Wrong intent inode and identical-byte owner replacement inode must refuse without changing evidence.

  Ordinary archive/acquire/release and the old two-record observer must continue refusing. Recheck all three records, owner, directory, original state and archive completion before existing fixture-only cleanup. Production removes nothing.

- [ ] Add two required actual receipts:

```text
PASS: actual lock retirement intent publisher death preserves exact evidence for a distinct third actor without cleanup authority
PASS: native retired lock intent observation revalidates exact creator death and unchanged committed lock without mutation
```

  Commit/push the fixture contracts, dispatch focused history and download actual red. Require the missing native retirement-observation module only after both real actor/bridge deaths and retained intent verification.

### Task 2: Explicit three-record read-only bootstrap

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-intent.ps1`

- [ ] Add optional internal Retirement descriptor to the committed opener/request. With it present, validate the exact sixth request field and third filename/descriptor before pinning. With it absent, preserve the current exact five-field/two-record behavior.

  After the existing exact prepared/committed/directory/owner pinning and observer-role initialization, call the separate retirement initializer. No file may be ignored by filename alone.

- [ ] Implement `Initialize-AgentsChatStoppedHistoryHandoffLockRetirementObservation(Context,Descriptor)`. Pin the exact intent, decode exactly its fourteen fields, validate its phase/attempt/scope and native timestamp, and explicitly prove both original retirement creator controller and bridge absent. Retain its handle, actual descriptor, original creator and timestamp.

  Set only `HistoryHandoffLockRetirementObserver`, never the publication role. The existing base cleanup still proves original archive/state/task/runtime settlement and exact new lock before returning. Original owner/bridge absence and retirement creator/bridge absence are separate native requirements.

- [ ] Update intent assertion to accept exactly one independent role: live retained retirement publisher or read-only retirement observer. Reject mixed roles. Both still require full retained committed observation and exact intent handles/descriptors. Reuse the native intent record builder and strict JSON binding; there is no recursive call from intent assertion into committed observation.

- [ ] Implement the new opener as the explicit optional-descriptor committed bootstrap and verify the resulting independent retirement-observer role. Implement the getter with two complete committed-observer/intent assertion passes and current third-controller PID/start checks, then return only the eleven fields above. All errors poison/close the scope through established contextual/aggregate conventions and retain every file.

- [ ] Commit/push implementation and run focused history plus Windows Contracts on one SHA. Verify all nineteen prior receipts plus the two new executed receipts; record actual red/green SHA/run/job evidence and push it.

## Next guarded deletion gate

The validated intent supplies durable evidence for future exact owner removal, but observation itself cannot delete. Native owner deletion must retain/reopen the exact file identity through the existing retirement handle API and support a fresh actor when that owner has already been removed. Directory deletion needs its own exact retained identity and a surviving intent, with explicit settlement after it disappears. Real actor death at both deletion boundaries remains mandatory; directory-only states lacking a validated intent stay blocked. No public routing, state write or worker authority follows from this increment.
