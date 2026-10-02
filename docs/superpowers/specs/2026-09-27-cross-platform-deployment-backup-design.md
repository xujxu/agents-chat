# Cross-platform source deployment backup and recovery

## Goal and delivery boundary

Make first deployment and source upgrades safe and documented on Linux and
Windows, without changing the deployment model. Linux continues to use systemd;
Windows continues to use Scheduled Tasks and the existing watchdog.

Implement this independently of the voice feature, on a branch based on main
`638c553c62406dbb7e6b5aeb41cdddf4cd6de179`. Do not merge the draft voice PR or
deploy to the user's host as part of implementation. After the deployment
improvement reaches main, integrate it into the voice branch before testing
main-to-voice upgrades so the new version does not replace it with older scripts.

All assistant-run tests, builds, dependency installation and service execution
run in GitHub Actions, not on the user's machine. Read-only inspection, editing
and Git operations are permitted locally.

The user requires successful Linux AND Windows first-deployment and upgrade
acceptance before creating the implementation PR. The user approved remote
test-branch pushes before Actions, with PR creation only after acceptance.
Never interpret permission to push a test branch as permission to push directly
to main. Use a normal reviewed PR for main integration.

## Existing behavior and required changes

- Main has `scripts/deploy.sh` and `scripts/deploy.ps1`; neither provides a full
  pre-upgrade backup or no-build restoration.
- Main's Linux script refreshes service configuration before pulling source and
  builds in place. The backup must move ahead of all such mutations.
- The voice branch has an `upgrade.sh` that pulls before invoking deployment.
  That ordering must not be carried into the new transaction.
- Windows currently installs/changes task configuration before updating and
  invokes `start.ps1` through the watchdog, which builds on startup. Restoring
  `.next` and restarting that task alone is not a no-build recovery.

Keep orchestration entry points thin. Put backup manifest, file selection,
transaction state and platform lifecycle helpers under `scripts/deployment/`.
Reuse the existing runtime/toolchain instead of adding a package dependency.
Platform-specific permissions and process management stay in Bash/PowerShell
helpers rather than pretending they are interchangeable.

## Public interface

Linux:

```bash
sudo bash scripts/deploy.sh
sudo bash scripts/update.sh
sudo bash scripts/deploy.sh --no-pull
sudo bash scripts/restore.sh
```

Windows, from an elevated PowerShell terminal:

```powershell
.\scripts\deploy.ps1
.\scripts\update.ps1
.\scripts\deploy.ps1 -SkipGitPull
.\scripts\restore.ps1
```

`deploy` supports both first installation and existing deployment.
`update` requires an existing deployment and delegates to the same transaction;
it must not pull first or make a second backup. `restore` delegates to the
recovery entry point in the private external control directory.

Preserve existing public parameters unless a safety restriction is explained:
Linux `--no-pull`, `--no-install`, `--wait`; Windows `TaskName`, `ProjectDir`,
`SkipGitPull`, `RemoveTask`, `TaskLogonType`, `TaskTriggerType`, `NoWait`,
`WaitSeconds`. Add help for all new entry points. Existing task identity,
triggers and service overrides remain unchanged unless explicitly requested.
A fresh Windows install must use a documented, valid account, not a hardcoded
developer identity.

Skipping health waiting means activation is unverified, not successful
acceptance. Keep the backup and transaction status accordingly. Prevent a later
upgrade from silently treating an unverified or failed deployment as a known
good source. Task removal is not an upgrade and must not replace a backup.

Support an explicit target revision for controlled deployments on a clean
checkout, so backup happens before switching source. Specify its exact flags
in the implementation plan and README. Default upgrades require a tracking
branch and a fast-forward update; never reset dirty or diverged user work.

## Approved update enhancements (2026-09-27)

This section extends the original design and takes precedence over the earlier
implementation plan until that plan is revised. The previously proposed upgrade
entry points have not shipped on main. Use `update.sh` and `update.ps1` only;
do not add upgrade aliases. Rename the internal operation, help, tests and
workflow path filters consistently. Historical references to the voice branch's
old `upgrade.sh` describe existing code, not a supported new command.

### Read-only preview

