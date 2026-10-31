# Handoff Lock Retirement Intent Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish immutable native retirement intent before any future deletion of an exact dead committed lock.

**Architecture:** A separate native retirement-preparer role operates only on the accepted read-only committed observer scope. It derives a create-only intent from pinned prepared/committed/lock proof and fresh native recovery creator identity. The same scope may retain this one exact additional record only after full native verification; ordinary readers and new observer scopes continue refusing that namespace until interrupted-retirement recovery is implemented.

**Tech Stack:** PowerShell 7, WindowsPrivateFile create-only publication, strict native JSON binding, Windows Actions.

---

### Task 1: Intent publication contracts

**Files:**
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add optional `PrepareRetirement` switch to the native fixture. After opening and checking its existing exact observer scope, source `windows-stopped-history-handoff-lock-retirement-intent.ps1`. First require missing role to refuse with:

```text
Handoff lock retirement preparation requires its independent native role.
```

  Set only `HistoryHandoffLockRetirer`, then invoke:

```powershell
$descriptor = Publish-AgentsChatStoppedHistoryHandoffLockRetirementIntent $scope `
    $ControllerPid $ControllerIdentity
```

  Before closing the native fixture, verify the record creator bridge PID/start identity identifies that actual fixture. Return only the native descriptor.

- [ ] After the committed resumer's existing successful observation and changed-owner inode refusal, call the fixture with `PrepareRetirement`. Verify actual descriptor bytes/hash/dev/ino and this exact fourteen-field record:

```powershell
[ordered]@{
    version=1; phase='stopped-history-handoff-lock-retirement-prepared'
    attemptId=$attemptId; control=$control; project=$project
    controlIdentity=$controlIdentity; previousOperationId=$previousOperationId
    prepared=$preparedDescriptor; committed=$committedDescriptor
    newOwner=$originalDeadOwner
    lockIdentity=$originalDirectoryIdentity; lock=$originalOwnerDescriptor
    creator=@{ pid=$recoveryPid; processIdentity=$recoveryIdentity
        bridgePid=$nativePid; bridgeIdentity=$nativeIdentity }
    createdAt=$nativeUtc
}
```

  Filename is `inactive-handoff-<attempt>-lock-retirement.json`. Require timestamp canonical and not before committedAt. Require current recovery actor identity and actual native bridge identity. Repeating the new entry must refuse without replacing the intent; ordinary acquire/release/archive behavior remains refused.

  Include this exact new record in the fixture's handoff namespace and retained snapshots. Verify original state/completion/lock/prepared/committed bytes and identities before fixture-only cleanup. Remove the exact intent only after all checks, then continue existing fixture cleanup. Production deletes nothing.

- [ ] Add actual required receipt:

```text
PASS: native lock retirement intent binds exact dead committed lock without deleting evidence or granting continuation
```

  Commit/push tests, dispatch focused history and download actual missing-module red after the accepted native observation receipt.

### Task 2: Native derivation and retained namespace proof

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-intent.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`

- [ ] Implement `Publish-AgentsChatStoppedHistoryHandoffLockRetirementIntent(Context,ControllerPid,ControllerIdentity)`. Require the separate retirement-preparer role and fully accepted observer scope. Call the complete observer before writing; reject an already retained intent. Verify current recovery controller/native bridge identities and native UTC not before original committedAt.

  Derive the fourteen-field record above from actual retained native descriptors and retired owner proof, never caller JSON. Publish through native create-only `WindowsPrivateFile.Publish`, retain its handle/descriptor/creator/timestamp in `Context.HistoryHandoffLockRetirementIntent`, and preserve the original lock and state.

- [ ] Implement `Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent(Context)`. Require the independent role, retained observer/intent handles and exact creator proof. Independently rebuild the full intent from native context and current pinned descriptors, compare strict native JSON and the captured intent descriptor. This helper must not call the committed observer recursively.

- [ ] Extract the committed observer's expected namespace into `Get-AgentsChatStoppedHistoryHandoffCommittedNamespace(Context)`. Its default remains exactly prepared plus committed. Only an existing retained intent that passes the complete assertion above may append its exact filename. Use this helper before and after each observer pass. The initial committed bootstrap still requires exactly two files, so a fresh scope cannot ignore a retirement intent.

  Twice after publication call the complete native committed observer and intent assertion. Return only the intent descriptor. Failures poison the context and explicitly throw `Handoff lock retirement preparation failed; retain evidence.` No file/directory removal, state write or worker authority is added.

- [ ] Commit/push implementation and run focused history plus Windows Contracts on one SHA. Verify all eighteen prior actual receipts and the new nineteenth receipt. Record actual red/green SHA/run/job evidence and push it.

## Executed evidence

- Test-only `63d77524`: focused run `40436788174`, job `121967262079`,
  failed because `windows-stopped-history-handoff-lock-retirement-intent.ps1`
  did not exist, after the accepted native dead committed observation receipt.
  The actual missing-module diagnostic was downloaded.
- Implementation `33714d0159725fc6ed0483c9b185e1265c113b46`:
  focused run `40438976030`, job `121974444362`, and Windows Contracts
  `40438979251`, job `121974453093`, both passed on the same SHA.
- Actual focused logs contain all nineteen required executed receipts.
  At `2026-10-27T02:48:22Z`, the new intent receipt confirmed exact native
  binding, repeated-entry refusal and unchanged original lock/state/evidence,
  alongside all prior committed-observation and real death-boundary checks.
- Actual Contracts logs confirm closed saved-helper inventory, strict native
  JSON checks and zero failures. All validation ran in Actions; no local
  validation/server, native lock deletion or continuation authority was added.

## Next recovery boundary

Before native deletion is implemented, a distinct actor must reopen and fully verify this exact immutable intent after actual publisher death. Then guarded owner deletion and directory deletion each need durable-stage recovery and actual actor-death coverage. Directory-only states without such a validated intent remain blockers. Settlement and fresh-attempt admission remain separate; this preparatory record is not a terminal receipt or operation capability.
