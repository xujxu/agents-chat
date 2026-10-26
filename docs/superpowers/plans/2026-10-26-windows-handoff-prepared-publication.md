# Windows Handoff Prepared Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one exact native-derived prepared record without granting lock authority or overwriting existing evidence.

**Architecture:** A separate preparation flag permits native create-only publication under the original archive proof and watched actor. The initial implementation refuses every existing handoff, including repeated attempts; a later explicit recovery role must implement reopening before any lock handoff is enabled.

**Tech Stack:** PowerShell 7, WindowsPrivateFile.Publish, existing completed-history native fixture and focused Actions job.

---

## Files and boundaries

- Create `scripts/deployment/windows-stopped-history-handoff-preparation.ps1`.
- Modify `tests/deployment-windows-history-handoff-entry.ps1`: explicit
  `-Publish` fixture role; existing read-only path remains unchanged.
- Modify the `resume-completed-history` branch in
  `tests/deployment-windows-lost-runtime-session.mjs`.
- Modify `.github/workflows/deployment-lifecycle.yml`: require a sixth
  explicit publication receipt.

No ordinary archive reader, entry writer or completion publisher gains a
publication method. No lock/state mutation is introduced. The fixture closes
its native scope normally; a retained production controller and actual
publication-death recovery are separate mandatory gates before lock work.

## Task 1: Real-fixture red phase

- [ ] Preserve the native derivation argument list as `preparedArgs`.
  Add `-Publish` to the fixture parameter block. Only that branch loads the
  new publication module, sets `$scope.HistoryHandoffPreparer = $true`, and
  calls `Publish-AgentsChatStoppedHistoryHandoffPrepared` instead of the
  existing record derivation function. Both calls take the same scalar args.

- [ ] After the existing no-publication derivation assertions, add:

```js
const publication = await promisify(execFile)(pwsh, [...preparedArgs, '-Publish'],
  { timeout: 45000, maxBuffer: 2 * 1024 ** 2, windowsHide: true });
assert.equal(publication.stderr, '');
const descriptor = JSON.parse(publication.stdout);
assert.equal(descriptor.path, `inactive-handoff-${attemptId}-prepared.json`);
const preparedFile = path.join(control, descriptor.path);
const publishedBytes = await readFile(preparedFile);
const publishedIdentity = await lstat(preparedFile, { bigint: true });
assert.equal(publishedBytes.length, descriptor.bytes);
assert.equal(createHash('sha256').update(publishedBytes).digest('hex'), descriptor.sha256);
assert.equal(publishedIdentity.dev.toString(), descriptor.dev);
assert.equal(publishedIdentity.ino.toString(), descriptor.ino);
assert.deepEqual(captureWindowsStoppedHistoryHandoffPrepared(JSON.parse(publishedBytes)), prepared);
await assert.rejects(promisify(execFile)(pwsh, [...preparedArgs, '-Publish'],
  { timeout: 45000, maxBuffer: 2 * 1024 ** 2, windowsHide: true }));
assert.deepEqual(await readFile(preparedFile), publishedBytes);
const retainedIdentity = await lstat(preparedFile, { bigint: true });
assert.equal(retainedIdentity.dev, publishedIdentity.dev);
assert.equal(retainedIdentity.ino, publishedIdentity.ino);
assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
await unlink(preparedFile);
console.log('PASS: native stopped-history preparation publishes one exact create-only record without lock authority');
```

The unlink is fixture-only, after exact-byte/identity assertions and native
scope exit. Production publication never removes a prepared record.

- [ ] Add that exact PASS string to the focused job's receipt array.
  Commit/push with required trailers and dispatch:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

- [ ] Watch the returned run at 180-second intervals. Require downloaded
  logs to show failure at the missing preparation module, after the existing
  native derivation assertion succeeds.

## Task 2: Native create-only publication

- [ ] Create the production module with this complete implementation:

```powershell
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-record.ps1')

function Publish-AgentsChatStoppedHistoryHandoffPrepared(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    if (-not $Context.ContainsKey('HistoryHandoffPreparer') -or
        $Context.HistoryHandoffPreparer -ne $true) {
        throw 'Prepared handoff publication requires its independent native role.'
    }
    $record = Get-AgentsChatStoppedHistoryHandoffPreparedRecord $Context $ControllerPid $ControllerIdentity `
        $AttemptId $OperationId $Token $CreatedAt
    $text = $record | ConvertTo-Json -Depth 12 -Compress
    $name = "inactive-handoff-$AttemptId-prepared.json"
    $held = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
    $Context.Files.Add($held)
    try {
        $held.Check()
        if ($held.ReadText() -cne $text) { throw 'Published prepared handoff differs.' }
        $null = Assert-AgentsChatStoppedWorkerCleanup $Context
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Prepared handoff original actor changed.'
        }
        $entries = @(Get-ChildItem -LiteralPath $Context.Control -Force |
            Where-Object { $_.Name -like 'inactive-handoff-*' })
        if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or $entries[0].Name -cne $name) {
            throw 'Prepared handoff namespace changed during publication.'
        }
        return Get-AgentsChatStoppedHandoffDescriptor $held $name 1048576
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Prepared handoff publication failed; retain evidence.', $_.Exception)
    }
}
```

- [ ] Extend `Get-AgentsChatStoppedHandoffDescriptor` with optional
  `[int]$MaximumBytes = 65536` and pass that parameter to
  `Assert-AgentsChatRetirementDescriptor`. Archive descriptors retain their
  65536-byte default; the native-derived prepared record is bounded at 1MiB.

- [ ] Commit/push with required trailers and repeat the exact dispatch.
  Require all six actual PASS receipts and original native scope invariants.
  Record red/green SHAs, run IDs and job IDs here; commit/push evidence.

## Execution evidence

Red phase: `b0bb7006 / 40370195473`, job `121738549402`, reaches the
real completed-history resumer. Downloaded logs show actual native derivation
success followed by the `-Publish` fixture failing because
`windows-stopped-history-handoff-preparation.ps1` is missing. Native create-only
publication is now implemented; green-phase acceptance is pending.

## Self-review and remaining gates

The publication function derives all evidence natively, retains the created
file in the original scope and rechecks the archive, actual owner and exact
single-attempt namespace. Existing evidence is refused, never overwritten
or cleaned up on failure.

Future production transport must return only a small descriptor/receipt:
`workerWire` has a 131072-byte frame limit, below the full prepared-record
limit. Do not widen shared transport limits to send task/state JSON. Read
and capture the pinned prepared file independently using its receipt.
Publication-death takeover, explicit repeated-attempt reopening, committed
lock publication and state continuity are not accepted by this increment.