Add `--dry-run` / `-DryRun`. Preview reads local state without fetching Git refs,
installing dependencies, executing target code, creating a lock/control directory,
writing history/configuration, copying a backup, or changing the service.
Report local current and target revisions, backup location, estimated space,
planned steps and checks that remain pending.

When the upstream reference is missing or potentially stale, explicitly mark
remote freshness and target selection as unknown/pending. A locally available
explicit commit can be inspected without checkout. Do not claim preview is a
successful admission check. Invalid or unsupported input is an error; an
incomplete preview identifies its unknowns, not a fabricated success.
Preview does not replace the most recent real operation's result.

### Accurate already-current result

Only `update`, not `deploy`, can skip an already-current installation.
Require the resolved target commit, an accepted deployment receipt, actual
build/dependency identity, relevant configuration identity and the observed
service identity/state to agree. Existing interrupted, failed or unverified
state blocks skipping. Missing provenance triggers normal admission and update,
not a guess based solely on Git HEAD.

The skip path does not stop/restart the application, copy or rotate the backup,
install dependencies or rebuild. It reports `already-current` explicitly.
If source matches but artifacts are missing/modified, use the normal update
path. If the runtime or service cannot be inspected, report that obstruction
rather than declaring the installation current.

`deploy` remains an explicit way to rebuild/redeploy the chosen source.
Do not interpret `--no-pull` as permission to bypass checks.

### Compatibility before downtime

Inspect the exact target's declared Node requirements and transaction protocol,
required configuration shape and supported application-data formats before
stopping the current service. Distinguish transaction protocol compatibility
from application schema compatibility.

The application currently initializes several SQLite stores and performs
additive migrations during startup; there is no universal schema version to
compare. Introduce explicit, bounded read-only compatibility checks for the
supported historical baseline and target. Do not invoke store initialization
or start the candidate against live data to discover compatibility.
Read configuration without rewriting it or exposing secret values.

Check all relevant application databases and their required tables/columns
and migration markers, not only chats.db. A coherent read may need a read-only
SQLite transaction; inability to obtain one is an explicit admission failure.
Do not use SQLite immutable mode on a live WAL database or ignore committed WAL
data. Inspection must not create persistent files in the application's state.

Known incompatible, unsupported or unclassifiable data/configuration fails
before mutation, with the failed check and a concrete next action. Define the
supported historical shapes and engine ranges in the implementation plan from
repository evidence; do not infer compatibility from a commit being newer.
Future migration support requires an explicit contract and regression fixture.
Restoration still restores matched code AND saved data after acknowledgement;
do not open newer schemas with old code or introduce automatic database rollback.

### Status, JSON and bounded diagnostics

Add `--json` / `-Json` to operation, preview and status output. Keep stdout
machine-readable, with progress and native command output on stderr or in a
private log. Include operation ID, current/target revisions, phase and elapsed
time, outcome, stable error code, observed runtime state, backup availability,
pending checks and exact next-action/diagnostic commands.

Redact credentials, environment values and authenticated remote URLs.
Local recovery commands may include the necessary installation path; do not
publish private paths in uploaded CI reports. Bound logs and retained summaries
separately from the single full backup. Do not build an unbounded history store.
Corrupt or unreadable status data is an explicit error, not an empty history.

### Stage deadlines and cancellation

Add `--timeout SECONDS` / `-TimeoutSeconds SECONDS` for a positive per-stage
budget; retain `--wait` / `-WaitSeconds` for readiness. Document concrete defaults
and interactions in the implementation plan and help. Report the active phase,
elapsed time and applied budget during long steps.

Timeout/cancellation stops new mutations, requests termination of this
operation's owned workers, and confirms settlement before restarting or
restoring any runtime. A Promise timeout alone does not stop a copying worker
or npm child. If settlement cannot be established, retain ownership and the
backup, record the unresolved processes and print inspection/recovery guidance.
Never kill by process name or assume every listener on the app port is owned.

Persist intent before mutation as already specified. Abrupt OOM/power loss
continues to rely on durable phase/ownership records and the next invocation's
diagnosis, not a catch handler that may never run.

### Native worker containment review (2026-09-27)

