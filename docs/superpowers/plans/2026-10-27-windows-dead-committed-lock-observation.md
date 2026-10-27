# Dead Committed Lock Observation Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a distinct actor obtain descriptor-only native observation of a dead committed handoff while preserving the original state, lock and both handoff records.

**Architecture:** Add an explicit read-only native bootstrap for the exact prepared/committed pair. It pins the new directory and owner from the native committed record before distinguishing them from the already retired original lock entries. Complete original archive/task/state proof and independently reconstructed prepared/committed bindings are mandatory before returning the scope. Ordinary readers receive no exception and the observer cannot publish, delete or start work.

**Tech Stack:** PowerShell 7, WindowsPrivateFile retained handles, existing archive and dead-owner proof, Windows GitHub Actions only.

---

### Task 1: Add native third-actor observation contracts

**Files:**
- Create: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Use scalar Control, Source, ControllerPid/Identity, AttemptId and exact prepared/committed dev/ino/bytes/hash parameters. Load the standard native Add-Type set, original cleanup helper and new committed-observation helper; retain the normal controller watcher.

```powershell
$scope = Open-AgentsChatStoppedHistoryHandoffCommittedObservation $Control `
    $ControllerPid $ControllerIdentity $AttemptId $preparedDescriptor $committedDescriptor
$observation = Get-AgentsChatStoppedHistoryHandoffCommittedObservation $scope `
    $ControllerPid $ControllerIdentity
[Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 8 -Compress))
```

  Use the established aggregate-cleanup convention. No fixture mutation occurs in this native entry.

- [ ] In `resume-lock-committed-history`, after native actor/bridge absence and actual receipt/lock descriptor checks, call the fixture and require:

```text
status = committed-handoff-observed
attemptId = original attempt
prepared / committed = exact retained descriptors
lockIdentity / lock = actual native descriptors in original receipt
runtimeAuthority = false
lockAuthority = false
```

  A wrong committed inode must refuse. Move the original owner to an exact fixture pathname, publish identical bytes as a distinct owner inode and require refusal without deleting or changing that replacement; remove only that replacement and restore the original owner. Recheck original owner, prepared, committed, state and completion bytes/identities before the existing fixture-only cleanup.

- [ ] Add required actual receipt:

```text
PASS: native dead committed handoff observation pins exact lock and original archive under a distinct actor without authority
```

  Commit/push the fixture contracts, dispatch focused history and download actual logs. Require the missing committed-observation helper after all three prior real actor-death boundaries are reached.

### Task 2: Bootstrap only the exact independently pinned new lock

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`
- Modify: `scripts/deployment/windows-inactive-worker-cleanup.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock.ps1`

- [ ] Add optional internal `HistoryHandoffObservation` request to native cleanup opening, allowed only with `HistoryArchive` and never with `HistoryWrite`. The dedicated opener constructs the request from validated scalar inputs. Existing calls do not set it and retain their original behavior.

- [ ] After original task/worker records are validated but before opening old worker-retirement entries, initialize the dedicated observation:
  - Validate exact request fields, attempt GUID and the two descriptor filenames.
  - Pin prepared and committed files through existing native descriptor checks.
  - Decode exact prepared owner fields with duplicate-safe maintenance parsing; prove that original PID/start identity absent using native retired-owner validation and pinned original state updatedAt.
  - Decode exactly the existing thirteen committed root fields. Validate canonical timestamp not before owner creation, original owner/controller equality and absent original creator bridge.
  - Pin actual `Control/lock` and compare native identity to the receipt; pin only exact `lock\owner.json` with the receipt's full descriptor. Require exact native serialized original owner bytes and exactly that single child.
  - Retain all handles and descriptors under an independent `HistoryHandoffLockObserver` role. Never set the publisher role.

- [ ] Only after that native initialization, distinguish the two exact original retirement entries `lock\owner.json` and `lock` from the separately pinned new lock. Count those original entries as retired without opening the new artifacts as the old lock. All other prefix checks stay unchanged.

  After the original task folder/final receipt is initialized, run complete original history recovery to pin and verify its completion before the ordinary cleanup loop invokes the scoped lock verifier. The original task policy, retired runtime/worker absence, state and all archived evidence must pass before any scope is returned. Any bootstrap/open failure closes all retained handles and keeps every file.

- [ ] Extend the exact native lock verifier with a separate mutually exclusive observer role. Publisher checks retain live-owner proof; observer checks use native retired-owner proof. Both roles require retained directory/owner handles, exact identity/bytes/descriptor, complete archived prefix and pinned completion. No directory-only or owner-only observation is accepted in this increment.

### Task 3: Independently rederive both immutable bindings

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`

- [ ] The public internal opener calls the normal cleanup bootstrap and the full committed observer before returning. The observer twice:
  - verifies current observer PID/start identity;
  - requires the exact two-file handoff namespace;
  - checks both retained files and exact original bytes/descriptors;
  - calls existing native retired-prepared binding to reconstruct the entire prepared record from original archive, state, task/configuration and absent owner;
  - reconstructs the committed record from native context, actual prepared/directory/owner descriptors, validated original dead creator and canonical recorded timestamp;
  - performs strict native JSON binding, then repeats exact lock, full original cleanup and observer identity checks.

  Return only the bounded observation described in Task 1. All failures poison the context and throw an explicit contextual error; cleanup never deletes evidence. Observer scopes are not accepted by publisher functions or ordinary release.

- [ ] Push implementation and run focused history plus Windows Contracts on one SHA. Verify all seventeen prior receipts plus the new native observation receipt, including changed-owner inode refusal. Record actual SHA/run/job evidence and push the plan update.

## Subsequent destructive recovery gate

Observation alone cannot retire a lock. Directory-only or malformed lock states remain explicit blockers. Before deleting an exact dead owner's file, a separate native retirement role must publish an immutable operation-bound retirement intent that survives owner deletion and directory deletion. Fresh actors must revalidate that intent, the original prepared/committed descriptors, exact directory identity and unchanged original archive/state before continuing either deletion. A terminal settlement record and its own real interruption coverage are required before fresh-attempt admission. No temporary rename, name-only allowance, generic state substitution or ordinary reader relaxation is an acceptable shortcut.
