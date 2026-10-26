# Native Abandoned Handoff Publication Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create one immutable terminal receipt for an exact prepared attempt whose original actor is dead, retaining the original record and granting no lock authority.

**Architecture:** A separate abandonment publisher role first runs the accepted native prepared observer. It publishes a create-only terminal receipt binding the exact prepared descriptor and native archive context to the live recovery controller and native bridge. Extract the existing read-only prepared binding check for reuse after publication, with an exact two-file namespace inventory rather than suppressing the namespace gate.

**Tech Stack:** PowerShell 7, WindowsPrivateFile native publication, real actor death GitHub Actions fixture.

---

### Task 1: Actual immutable terminal receipt contract

**Files:**
- Modify: `tests/deployment-windows-history-handoff-entry.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add `-Abandon` fixture mode, mutually exclusive with Publish/Hold/
  ObserveRetired. Load `windows-stopped-history-handoff-abandonment.ps1`.
  Only this branch sets `$scope.HistoryHandoffAbandoner = $true`, then invokes:

```powershell
Publish-AgentsChatStoppedHistoryHandoffAbandoned $scope @{
    path="inactive-handoff-$AttemptId-prepared.json"
    dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
} $AttemptId $ControllerPid $ControllerIdentity
```

- [ ] Extend `resume-prepared-history` after all current observation,
  incorrect-inode and fresh-attempt refusal checks. Call `-Abandon` with
  original descriptor scalars. Read returned terminal descriptor and verify
  file hash/dev/ino/byte length, exact original prepared descriptor, original
  archive operation/control/project/control identity, live resumer PID/start
  identity, distinct native bridge PID/start identity and canonical UTC time.
  Require no lock and unchanged original state/prepared bytes/dev/ino.

  Repeat the exact publication and require a contextual failure. Verify both
  existing files' bytes and identities are unchanged. Only after all checks
  may the fixture remove the exact terminal and prepared files and continue
  original archive restoration.

- [ ] Add ninth required executed receipt:

```text
PASS: native abandoned handoff publication seals one exact dead attempt without replacing evidence or granting lock authority
```

- [ ] Commit/push tests and dispatch:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

  Require actual red logs after the accepted prepared observation, due to
  missing abandonment production module.

### Task 2: Separate native create-only publication

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-observation.ps1`
- Create: `scripts/deployment/windows-stopped-history-handoff-abandonment.ps1`

- [ ] Extract `Assert-AgentsChatStoppedHistoryHandoffRetiredPreparedBinding`
  taking Context, pinned File, AttemptId, ControllerPid and ControllerIdentity.
  Preserve the current exact JSON/owner parsing, two original-actor absence
  checks per pass, complete independent native binding derivation, fresh
  controller checks and document disposal. It performs no namespace allowance
  or publication.

- [ ] Extract exact inventory helper taking Context and expected filenames:
  use an ordinal HashSet; enumerate every `inactive-handoff-*` entry, reject
  directories, unexpected names/casing/duplicates and missing names.
  The accepted observer still requires only its original prepared filename
  before and after the binding check. Preserve contextual failure/poisoning.

- [ ] Implement this independent publisher:

```powershell
function Publish-AgentsChatStoppedHistoryHandoffAbandoned(
    [hashtable]$Context, $Descriptor, [string]$AttemptId,
    [int]$ControllerPid, [string]$ControllerIdentity
)
```

  Require `Context.HistoryHandoffAbandoner` true. Run the accepted observer,
  pin the original prepared descriptor again, and construct exactly:

```powershell
[ordered]@{
    version=1; phase='stopped-history-handoff-abandoned'; attemptId=$AttemptId
    control=$Context.Control; project=$Context.Project
    controlIdentity=$Context.HistoryRecord.controlIdentity
    previousOperationId=$Context.OperationId
    prepared=(Get-AgentsChatStoppedHandoffDescriptor $prepared $preparedName 1048576)
    creator=[ordered]@{
        pid=$ControllerPid; processIdentity=$ControllerIdentity
        bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    }
    settledAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}
```

  Original prepared digest binds its full owner/state/intent/completion/task
  record; do not duplicate or rewrite those records. Publish only to
  `inactive-handoff-<attempt>-abandoned.json` using native create-only Publish,
  add its retained handle to Context.Files.

  Twice after publication: recheck exact prepared+terminal namespace, terminal
  bytes/identity, complete retained prepared binding and native archive proof.
  Return only its native descriptor. On failure poison the context and throw
  `Abandoned handoff publication failed; retain evidence.` with original cause.
  Never delete evidence on production failure. Repeated publication is
  deliberately refused; existing terminal-record reopening is a later step.

- [ ] Commit/push and repeat the exact focused Actions selection. Require
  all nine actual receipts. Also run Windows Contracts-only on the same SHA.
- [ ] Record real red/green SHA/run/job evidence and push the acceptance.

## Self-review

The role flag is necessary but not proof; native observation and post-publish
binding provide proof. Neither fresh actor liveness nor a terminal record
grants lock authority. The terminal receipt references an unchanged pinned
prepared file. Original archive and disabled runtime task remain retained.
This stage does not reuse settled attempts, grant new admission, or implement
terminal publisher death recovery.
