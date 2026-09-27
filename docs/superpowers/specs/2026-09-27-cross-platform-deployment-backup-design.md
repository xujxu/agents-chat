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
acceptance before creating the implementation PR. Actions requires a remote
test-branch push first; confirm that ordering with the user before pushing.
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
sudo bash scripts/upgrade.sh
sudo bash scripts/deploy.sh --no-pull
sudo bash scripts/restore.sh
```

Windows, from an elevated PowerShell terminal:

```powershell
.\scripts\deploy.ps1
.\scripts\upgrade.ps1
.\scripts\deploy.ps1 -SkipGitPull
.\scripts\restore.ps1
```

`deploy` supports both first installation and existing deployment.
`upgrade` requires an existing deployment and delegates to the same transaction;
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