The user approved Linux cgroup / explicit Windows Job ownership, then requested
an edge-case review before implementation. This section records that review;
it is not evidence that native worker support is implemented or validated.
No finite source review establishes absence of all risks.

#### OpenClaw evidence and limits

All OpenClaw references below use commit
[`8620e9097726a817be6bd8f9385a14a54e24f89d`](https://github.com/openclaw/openclaw/tree/8620e9097726a817be6bd8f9385a14a54e24f89d),
not an unspecified release.

- `src/infra/update-runner-command.ts` enables `killProcessTree` for its default
  update command runner. `src/process/exec-termination.ts` uses POSIX process
  groups with identity checks and Windows taskkill while the root is live.
  Its Windows comments explicitly distinguish this from spawn-time Job
  ownership; root exit is not permission to target a reusable PID.
- This is NOT the complete update architecture. The command scopes in
  `src/process/exec-spawn.ts`, executor/child ownership in
  `src/cli/update-cli/update-command-executor{,-children}.ts`, and recovery
  unwind in `update-command-unwind.ts` retain cleanup and live authority.
  `src/infra/update-managed-service-handoff-scope.ts` additionally checks
  systemd invocation identity, full cgroup placement, and native retirement
  for managed handoff. Do not describe all updates as only taskkill/groups.
- `scripts/lib/managed-windows-job{,-launcher}.mts` implements a separate
  explicit Job path: a trusted launcher joins the configured Job, closes its
  temporary Job handle, then acknowledges readiness before receiving target
  input. This is gated admission, not a requirement that all Windows commands
  use suspended CreateProcess. Its optional native-module fallback is NOT
  acceptable for this deployment's strict recovery guarantee.
- Its Job enumeration rejects incomplete process lists. Its cleanup observer
  requires launcher exit AND an empty Job, not merely a root PID or closed
  pipes. It removes case-insensitive NODE_OPTIONS from the pre-admission
  launcher. The retained handle must not leak into descendants.
- `src/process/exec-result.ts` detects cleanup uncertainty through nested
  errors; `update-runner-git.ts` suppresses rollback and artifact cleanup on
  that classification. `update-command-cleanup-recovery.test.ts` and
  `update-command-executor-settlement.test.ts` assert cleanup precedes recovery
  and lease release. These are primarily mocked protocol tests, not independent
  proof of operating-system extinction.
- `test/scripts/managed-child-process.windows.test.ts` includes real Windows
  Job cases with detached descendants and independent output after abort or
  normal root exit. The inspected source defines those tests; this review did
  not run them or verify their upstream CI results.

#### Required ownership and recovery invariants

| Boundary / risk | Required behavior |
| --- | --- |
| Spawn before ownership | Persist a fresh per-operation/per-worker intent before OS creation. Launch only a trusted, non-mutating bootstrap until placement and identity are verified and durably acknowledged. Then release the command once. No target preload or npm lifecycle script may run before admission. |
| Cancellation before readiness | Close admission irrevocably; reject late readiness, delayed replies, duplicate start messages and reuse of a cancelled worker. Empty-before-admission is not completed-work evidence. |
| Empty now, spawn later | Join/stop every admitted launcher and controller capable of creating work before certifying extinction. An earlier empty query is not reusable authority. |
| Parent exits or output closes | Retain containment and independently query descendants, including detached/session-changing children and children with redirected output. Normal root exit does not waive this requirement. |
| Termination requested | A successful signal, taskkill, systemctl or TerminateJobObject call is not proof of exit. Observe the exact retained ownership domain until empty or until the bounded settlement deadline expires. |
| Reused identity | Bind project, operation, worker generation, controller identity and OS domain. Linux includes boot ID, manager scope, InvocationID and complete ControlGroup path. Windows includes the original handle, creation generation, account and session. Names/PIDs alone cannot authorize mutation. |
| CLI/owner OOM or kill | Never rely on catch/finally. Windows uses non-inherited kill-on-close ownership; Linux needs a manager-enforced finite deadline and an independently observed controller lifetime. Loss of either control transport or authority closes admission. Domain creation is not itself an OOM solution. |
| Recovery reentry | Acquire exclusive recovery authority, reconcile pending creation and the original worker domain, then persist a verified settlement receipt before leaving blocked. No automatic lock removal because the parent is dead. Missing, inaccessible, replaced or ambiguous evidence remains blocked. |
| Wrapped cleanup error | Preserve uncertainty through cause chains and AggregateError.errors, with cycle/size guards. Both stage runner and transaction must use one shared classifier. Never downgrade uncertainty because an adapter added error context. |
| Journal/receipt failure | Preserve original and recording errors. Retain lock and files; failure to write blocked must not authorize finally-based unlock. A settlement receipt is evidence of stopped work, not acceptance of deployment contents. |
| External application writers | Build containment does not stop the existing application, ACP children, watchdog or scheduled tasks. Independently establish owned runtime shutdown and suppress automatic restarts before copying databases. |
| Privilege / escaped work | No process-name/port kills. No claim to contain malicious privileged scripts, WMI/service-mediated launches or root migration outside the domain. Run trusted commands at the intended identity; fail rather than silently broadening authority. |
| Logs / memory / disk | Continuously drain bounded stdout/stderr independently of lifecycle. Protect/redact private logs and never retain unbounded output in RAM or on disk. Output truncation and pipe EOF cannot certify extinction. |
| Replaced dependencies | Keep bootstrap, native interop and recovery code outside the mutable checkout and node_modules. npm ci/source replacement must not remove the code needed to stop workers or recover. |

The nested-error classification requirement exposes a concrete gap in the
current callback foundation: `stage-runner.mjs` and `transaction.mjs` inspect
only the outer `recoveryAllowed` field. Before native integration, add causal
regressions for wrapped/aggregate/cyclic failures and make that classification
shared. Existing green contracts do not cover this case.

#### Platform-specific guardrails

Linux uses a uniquely named transient system service with explicit
`KillMode=control-group`, `SendSIGKILL=yes`, no automatic restart and bounded
start/stop/runtime limits. Do not accidentally use Type=oneshot with only
RuntimeMaxSec: systemd documents that this runtime limit does not apply there.
Do not use ActiveState or MainPID=0 alone as an emptiness test. Prefer recursive
cgroup-v2 `cgroup.events: populated=0`, checked against the admitted identity.
When the domain has retired, require reconciled creation/manager evidence, not
an arbitrary missing filesystem path. Before deleting unit evidence, persist
the settlement receipt. Older/hybrid hosts without an equivalent proven
observation contract are explicitly unsupported until separately validated.

Service-manager control must use the captured system/user manager identity,
not a changed sudo environment. Keep the deployment worker domain separate
from the application domain and recovery supervisor. Commands, working
directory, UID/GID, PATH and environment need exact transport without shell or
systemd variable reinterpretation; feature-detect required properties before
any downtime. A manager watchdog bounds abandoned work; it does not prove
immediate death after CLI failure. Uninterruptible I/O, permission errors or
failed observations remain blocked. OOMPolicy is not a memory cap, and this
feature does not promise that the host or old service cannot suffer OOM.

Windows configures KILL_ON_JOB_CLOSE before admission and disables breakaway.
Do not hand the target an inheritable Job handle. Check every native call,
structure layout and nested-Job assignment; no portable/uncontained fallback.
Use the trusted gated-launcher sequence from the reviewed tooling design,
rather than start the target and assign it afterward. The trusted bootstrap
waits without target code, joins the Job, closes its temporary Job handle and
acknowledges placement; the owner durably records admission before sending the
one-use command grant. Clear case-insensitive NODE_OPTIONS from bootstrap
startup and do not resolve its code/native binding from the application's
mutable dependency tree. Test all partial-creation paths. Failed assignment
or disconnected bootstrap must not leave a runnable unowned target.
Retain the exact Job handle until observation and cleanup are complete.

Job creation can OPEN an existing named object: reject ERROR_ALREADY_EXISTS.
Restrict the object's ACL. A `Local\\` Job name is session-specific, so
cross-session recovery must not interpret failure to open it as extinction.
Opening another handle also extends Job lifetime and can defeat last-handle
kill assumptions; recovery/inspection handle ownership must be explicit.
Retain blocked if the original domain cannot be unambiguously reconciled.
Do not replace a lost Job with a new empty same-name Job to "verify" it.
Completion-port notifications are hints, not guaranteed proof; query the
retained Job, reject partial/truncated enumeration, and close admission first.

#### Mandatory real Actions acceptance matrix

Both supported OSes need real process tests in addition to mocked failures:

1. Ordinary success/nonzero exit with parent, child and grandchild; independent
   file-output descendants, and root exits before descendants.
2. Cancellation before launch, between domain creation/admission/start, during
   output, and after root exit. Late startup replies never admit work.
3. Timeout with ignored cooperative termination; a delayed descendant and
   POSIX setsid / Windows detached child remain owned and stop before recovery.
4. Kill the CLI and native owner independently at each durable boundary;
   reenter from saved state. No live writer may overlap backup/restore/restart.
5. Inject failed stop/query, access denial, nested-Job rejection, truncated
   enumeration, changed InvocationID/session/boot, and same-name replacement.
   Never terminate an unrelated sentinel process or erase its state.
6. Failed state writes, nested cleanup errors, control-pipe loss, missing
   helpers after checkout/dependency replacement and huge output remain
   explicit failures without unsafe cleanup or success-shaped results.
7. Concurrent recovery/update attempts, repeated cancellation and repeated
   status reads cannot reopen admission or release another operation's lock.
8. Real Git/npm/Next lifecycle tests exercise the wrapper with actual command
   arguments, identities and environment, not only synthetic Node workers.

Fault injection stays in test fixtures. Dangerous host-wide OOM is not a test
strategy: use controlled owner termination and bounded isolated resource
fixtures in Actions. Do not infer global power-loss/disk-durability guarantees
from SIGKILL tests. Report simulated failures separately from native evidence.

Platform references:

- [systemd termination](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
- [systemd service lifetime](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [systemd-run transport/options](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)
- [Linux cgroup-v2 events and termination](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [Windows Job inheritance and lifecycle](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [CreateJobObject existing-object semantics](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createjobobjecta)
- [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)

### Additional Actions gates

Run these on Linux and Windows in addition to real first-deploy/update/restore:

- Preview preserves application/control filesystem contents, Git refs and
  service state, including when no control directory exists.
- Already-current preserves backup identity and performs zero stop, install,
  build or rotation operations. Missing receipts, altered artifacts/config and
  unverified activation do not incorrectly skip.
- Incompatible Node/protocol/config/data and unknown database shapes refuse
  before stopping or mutating the application; supported historical fixtures
  pass with committed WAL data included in inspection.
- Timeout and cancellation cover commands with child processes and snapshot
  copying; no writer remains when cleanup/recovery proceeds. Unconfirmed
  termination retains ownership and reports a blocked outcome.
- JSON remains parseable on success, preview, refusal, timeout and recovery;
  errors retain nonzero exit codes and concrete next actions.
- No new upgrade-named entry point or alias is advertised or introduced.

Candidate worktree builds/canaries, automatic channel selection, full business
draining and automatic database rollback remain deferred. Display the risk to
in-flight chat/tool/scheduled work before a maintenance-window update; this
warning is not a claim that business draining is implemented.

## Backup contents and placement

Use a private, deterministically named sibling directory outside the project,
containing a small control area and one retained complete backup. Canonicalize
the checkout path and record ownership so another checkout cannot reuse it.
Apply Linux permissions or Windows ACLs restricting credentials to the intended
administrator and required service identity. Never put secret values in output,
CI reports or manifests.

Include:

- Recoverable source identity and the necessary source snapshot, not merely a
  branch name that may later move. Record deployment/build provenance.
- Runtime `.data`, `agents.json`, and applicable project environment files.
- Existing `.next`, `node_modules`, and any deployed assets not reconstructible
  from the saved source.
- Linux service unit, drop-ins, applicable environment files, ownership/modes
  and originally absent files.
- Windows task definition, account/logon/trigger information, enabled/running
  state, relevant application configuration and required ACLs.
- Self-contained restore entry point/helpers and a versioned manifest that
  continue working if the checkout's scripts disappear or change.

Do not recursively include Git worktrees, dependency caches, logs or this tool's
backup/control directory. Do not treat user-created directories as disposable
backups. Legacy application data paths may contain required model assets;
exclude no such data merely because a directory is named `deployments`.
Show the estimated size and chosen scope before copying.

Reject unsupported links/reparse points or external configuration that cannot
be safely captured/restored before mutating the deployment. Do not silently
omit a required file. Preserve encoding and permissions of environment files.

An existing uninstrumented installation needs a bootstrap backup: capture its
actual installed files and current source without asserting unproven build
provenance. Later instrumented upgrades use the last successful deployment
receipt, not an already manually advanced Git HEAD, as runtime provenance.
Document these distinctions for old installations and `--no-pull`.

## One retained backup with safe replacement

The user approved ONE long-term complete backup, with temporary old/new overlap
while creating its replacement. No history series, timestamped backup pile or
automatic retention of failed full copies.

1. Estimate space for the new backup, manifest/control state and deployment
   staging headroom. The old backup remains intact. Reject insufficient space
   before stopping or changing the deployment.
2. Use a single known staging slot, protected by the transaction lock. Copy
   only after the application is stopped and SQLite writers are gone.
3. Record and verify completeness, file sizes/checksums, permissions and saved
   runtime/source metadata. Write the completion marker last.
4. Promote the complete staging backup and retire the previous backup with
   recoverable filesystem state transitions. Handle interruption between the
   two renames; directory replacement must not assume nonempty directories can
   be atomically overwritten on both platforms.
5. Remove only the previous backup owned and validated by this tool, after a
   complete replacement is authoritative. Failure to retire it stops the
   upgrade with a cleanup/resume action, rather than creating more snapshots.

After successful rotation there is exactly one complete backup and no staging
copy. At interruption there are at most two full snapshots plus small state
files. A restart identifies the existing staging/retiring slots; it does not
allocate another directory. Never discard the only complete valid backup.
Immutable hard links into live mutable data are not an acceptable backup.

## Deployment transaction

1. Acquire a per-installation exclusive lock. Verify checkout, privileges,
   runtime, service/task ownership, ports, target revision, backup scope and
   capacity. Print the external recovery command and log/state locations.
2. Fetching metadata may occur before backup, but switching/pulling working
   source, editing service/task definitions and replacing build/dependencies
   must wait until backup completion.
3. Record prior runtime state. For an existing deployment, stop the owned
   service/task and its owned children. Suppress scheduled/watchdog restarts
   during the transaction. Verify stopped state before copying SQLite files.
   Do not kill unrelated processes based only on a matching port.
4. Create and rotate the backup. First installation skips old-version backup.
5. Select the target source and re-enter the updated deployment implementation
   with the same protected transaction, without a second pull/backup. Validate
   transaction compatibility before handoff; abort if unsupported.
6. Install dependencies, build, apply configuration and activate the service
   using the platform's documented flow. Preserve runtime account, Node
   selection, task mode and existing overrides.
7. Confirm application readiness and ownership, not merely a running task or
   stale log. Write successful deployment provenance only after acceptance.
   Release the lock; retain the latest pre-upgrade backup.

State updates are persisted atomically before destructive phases. A lock does
not substitute for durable state after OOM or reboot. A stale lock requires
checking whether its owner is alive and whether an unfinished phase exists.
Block blind reruns; give explicit inspection, recovery or safe cleanup actions.

### Shared native admission for deployment and recovery

The user approved the industry-standard approach on 2026-10-02: use OS-backed
interprocess exclusion together with the existing durable transaction state.
This is internal concurrency control, not a new user-authorization system or
a second recovery protocol.

Use one admission resource per canonical external installation control
directory. Linux retains its existing directory-backed `flock`. Windows uses
a fixed `windows-admission.lock` file opened with read/write access and no
sharing, corresponding to `FileShare.None` / Win32 `dwShareMode = 0`.
Keep the Windows file after releasing the handle; neither its existence nor
its timestamp/PID content establishes occupancy. The file remains empty and
is separate from the operation owner, state, journals and recovery receipts.
Do not use truncation or delete-on-close.

Create the Windows file with explicit private ownership/permissions and a
non-inheritable handle. On opening an existing file, validate rather than
repair its permissions. Reuse the native private-directory/file identity
checks: reject redirected paths, reparse points, extra hard links, unexpected
content and replaced identities. Retain the actual control directory and
file handles for the admission lifetime. The current supported private-owner
policy remains the current account or SYSTEM; unsupported cross-account
access must fail without granting broader permissions.

Admission protects checks and changes to transaction ownership:

- Normal deploy/update lock acquisition checks for recovery/maintenance
  evidence and creates the operation owner while holding admission.
- Recovery acquires the same admission resource before inspecting and
  taking over an interrupted operation, and retains it across its authorized
  recovery mutations and ownership cleanup.
- Operation-lock release and recovery-evidence retirement use the same
  admission boundary. Do not add a recovery-only mutex while leaving normal
  lock acquisition or release able to race with it.
- Avoid recursive acquisition through the Node/PowerShell bridge. A retained
  admission context may be passed to internal helpers; each helper verifies
  that context rather than accepting a Boolean bypass.

The durable operation lock continues to protect long-running deployment
work after the short acquisition critical section ends. Admission does not
authorize removal of the old operation lock, backup restoration, task
mutation, receipt retirement, or a success report on its own. Those actions
still require the existing state, source/artifact, original runtime and
receipt checks. A normal deployment cannot take over a stale operation simply
because it acquired the kernel resource.

Treat sharing contention as an explicit busy result, initially fail-fast.
Distinguish it from access, path, identity and I/O errors; do not silently
retry all errors or introduce expiry-based lock stealing. Close the native
handle on normal completion and expose independent cleanup failures. The
owner's process exit also releases its handles, but does not establish that
application children are settled or that transaction data is consistent.
Keep the handle out of child inheritance and bind a helper process's lifetime
to its original controller using the existing owned-controller mechanism.

Read-only inspection remains read-only: it does not create this lock file,
take over the operation or acquire mutation authority. Keep rejecting
unsupported interrupted prefixes until their recovery paths are implemented.

Deliver in two connected steps: prove native exclusion/lifetime/permission
behavior, then integrate every relevant lock/recovery entrypoint. Do not
describe the primitive alone as completed public Windows recovery support.
Actions acceptance must cover same-directory contention in independent
processes, independent installations, normal close and abrupt owner exit,
non-inheritance, unsafe existing files/ACLs, directory or file replacement,
and preservation of the old operation evidence after admission release.
Integration coverage must exercise deployment-versus-recovery contention and
retain the existing read-only completion, native runtime and full dual-platform
regressions. No local builds, tests or servers are permitted.

Primary references verified against actual source/documentation:

- [NuGet ConcurrencyUtilities](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.Common/ConcurrencyUtilities.cs)
  uses `OpenOrCreate`, read/write access and `FileShare.None`. Its Windows
  delete-on-close policy is not required by this design.
- [gofrs/flock Windows implementation](https://github.com/gofrs/flock/blob/main/flock_windows.go)
  uses `LockFileEx` and retains the file on unlock; its Unix counterpart uses
  `flock`. This is an alternative OS-backed mechanism, not another dependency
  required by this application.
- [Win32 CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
  defines sharing exclusion and non-inheritance; an existing file's security
  descriptor is not replaced by the creation-time descriptor.
- [Win32 Mutex Objects](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects)
  documents thread ownership and abandoned-state uncertainty. A named mutex
  is valid, but adds naming/thread-lifetime considerations without a benefit
  for this file-oriented admission layer.

## Failure messages and recovery

Every caught failure returns a nonzero exit and prints:

- Failed phase and actionable error.
- Whether the old application is running, stopped, restored or unverified.
- Whether a complete backup exists and its revision/location.
- A fully quoted, copyable command using the saved external restore entry
  point, plus the relevant diagnostic log command.

Before any deployment mutation, failure leaves the old runtime unchanged. If
backup fails after stopping the old service, restart it only if it was
previously running and its runtime files/configuration are unchanged. Report
restart failure explicitly.

After source/build/configuration mutation, stop partial activation and do not
declare automatic full recovery. Preserve the complete backup and give the
restore command. Do not automatically restore the database.

OOM/SIGKILL/power loss cannot reliably print a final message. Print the recovery
command beforehand and save phase records. On the next invocation, diagnose
the interrupted transaction and explain the next command before doing work.

For first-install failures without a previous version, say no old-version
backup exists and give log/diagnosis and safe retry commands, not a fictional
rollback command.

### Explicit restore

Validate the backup, ownership, available space and transaction before stopping
anything. Preview the recorded revision and backup timestamp. Require explicit
confirmation that database restoration discards post-backup changes; a
noninteractive caller must provide a documented acknowledgement flag.

Stop only the managed runtime. Restore source, runtime artifacts, data,
configuration, service/task definition and permissions. Keep the authoritative
backup intact so restoration can be retried after interruption. Recovery must
not create another retained complete backup or a permanent failed-state copy.
Warn the operator to export new data separately before acknowledging loss.

Start the restored application without network access, `npm install` or a
build. Linux uses the restored artifacts and systemd identity. Windows needs a
validated restored-artifact startup path through the Scheduled Task/watchdog;
it cannot call the legacy build-on-start path and claim no-build recovery.
The saved recovery tooling must support rollback to the historical fixture,
even if that fixture did not yet contain the new no-build startup option.
Report any necessary recovery launcher indirection without claiming that the
historical task action was restored byte-for-byte.

Check readiness and data/configuration continuity, then record the restored
deployment. If verification fails, retain recoverable state and print the next
diagnostic/retry command. Do not silently delete the only backup.

## README requirements

Document Linux and Windows separately, with copyable commands and all public
parameters for first deployment, normal upgrades, explicit target selection,
already-fetched source, skipping dependency installation where supported,
health waiting and restoration.

Explain privileges/account selection, tracking branch requirements, first
upgrade from a version without the new scripts, maintenance downtime, backup
location/contents, one-copy retention and temporary peak disk usage. Distinguish
application files from excluded caches/logs and unsupported external paths.

Explain error messages, abrupt interruption, restoring while checkout scripts
are unavailable, database-loss confirmation, unverified activation and the
Windows no-build recovery behavior. Describe Git-fetch/bootstrap steps honestly:
new backup safeguards cannot execute inside an old unmodified script.

## GitHub Actions acceptance gates

Both Linux and Windows must pass. Run isolated real systemd/Scheduled Task
deployments on Actions runners, with actual application dependency installation,
Next.js builds, HTTP readiness and persisted data checks. Mocked command tests
are useful fault injection, not substitutes for real deployment acceptance.

Required cases on each platform:

| Case | Required evidence |
| --- | --- |
| First deploy | Correct runtime identity/config, real application readiness, no fake old-version backup |
| Old-version upgrade | Deploy a pinned historical version, seed data/config, run the new entry point, verify new source/build running and data retained |
| Second upgrade | Latest pre-upgrade snapshot replaces previous backup; exactly one complete backup remains |
| Backup/capacity failure | No source/build/config mutation; old backup intact; prior runtime state restored where appropriate |
| Install/build failure | Nonzero exit, owned partial runtime stopped, valid backup and copyable recovery command |
| Activation failure | Failure is not masked by stale logs or unrelated listeners; recovery instructions retained |
| Explicit restore | Saved version/data/config restored with no install/build invocation and no network dependency |
| Abrupt interruption | Persisted state survives process termination at copy/rotation/mutation/restore phases; retry does not accumulate copies |
| Concurrent operation | Second operation rejected without modifying deployment or backups |
| Ownership/permissions | Secrets private, account/ACL/mode preserved, foreign paths/tasks/processes untouched |
| CLI/docs | Help and README agree with actual parameters; no-wait is explicitly unverified |

Historical migration tests must use actual historical source and deployed
artifacts, not only change a version marker on identical source. For future
multi-revision tests, also assert source/build identity and runtime behavior.
Expose test-only faults only through isolated fixtures, not undocumented
production failure switches.

Publish bounded, redacted machine-readable reports and failure logs to Actions.
Never upload user secrets or unrestricted backup archives. Assert backup
counts, failed-stage mutation boundaries and printed recovery command
executability, not just successful script exit.

After all required Actions gates pass, create the main-targeted PR with results,
known limitations and recovery documentation. Do not claim Windows physical
device testing from runner evidence. The user's physical deployment starts only
after the main change is accepted and the updated scripts are available.
