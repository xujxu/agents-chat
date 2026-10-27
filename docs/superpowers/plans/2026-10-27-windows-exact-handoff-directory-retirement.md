# Exact Handoff Directory Retirement Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete only the original empty handoff lock directory through its native identity-bound handle and verify its absence from a freshly opened native scope.

**Architecture:** Extend the accepted immutable-intent retirement scope with explicit target-held and directory-retired stages. Preserve every original record and state byte. This increment delivers normal exact deletion and fresh native reopening; real directory-executor death, terminal settlement and fresh-attempt admission remain separate required gates.

**Tech Stack:** PowerShell 7, WindowsPrivateFile.RetainDirectoryForRetirement, existing native archive/task/runtime proof, GitHub Actions.

---

### Task 1: Native deletion and fresh-reopen contracts

**Files:**
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-lock-retirement-observation.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add `RetireDirectory`, requiring `ObserveRetirement`, excluding owner removal, intent publication and hold. Load the new directory module. Require its independent role before mutation:

```powershell
$null = Remove-AgentsChatStoppedHistoryHandoffLockDirectory $scope $ControllerPid $ControllerIdentity
```

  Without `HistoryHandoffLockDirectoryRetirementExecutor`, require exactly
  `Handoff directory retirement requires its independent native role.`
  Then set only that role, repeat the call and require actual directory
  absence and status `lock-retirement-directory-retired`.

- [ ] After the accepted fourth actor's owner-retired negative cases and unchanged-record checks, execute:

```javascript
const retireArgs = [...observeArgs, '-RetirementIno', previous.retirement.ino, '-RetireDirectory'];
const removed = await promisify(execFile)(pwsh, retireArgs,
  { timeout: 45000, maxBuffer: 131072, windowsHide: true });
assert.equal(removed.stderr, '');
const retired = JSON.parse(removed.stdout);
assert.deepEqual(retired, { ...observed, status: 'lock-retirement-directory-retired' });
await assert.rejects(lstat(directory), { code: 'ENOENT' });
const reopened = await observe(previous.retirement.ino);
assert.equal(reopened.stderr, '');
assert.deepEqual(JSON.parse(reopened.stdout), retired);
const retry = await promisify(execFile)(pwsh, retireArgs,
  { timeout: 45000, maxBuffer: 131072, windowsHide: true });
assert.equal(retry.stderr, '');
assert.deepEqual(JSON.parse(retry.stdout), retired);
```

  Create a different empty directory at the original name while keeping all
  records unchanged; observation and deletion must both refuse and preserve
  that directory's identity. Remove only this fixture-owned replacement and
  re-observe exact absence. Recheck all original record/state/completion
  bytes and identities after deletion. Keep acquire/release refusal while
  immutable handoff records remain. With the directory absent, preserve
  the ordinary archive reader's existing read-only behavior: status
  `retired`, with no advance, preparation or completion methods. Its
  refusal before deletion is caused by the new lock, not the handoff
  filenames; do not introduce a new archive-reader restriction.
  Fixture cleanup no longer removes the production-deleted directory.

- [ ] Require both actual receipts:

```text
PASS: native exact handoff directory retirement deletes only its original empty directory under immutable intent
PASS: fresh native directory-retired observation and idempotent retry preserve immutable evidence and reject replacement directories
```

  Commit/push tests, dispatch focused history and inspect actual missing
  directory-module red. Do not execute anything locally.

### Task 2: Explicit physical directory stages

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-commit.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-observation.ps1`
- Create: `scripts/deployment/windows-stopped-history-handoff-lock-retirement-directory.ps1`

- [ ] Both lock constructors gain `DirectoryRetirement=$null` and
  `DirectoryRetired=$false`. Only bootstrap with an explicitly pinned
  retirement descriptor may adopt an absent directory, setting the latter
  flag and retaining the immutable committed identity rather than inventing
  an actual directory identity. All complete original native bindings,
  intent creator death, archive/state/task/runtime settlement and strict
  intent/committed comparisons still run before returning a scope.
- [ ] Present-directory verification remains unchanged. Target-held
  verification requires the independent directory executor, owner-retired
  stage, no owner handle/target, exact empty canonical inventory, strict
  immutable intent and native target Check. Directory-absent verification
  requires the explicit observer/intent stage, no directory or owner handles,
  original owner absence and no case-insensitive root `lock` entry.
  Never weaken ordinary readers.
- [ ] Report directory-retired status before owner-retired status, preserving
  all eleven fields and both false authority flags.
- [ ] Implement the independent mutator using this complete transfer sequence:

```powershell
function Remove-AgentsChatStoppedHistoryHandoffLockDirectory(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffLockDirectoryRetirementExecutor') -or
        $Context.HistoryHandoffLockDirectoryRetirementExecutor -ne $true) {
        throw 'Handoff directory retirement requires its independent native role.'
    }
    try {
        $observed = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
        $lock = $Context.HistoryHandoffLock
        if ($lock.DirectoryRetired) { return $observed }
        if (-not $lock.OwnerRetired -or $null -ne $lock.OwnerFile -or
            $null -ne $lock.OwnerRetirement -or $null -ne $lock.DirectoryRetirement) {
            throw 'Handoff directory is not its exact owner-retired directory.'
        }
        $old = $lock.Directory
        $old.Dispose()
        $null = $Context.Files.Remove($old)
        $lock.Directory = $null
        $target = [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement(
            (Join-Path $Context.Control 'lock'), $lock.DirectoryIdentity.dev, $lock.DirectoryIdentity.ino)
        $Context.Files.Add($target)
        $lock.DirectoryRetirement = $target
        $null = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
        $target.Check()
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Handoff directory retirement executor identity differs.'
        }
        $target.Delete()
        $null = $Context.Files.Remove($target)
        $lock.DirectoryRetirement = $null
        $lock.DirectoryRetired = $true
        foreach ($pass in @(1, 2)) {
            $observed = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
            if ($observed.status -cne 'lock-retirement-directory-retired') {
                throw 'Handoff directory retirement did not preserve its exact absent stage.'
            }
        }
        return $observed
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff directory retirement failed; retain evidence.', $_.Exception)
    }
}
```

- [ ] Push implementation and run same-SHA focused history plus Windows
  Contracts. Inspect all 25 actual receipts and persist red/green SHA/run/job
  evidence. Native death after directory deletion, immutable terminal
  settlement, fresh attempt, state continuity and public repeat lifecycle
  are not accepted by this increment.
