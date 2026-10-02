# Cross-platform Deployment Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. If unavailable, use the previously established user-approved inline fallback; do not run local validation.

**Goal:** Add single-retained-backup deployment and explicit no-build recovery to Linux and Windows source installations, with real Actions acceptance before opening a main-targeted PR.

**Architecture:** Platform entry scripts delegate to one dependency-free Node transaction engine and narrow native service/permission adapters. The engine runs from a protected external control directory so source updates cannot remove recovery support. Native adapters retain systemd and Scheduled Task deployment, while versioned state and verified snapshots enforce the same recovery contract on both platforms.

**Tech Stack:** Node.js built-ins, Bash, Windows PowerShell 5.1, Git, systemd, Scheduled Tasks, existing Next.js application and Playwright, GitHub Actions.

---

## Approved implementation delta: update enhancements

The spec amendment at `c8e9be7` supersedes upgrade-named commands and internal
operation strings in the original tasks below. Implement inline, as confirmed
by the user; do not request another execution-mode choice.

### A. Rename and public options

- [ ] Replace the unpublished operation string `upgrade` with `update` in
  `scripts/deployment/{cli,state,transaction}.mjs` and their tests.
  Future entry points are `scripts/update.sh` and `scripts/update.ps1`;
  workflow filters/help/README must use these names, without upgrade aliases.
- [ ] Add CLI contract tests before implementation for `--dry-run`, `--json`,
  `--timeout` (positive safe integer seconds, default 1800). Windows adapters
  map `-DryRun`, `-Json`, `-TimeoutSeconds` to the same semantics. Keep readiness
  wait separate (120 seconds Linux, existing Windows 180 seconds); explicit
  stage timeout also bounds readiness if shorter.
- [ ] Reject dry-run with status/verify/restore; reject timeout zero, duplicate
  flags and invalid values before side effects. Help explains that dry-run does
  not refresh remote refs or prove compatibility.
- [ ] Run all existing contracts plus new CLI tests through the existing
  `Deployment lifecycle` Actions workflow on both platforms.

### B. Read-only planning and accurate skip

- [ ] Create `scripts/deployment/update-policy.mjs` and
  `tests/deployment-update-policy.test.mjs`.
  Export `previewUpdate(options, readers)` where readers expose only
  `inspect`, `localTarget`, `estimate`, `checks`; no mutation callbacks.
  Missing local target yields `target: null` and a named pending check.
  Invalid local data must throw rather than becoming an unknown success.
- [ ] Add `alreadyCurrent(facts)`: require operation `update`, accepted receipt,
  exact target/source/build/dependency/config/service identities, verified live
  observation and no interrupted/unverified operation. Missing evidence returns
  a non-skip reason, never defaults missing hashes to equal values.
- [ ] Test each missing or mismatched fact, deploy-forced rebuild, and original
  backup identity preserved on skip. Wire this before capacity/stop/copy in the
  transaction after real target resolution and compatibility checks.
- [ ] Preview adapters read local Git objects with no fetch; compare refs and
  filesystem/service observations before/after preview in native acceptance.
  Preview on a fresh control path must not create it.

### C. Structured output and per-stage deadlines

- [ ] Create `scripts/deployment/result.mjs` with versioned bounded JSON
  outcomes: preview, already-current, accepted, activation-unverified, failed,
  recovery-required and blocked. Fields include operationId, source/target,
  phase, elapsedMs, errorCode, runtimeState, backup, pendingChecks, nextAction.
  Never serialize raw errors, secrets or environment records.
- [ ] Create `scripts/deployment/stage-runner.mjs` and its tests. Execute
  cancellable operations using AbortSignal; on deadline abort and await the
  owned worker's settled promise. Native adapters own process-tree settlement.
  After a 30-second termination allowance, report blocked without authorizing
  runtime restart, lock release or backup cleanup.
- [ ] Durations use a monotonic clock. Persist operation phase before execution.
  Emit progress at bounded intervals with elapsed/budget, not full command
  output. Snapshot loops check cancellation between files and stream chunks.
  Never use Promise.race alone as proof that a writer stopped.
- [ ] Tests use short injected clocks/budgets without public fault switches:
  completed operation, timeout then successful settlement, failed settlement,
  cancellation, callback failure and preserved original error. Real native
  tests spawn a fixture child with a descendant and prove both are stopped.

### D. Read-only compatibility admission

- [ ] Inventory actual databases through `lib/chatStore.ts`,
  `lib/configStore.ts`, `lib/chatSyncStore.ts`, `lib/chatTransferStore.ts` and
  `lib/scheduler/scheduleStore.ts` before implementing the checker. Record
  database paths, required tables/columns and supported migration markers in
  `scripts/deployment/compatibility.mjs`, with fixtures in
  `tests/deployment-compatibility.test.mjs`.
- [ ] Inspect target files via Git objects, not checkout or candidate execution.
  Check `scripts/deployment/protocol.json`, declared Node engines and required
  configuration schema. Require explicit bounded target compatibility metadata
  for new versions; define the historical main638c553 shape from source.
  Do not pretend the existing migration-marker table is a universal schema ID.
- [ ] Use the installed SQLite binding in read-only, fileMustExist mode, with
  a coherent read transaction and no call to application store initialization.
  Account for WAL. Refuse if inspection cannot remain read-only or required
  schemas are unknown; missing databases on fresh installation are distinct
  from malformed existing files. Test no new database/WAL/SHM files are created.
- [ ] Snapshot and inspect configuration bytes without rewriting; report names
  of missing/invalid settings, never values. Admission failure precedes stop.
  Target engine/protocol/schema incompatibility remains nonzero with a next
  action; no automatic data migration or database rollback is added.

### E. Integration, documentation and acceptance

- [ ] Wire A-D into the native entry points in original Tasks 4-8. README
  lists update-only commands and all new flags with preview/no-op limits.
- [ ] Add Linux/Windows scenarios: fresh and existing read-only preview,
  true no-op, altered artifact/receipt/config non-no-op, unsupported schema/
  runtime rejection, worker timeout/cancellation, JSON output parseability.
- [ ] Retain ALL real first-deploy, historical-update and no-build restore
  gates. Primitive contract success does not authorize the PR. Run code only
  in Actions, push fixes, and retain causal evidence in session tasks.

## Original execution boundary and implementation tasks

Worktree:
`/home/xujx/.copilot/session-state/e73b95d5-ad21-48c7-9442-2b5766b797a1/files/deployment-backup`

Branch: `feat/deployment-backup`, based on main
`638c553c62406dbb7e6b5aeb41cdddf4cd6de179`.

Approved spec:
`docs/superpowers/specs/2026-09-27-cross-platform-deployment-backup-design.md`
(local commit `5d2efda`).

The user explicitly approved test-branch pushes BEFORE Actions, and a PR only
AFTER required Linux and Windows acceptance. Do not push directly to main.
Do not modify the live checkout or use its secrets in fixtures. No local
tests, syntax checks, dependency installs, builds or servers.

Run all GitHub commands with `-R xujxu/agents-chat`: the worktree's implicit
GitHub CLI repository previously resolved to a different upstream.
Do not import the voice feature or modify its draft PR during this implementation.

Use short Actions summaries and bounded artifact reads. Report progress at
least every 15 minutes while working or waiting; stop reminders when paused.

## File ownership

| File | Responsibility |
| --- | --- |
| `scripts/deploy.sh`, `scripts/deploy.ps1` | Public deployment entry and native privilege checks |
| `scripts/update.sh`, `scripts/update.ps1` | Require an existing deployment; delegate without pulling first |
| `scripts/restore.sh`, `scripts/restore.ps1` | Discover and invoke the external recovery entry |
| `scripts/deployment/protocol.json` | Explicit transaction protocol version accepted at source handoff |
| `scripts/deployment/cli.mjs` | Parse normalized arguments, dispatch engine, print actionable errors |
| `scripts/deployment/state.mjs` | Atomic journal, exclusive owner lock, phase/rotation reconciliation |
| `scripts/deployment/snapshot.mjs` | Inventory, streaming copy/hash, manifest verification, bounded rotation |
| `scripts/deployment/source.mjs` | Clean source checks, target resolution, source archive/provenance |
| `scripts/deployment/transaction.mjs` | Deployment and recovery sequencing; no platform service commands |
| `scripts/deployment/linux.sh` | systemd ownership, stop/start, config capture/restore, modes/ownership |
| `scripts/deployment/windows.ps1` | Task ownership, process tree, config/ACL capture/restore, task activation |
| `scripts/deployment/recovered-start.ps1` | Start saved Windows build without running historical build-on-start |
| `scripts/start.ps1`, `scripts/service-watchdog.ps1` | Wire validated prebuilt startup and owned-process shutdown |
| `scripts/install-scheduled-task.ps1` | Preserve explicit/current account, trigger and watchdog arguments |
| `tests/deployment-state.test.mjs` | State, lock and diagnostic contracts |
| `tests/deployment-snapshot.test.mjs` | Real temporary filesystem copy/rotation/path/space contracts |
| `tests/deployment-transaction.test.mjs` | Sequencing, injected failures, no mutation before backup |
| `tests/deployment-cli.test.mjs` | Public flags/help, conflict handling, output/exit semantics |
| `tests/deployment-windows.test.ps1` | Native task/ACL/prebuilt-path behavioral checks |
| `tests/deployment-fixture.mjs` | Isolated app/source fixture, command transcript and bounded reports |
| `tests/deployment-service-linux.sh` | Real Linux systemd acceptance driver |
| `tests/deployment-service-windows.ps1` | Real Windows Scheduled Task acceptance driver |
| `tests/deployment-api.spec.ts` | Actual authentication/chat continuity at lifecycle boundaries |
| `.github/workflows/deployment-lifecycle.yml` | Red/green contracts and real dual-platform lifecycle gates |
| `README.md` | Copyable supported operations, parameters, recovery and limitations |

Do not grow `deploy.ps1` into a second independent transaction engine. Node
helpers use only built-ins: no dependency manifest changes are needed.
Preserve the existing named healthcheck tests, updating text assertions only
where behavior is intentionally moved into the shared/native helper.

## Public CLI contract to implement

| Intent | Linux | Windows |
| --- | --- | --- |
| First deploy or update | `sudo bash scripts/deploy.sh` | `.\scripts\deploy.ps1` |
| Update only | `sudo bash scripts/update.sh` | `.\scripts\update.ps1` |
| Target existing checkout from newer tools | `--project-dir /absolute/app` | `-ProjectDir C:\absolute\app` |
| Explicit fetched revision | `--revision FULL_SHA` | `-Revision FULL_SHA` |
| Keep current source | `--no-pull` | `-SkipGitPull` |
| Skip dependency install | existing `--no-install` | no new flag required |
| Health wait | existing `--wait SECONDS` | existing `-WaitSeconds SECONDS`, `-NoWait` |
| Inspect incomplete operation | `--status` | `-Status` |
| Verify previously unwaited activation | `--verify` | `-Verify` |
| Restore | `sudo bash scripts/restore.sh` | `.\scripts\restore.ps1` |
| Explicit unattended data-loss acknowledgement | restore `--accept-data-loss` | restore `-AcceptDataLoss` |
| Help | `--help` | PowerShell comment help and `-Help` |

`--revision`/`-Revision` selects a commit already present in the target checkout,
suppresses pull, and conflicts with an explicit no-pull flag. Resolve to a full
commit before stopping the runtime; reject missing objects. Default updates
fetch then resolve the upstream fast-forward target, but do not update working
files until backup is committed. First installation builds the checked-out
source without requiring a tracking branch.

Retain Windows task selection/removal/logon/trigger parameters. Add `-NoTunnel`
and `-UserId` to the deploy/task chain: they are necessary for a portable first
installation and real isolated CI, not a change to the service manager.
On update, omitted identity/mode flags preserve existing task values; on first
installation use the current valid account unless explicitly overridden.

`--status`/`-Status` is read-only and prints phase, intended revision and exact
next action without secrets. `--verify`/`-Verify` only accepts an unwaited
activation and performs readiness/identity checks before marking accepted.
If verification fails, transition to recovery-required, do not replace backup.
Normal deploy refuses incomplete/unverified state and prints these commands.

Do not add a force-reset, unlimited retention, arbitrary backup deletion or
skip-backup option. Reject unsupported parameters before side effects.

## Shared data and state contracts

Use a sibling `.<project-basename>.deployment` control root. Resolve real paths,
record the full canonical project path in its ownership manifest, reject a
symlink/reparse root and a foreign owner manifest. Avoid using short basenames
as authorization. Directories are private before credentials are written.

```text
.<project-basename>.deployment/
  owner.json
  lock/
  state.json
  deployment.json
  engine/
  restore.sh OR restore.ps1
  backup/
  staging/
  retiring/
```

`backup` is the only retained full snapshot. `staging` and `retiring` are fixed
transient slots; their combined occupancy never produces three snapshots.
The small engine/control area is not another copy of runtime data.
Save the matching recovery engine inside each complete snapshot. The external
restore entry dispatches through that snapshot's validated engine, not through
whatever implementation the latest source checkout contains. Updating the
deployment engine must not invalidate recovery of the retained backup.

`protocol.json` initially contains:

```json
{"version":1,"snapshotVersion":1}
```

Journal fields:
`version`, `operationId`, `project`, `operation`, `phase`, `previousPhase`,
`sourceCommit`, `targetCommit`, `backupId`, `priorRuntime`, `runtimeIdentity`,
`startedAt`, `updatedAt`, `errorCode`.
Do not store raw environment or command output. Restrict transitions to:

```text
preflight -> stopped -> copying -> rotating -> backup-ready
backup-ready -> source-selected -> dependencies -> building -> configuring
configuring -> activating -> accepted | activation-unverified
activation-unverified -> accepted | recovery-required
restore-preflight -> restoring -> restore-activating -> restored
```

First deployment skips `copying`, `rotating`, `backup-ready` and carries no
previous backup ID. A caught post-mutation error transitions to
`recovery-required`; an interrupted journal retains its last durable phase.
Atomic writes use a private temporary file, flush/close, then rename. Where
directory fsync is unsupported, report/document the durability boundary rather
than promising immunity to every filesystem/power failure.

Snapshot manifest fields:
`version`, `id`, `project`, `createdAt`, `source`, `runtime`, `entries`.
Each entry records `path`, `kind`, `bytes`, `sha256` for files and the native
permissions/owner or ACL reference. Record absent managed paths explicitly.
Build provenance includes `.next/BUILD_ID` and source/dependency identity.
Bootstrap snapshots mark provenance `observed`, not `verified`.

Source checks exclude only known runtime config files such as `agents.json`
from the dirty-source rejection, since those are separately backed up and
preserved; reject edits to application/scripts/lockfile. Show names, not contents.
Snapshot source using Git's tracked tree archive and preserved runtime overrides,
not a recursive `.git`/worktree copy. Keep saved source available if Git objects
later vanish; restoration must not fetch.

Normal `node_modules/.bin` relative links inside the captured tree are valid;
preserve and verify their targets without dereferencing outside it. Reject
unsupported reparse points, external symlinks and mount escapes before mutation.

## Task 1: Establish Actions and RED contract evidence

**Files:** Create workflow, four Node test files and fixture file listed above.

- [ ] Add workflow triggers for pushes to `feat/deployment-backup`, relevant PR
  paths and `workflow_dispatch`. Use `permissions: contents: read`, Node 24 and
  a two-OS contract matrix (`ubuntu-24.04`, `windows-2022`). No credentials are
  propagated to managed application processes.
- [ ] Add the following complete state contract first. It intentionally fails
  until `scripts/deployment/state.mjs` exists:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryAdvice, nextPhase } from '../scripts/deployment/state.mjs';

test('update cannot overwrite dependencies before a complete backup', () => {
  assert.throws(() => nextPhase('copying', 'dependencies'), /transition/i);
  assert.equal(nextPhase('backup-ready', 'source-selected'), 'source-selected');
});

test('failure exposes a concrete recovery command without claiming rollback', () => {
  const advice = recoveryAdvice({
    operation: 'update',
    phase: 'building',
    backupComplete: true,
    restored: false,
    restoreCommand: "sudo bash '/srv/.chat.deployment/restore.sh'",
    diagnosticCommand: 'sudo journalctl -u agents-chat -n 40 --no-pager',
  });
  assert.equal(advice.status, 'recovery-required');
  assert.equal(advice.command, "sudo bash '/srv/.chat.deployment/restore.sh'");
  assert.match(advice.message, /not restored/i);
  assert.match(advice.message, /building/i);
});

test('first installation never invents a rollback backup', () => {
  const advice = recoveryAdvice({
    operation: 'deploy',
    phase: 'building',
    backupComplete: false,
    restored: false,
    retryCommand: "sudo bash '/srv/chat/scripts/deploy.sh' --no-pull",
    diagnosticCommand: 'sudo journalctl -u agents-chat -n 40 --no-pager',
  });
  assert.equal(advice.status, 'no-backup');
  assert.match(advice.message, /no .*backup/i);
  assert.equal(advice.command, "sudo bash '/srv/chat/scripts/deploy.sh' --no-pull");
});
```

- [ ] Add table-driven CLI cases: invalid flags, mutually exclusive revision and
  no-pull, invalid wait, restore without confirmation, unverified activation,
  preservation of omitted Windows identity flags. A failure must occur before
  the fixture's mutation transcript gets its first entry.
- [ ] Run only in Actions:

```bash
node --test tests/deployment-state.test.mjs tests/deployment-snapshot.test.mjs tests/deployment-transaction.test.mjs tests/deployment-cli.test.mjs
```

Create test files with actual assertions, not empty passes. At the first red
checkpoint it is acceptable for new-module imports to fail; subsequent feature
checkpoints must fail on the intended behavioral assertion, not fixture setup.

- [ ] Commit tests/workflow with the required co-author trailer, then push:

```bash
git push -u origin feat/deployment-backup
gh run list -R xujxu/agents-chat --branch feat/deployment-backup \
  --workflow deployment-lifecycle.yml --limit 3 \
  --json databaseId,headSha,status,conclusion
```

Record the exact red commit/run. Do not create a PR.

## Task 2: State, locking and failure advice

**Files:** `state.mjs`, `cli.mjs`, `protocol.json`, state/CLI tests.

- [ ] Implement `nextPhase(from, to)` from the explicit transition table and
  `recoveryAdvice(details)` returning `{status, message, command, diagnostics}`.
  Every failing path has a next action; commands use shell-specific quoting,
  including paths with spaces and apostrophes. No environment data enters them.
- [ ] Implement exclusive acquisition with `mkdir`, owner PID, process start
  identity, operation ID and canonical checkout. A PID alone is insufficient
  after reuse. Do not take over a lock while the owner or owned worker is alive.
- [ ] Implement `loadState`, `writeState`, `acquireLock`, `releaseLock` and
  `reconcileInterruptedOperation` in the state module. Only release an owned
  lock. Preserve the journal across signals; use try/finally without hiding
  the original failure.
- [ ] Reconcile fixed slot states from manifest/completion markers, not names
  alone. Unknown/conflicting ownership or two incompatible complete candidates
  yields inspection instructions, not a guessed deletion.
- [ ] Expand tests for an alive lock, stale owner, PID reuse fixture, corrupt
  state, interrupted atomic write, unexpected phase and shell quoting.
  Fixtures inject filesystem/process observations through function arguments;
  production CLI exposes no fault-injection switches.
- [ ] Push and obtain green state/CLI cases on both OSes. Keep snapshot/transaction
  expected-red cases identifiable; do not mark the whole feature green yet.

## Task 3: Complete snapshots and bounded rotation

**Files:** `snapshot.mjs`, `source.mjs`, snapshot tests.

- [ ] Before implementation, add filesystem regressions for these exact states:

| Starting slots | Expected result |
| --- | --- |
| complete `backup`, failed incomplete `staging` | Keep backup, report incomplete staging, never allocate another slot |
| complete backup and complete staging | Validate staging before rotation; old backup remains until then |
| complete retiring and complete staging, no backup | Finish promotion without losing either candidate |
| complete backup and retiring | Verify promoted backup, remove only owned retiring snapshot |
| complete backup, insufficient bytes | No stop/mutation/copy/rotation |
| corrupt staging file/hash | Old backup unchanged, error and cleanup/retry instruction |
| foreign marker or external link | Reject before deleting or overwriting anything |

- [ ] Implement `inventorySnapshot`, `estimateRequiredBytes`, `createSnapshot`,
  `verifySnapshot`, `rotateSnapshot`, `reconcileSnapshotSlots` with streaming
  file copy/hash, an explicit allowlist and native metadata adapters. Never
  load a whole model, archive, SQLite DB or node_modules tree into RAM.
- [ ] Build source inventory from Git tracked paths and runtime scope. Include
  configuration and old build/dependencies; exclude `.git`, nested registered
  worktrees, logs/cache directories and the owned control root. Include model
  assets in application `.data`. Preserve supported relative links.
- [ ] Use filesystem available bytes and inventory totals; account for a new
  snapshot while old backup exists and separately expose deployment headroom.
  Capacity checks are advisory against concurrent disk use; copy ENOSPC still
  aborts safely without deleting the authoritative snapshot.
- [ ] Copy only after the native adapter has confirmed a stopped runtime.
  Write verified manifest/completion last. Switch `backup` to `retiring`, then
  `staging` to `backup`, persisting each transition; remove retiring only after
  validating the new backup. Fail closed if cleanup cannot complete.
- [ ] Add a fixture that mutates live files after snapshot and verifies saved
  content is unchanged (no hardlink aliasing). Check executable modes on Linux,
  UTF-16LE config byte preservation and Windows ACL behavior on native runners.
- [ ] Assert counts and byte totals after two rotations and every injected
  interruption. Exactly one complete snapshot after success, at most two
  during replacement, and no timestamped full directories.
- [ ] Commit/push and retain green snapshot evidence on both platforms.

## Task 4: Linux transaction and deployment entry points

**Files:** Linux deploy/update/restore entry points, `linux.sh`,
`transaction.mjs`, `source.mjs`, transaction tests.

- [ ] Write failing transcript tests for both deploy and update requiring:

```text
inspect -> resolve-target -> capacity -> stop -> snapshot -> verify-snapshot
-> rotate -> select-source -> dependencies -> build -> configure -> start -> verify
```

Default deploy on a fresh installation skips backup/stop-old and never reports
an old restore point. `update` on a fresh installation fails before any write.
The test observes the same common engine for both entry points.

- [ ] Implement native operations `inspect`, `stop`, `capture`, `configure`,
  `activate`, `probe`, `restore-config`, `permissions`. Return structured,
  bounded results; never parse success from a log sentence alone.
- [ ] Validate service WorkingDirectory, main process/cgroup, ExecStart and
  overrides before stop. Preserve non-root runtime identity and absolute Node
  location. Preserve unit enabled/active states and optional file absence.
  Reject unowned ports/services, unsupported external environment paths or
  uncertain writers rather than stopping arbitrary PIDs.
- [ ] Implement source selection only after complete snapshot. Default
  fast-forward updates use a pinned resolved commit; explicit revision selects
  that commit without changing unrelated branches. Reject dirty source and
  Git divergence without resets. Keep app runtime configs across switches.
- [ ] Stage the new trusted engine in the external control area and verify its
  protocol before source-handoff execution. Parent transaction retains the
  lock/ownership and records the handoff; no second backup or pull.
  Incompatible target tooling produces the saved restore command.
- [ ] Preserve `npm ci`, `npm run build` and systemd activation behavior; build
  once. Do not mutate the unit before backup. Make health acceptance validate
  the managed listener and HTTP 2xx readiness, not an unrelated listener.
- [ ] Cover backup failure (restart only previously-running untouched runtime),
  dependency/build failures (recovery required), activation failure and no-wait.
  Capture exact command output; assert nonzero exit and truthful runtime state.
- [ ] Push and run Linux real first-deploy smoke before Windows integration,
  but do not treat Linux success as the final acceptance gate.

## Task 5: Windows transaction and validated startup

**Files:** Windows deploy/update/restore entries, `windows.ps1`,
`recovered-start.ps1`, `start.ps1`, `service-watchdog.ps1`,
`install-scheduled-task.ps1`, native Windows tests.

- [ ] Add behavioral native tests showing that the existing build-on-start
  chain would rebuild during recovery. Retain this red evidence before adding
  prebuilt startup; string presence tests alone are insufficient.
- [ ] Implement native operations matching Task 4's contract. Export the
  task definition and identity without credentials; capture file ACLs and
  any application-specific environment state needed for startup.
  Stop and inhibit owned watchdog/task restarts before snapshotting.
- [ ] Replace hardcoded account defaults with current/explicit identity for
  first installation. Preserve existing principal, trigger, logon type,
  NoTunnel choice and enabled state on update unless explicitly overridden.
  Unsupported credential-dependent task restoration must fail in preflight,
  not silently register as another user or invent stored credentials.
- [ ] Trace task action, working directory and child tree ownership. Use
  specific recorded PIDs with identity checks. Remove the deployment-path
  assumption that any process on port 3000 belongs to this app. Fix the
  existing watchdog parameter named `$Pid` where the new stop path touches
  it, since PowerShell's automatic `$PID` variable is read-only.
- [ ] Keep normal deployment's build-on-start where required by the existing
  watchdog; report a build failure as a failed activation, never a healthy
  task just because the task is Running or a log exists.
- [ ] Add a prebuilt startup route guarded by a validated recovery receipt:
  it requires the saved `.next/BUILD_ID`, source/dependency identity and the
  intended runtime account. It neither removes `.next` nor invokes npm/npx
  installation or a build. Launch the local Next CLI with the known Node path.
- [ ] For older source without the new startup option, the saved
  `recovered-start.ps1` is the controlled task launcher. Preserve the recorded
  user/trigger/tunnel mode; disclose the temporary action indirection.
  Reuse startup/tunnel supervision behavior without rewriting unrelated app
  features. Do not claim byte-identical historical action restoration.
- [ ] Preserve normal tunnel behavior and add an explicit `-NoTunnel` path
  through deploy/task/watchdog for CI and users with external HTTPS.
  Recovery validates local serving without requiring package/network access;
  configured tunnel reconnection failures are surfaced separately, not hidden.
- [ ] Run PowerShell 5.1 parsing and native behavioral tests in the Windows
  Actions job. Include existing scheduled-task and startup-health regressions.
- [ ] Commit/push; retain real Scheduled Task first-deployment evidence before
  beginning recovery acceptance.

## Task 6: Explicit recovery and interruption handling

**Files:** `transaction.mjs`, external recovery installation in both adapters,
restore entries, state/snapshot/transaction/native tests.

- [ ] Add failing restore tests requiring a data-loss acknowledgement, an
  intact verified snapshot and a matching installation owner. Corruption,
  wrong project, insufficient restoration space or unsupported task identity
  must fail before stopping the current service.
- [ ] Print revision, timestamp and data-loss consequence before confirmation.
  Interactive negative/EOF leaves everything unchanged; unattended invocation
  without `--accept-data-loss`/`-AcceptDataLoss` fails explicitly.
- [ ] Restore source/runtime/configuration from backup without moving away or
  deleting the authoritative snapshot. Record each restore phase so interruption
  can resume idempotently. Restore absent-path metadata and native permissions.
  Do not preserve another full failed-state copy or back up the backup.
- [ ] Restrict cleanup to manifest-managed paths and owned directories.
  Unexpected files/links or user source edits require an explicit stop, not
  `git reset --hard`, `git clean` or a recursive delete of the checkout.
- [ ] Start the restored runtime through native no-build activation and check
  HTTP, listener identity, configuration and saved data. Clear recovery-required
  state only after acceptance; retain one backup for retry.
- [ ] Test OOM-like abrupt process termination by fixture-controlled child PID
  kill at copying, each rotation rename, source mutation and restoring phases.
  On re-entry assert state diagnosis, a runnable next command and no third
  snapshot. Do not expose kill/fault flags in production commands.
- [ ] Copy the printed external restore command out of the failure report and
  execute that command in the isolated acceptance driver, supplying the explicit
  data-loss acknowledgement. Verify recovery still works with the project's
  restore wrapper absent. Do not reconstruct a different command in the test.
- [ ] Instrument the fixture's npm/build invocations and saved BUILD_ID; before
  restore make package acquisition unavailable in the fixture. Assert no
  install/build count increment and no new BUILD_ID after restoration.
- [ ] Push and require green failure/recovery contracts on both platforms.

## Task 7: Real dual-platform lifecycle acceptance

**Files:** Actions workflow, service drivers, fixture, API Playwright spec.

- [ ] Add isolated `linux-lifecycle` and `windows-lifecycle` jobs on
  `ubuntu-24.04` and `windows-2022`. Each obtains full Git history and uses a
  disposable deployment checkout under runner temporary storage, outside the
  test-source checkout. Refuse preexisting service/task/port ownership.
- [ ] Implement the historical baseline at exact commit
  `638c553c62406dbb7e6b5aeb41cdddf4cd6de179`, preserving its application source.
  Build and run actual Next.js artifacts with test-only credentials and real
  SQLite persistence. Fixture-only task/account/environment bootstrap is
  allowed but must be recorded, not described as unchanged historical installer
  acceptance. Never hide a legacy installer failure by changing app source.
- [ ] On Windows, the historical fixture may launch the unmodified historical
  `start.ps1 -NoTunnel` under a runner-owned task; disclose this initial task
  action. Verify candidate adoption checks validate the recorded ownership
  rather than accepting any arbitrary task name. Separately test candidate
  first installation through its real public deploy entry.
- [ ] New-script bootstrap must occur from the separate trusted tools checkout
  with `--project-dir`/`-ProjectDir`, targeting the old checkout and explicit
  candidate revision. Do not pull the app before its first backup.
- [ ] Add API/browser continuity checks with the real login and `/api/chats`
  endpoints, not intercepted chat storage. The existing mobile login helper
  waits for a fixture message, so do not use it for initial empty-history seed:

```typescript
import { expect, test } from '@playwright/test';

test('deployment preserves authenticated chat state', async ({ page }) => {
  expect(process.env.DEPLOYMENT_ACCEPTANCE_ACTION).toMatch(/^(seed|verify)$/);
  await page.goto('/login');
  await page.getByPlaceholder('Admin username').fill(process.env.ADMIN_USERNAME || 'admin');
  await page.getByPlaceholder('Password').fill(process.env.ADMIN_PASSWORD || 'admin123');
  await page.locator('button[type="submit"]').click();
  const api = page.context().request;
  await expect.poll(async () => {
    const session = await api.get('/api/auth/session');
    expect(session.status()).toBe(200);
    return Boolean((await session.json()).user);
  }).toBe(true);
  const id = 'deployment-preserved-chat';
  if (process.env.DEPLOYMENT_ACCEPTANCE_ACTION === 'seed') {
    const response = await api.post('/api/chats', {
      data: {
        chat: {
          id, name: 'Deployment continuity', ts: 1, agentSessions: {},
          messages: [{ id: 'saved-message', type: 'user', ts: 1,
            content: 'Must survive source update' }],
        },
      },
    });
    expect(response.ok()).toBeTruthy();
  }
  const response = await api.get(`/api/chats?id=${id}`);
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.chat.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: 'saved-message', content: 'Must survive source update',
    }),
  ]));
});
```

The lifecycle driver sets the acceptance action explicitly and uses only
ephemeral test credentials. It must not call `installMobileChatFixture`.

- [ ] Execute each lifecycle below as a distinct reported scenario:

| Scenario | Assertions beyond script exit |
| --- | --- |
| Candidate first deploy | Real owned service/task, listener and login; build completed; no old backup |
| Historical baseline to candidate | Historical app was running; backup identity matches it; candidate source and build run; saved chat/config persists |
| Second candidate deployment | Exactly one backup containing the immediately preceding accepted state; no leftover staging/retiring slots |
| Dependency/build failure | Nonzero exit, old backup intact, owned runtime stopped, printed next command |
| Explicit recovery | Previous source, BUILD_ID, data/config and account restored; no install/build |
| Interrupted copy/rotation/restore | Durable phase report, bounded copies, safe retry or explicit stop |
| Insufficient space/concurrency | No source/config/runtime mutation before refusal |
| Unwaited activation | Not labeled accepted; verify entry resolves or reports failure |

- [ ] Test insufficient space and controlled install/build failure through
  narrow injected helper tests and isolated command fixtures; include at least
  one failed real deployment followed by real service/task restoration per OS.
  No production test flags. Do not replace actual first-deploy/update jobs
  with mocked systemctl/Scheduled Tasks.
- [ ] Source/build acceptance checks compare the pinned Git tree, deployed
  build receipt, actual `.next/BUILD_ID` served assets and managed process
  working directory. A synthetic version string alone cannot pass.
- [ ] Publish `deployment-report-linux.json` and
  `deployment-report-windows.json` with scenario statuses, source/BUILD_ID,
  backup counts, phase, restore command execution result and build counters.
  Keep logs bounded and redacted; never upload whole backup directories.
- [ ] Use always-run owned-resource cleanup in Actions. Stop only fixture-owned
  service/task/PIDs, preserve diagnostic reports, and propagate cleanup failure.
- [ ] Run existing narrow script regression checks, production build/typecheck,
  and the real API/browser continuity case in Actions:

```bash
node tests/deploy-script-scheduled-task.test.js
node tests/start-script-healthcheck.test.js
npx tsc --noEmit --incremental false
npx playwright test --config tests/playwright.config.ts tests/deployment-api.spec.ts --project=desktop-chromium --workers=1
```

The builds happen through deploy lifecycle rather than an unnecessary separate
build where the same revision has already been built. Install Chromium in the
runner for this test using the existing Playwright version.

## Task 8: README and final evidence

**Files:** `README.md`, CLI tests, this plan's execution evidence section.

- [ ] Replace ambiguous deployment prose with distinct Linux/Windows sections:
  prerequisites, first deployment, update, fixed revision, historical bootstrap,
  all flags, backup contents/location, downtime/capacity, errors and recovery.
  Explain default account selection and preserved overrides without claiming
  that a non-root user can run systemctl without permission.
- [ ] Include the exact public examples from the CLI table. For old installations,
  show running newer tools from a separate checkout against the old project;
  explain why manually pulling first cannot protect the pre-pull source state.
- [ ] Show representative failure output using the actual CLI format, including
  external recovery path, revision, data-loss prompt and diagnostic command.
  Document no-wait verification and OOM/reboot re-entry.
- [ ] Document one retained backup, temporary two-copy peak and refusal on
  insufficient space. State that user-created backups and historical application
  data are not automatically purged. Explain only the explicit restore can
  discard post-backup database activity.
- [ ] Add CLI/doc contract assertions for every public parameter and example.
  Do not declare unsupported environment/identity/tunnel cases supported.
- [ ] Commit/push documentation and any final fixes; run required workflow for
  the final code revision and inspect BOTH OS reports. Follow failures to their
  root cause, retain causal red/green evidence, and never substitute a rerun
  success for an explained consistent defect.
- [ ] Only after all required gates pass, invoke `create-pr` skill and open a
  focused PR to main. Include exact final tested commit, Linux/Windows Actions
  links, backup/restore behavior and physical-test limitations. No merge/tag
  or public release is implicit.
- [ ] Leave live environment untouched until the user proceeds with the new
  scripts after main integration. Then refresh the physical deployment plan
  and bring the common deployment changes into the voice branch.

## Evidence and completion rules

For every implementation task, record its commit, targeted Actions run,
expected failure or acceptance result and any remaining gate in session todos.
Keep product edits and regression coverage in coherent commits with:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

Completion requires real first-deploy and historical-update acceptance on
both platforms, executed recovery commands, bounded snapshot counts, correct
permissions/identity, README/CLI consistency and a PR created only after green
acceptance. A plan, a branch push, mocks alone, or only Linux success is not
completion.

At plan creation no implementation or acceptance run has happened. The old
PoC service and the earlier voice branch remain untouched.

## Implementation checkpoint: 2026-09-27, foundation contracts

The first implementation batch is saved through code commit
`5bde1d92839e4a5b053af013f92edc86ad164989`.
Actions run `36305762200` passed: Linux 59 contracts; Windows 58 contracts and
one explicitly Linux-only symlink test skipped. This is NOT real deployment,
update or recovery acceptance, and does not authorize the implementation PR.

Implemented foundation modules:

- State/CLI contracts, journal transitions, exclusive process-identity locks
  and conservative diagnosis of interrupted operations.
- Streaming file snapshots with checksums and a fixed staging/retiring rotation.
  Contracts cover incomplete/corrupt replacements, two interrupted rename states,
  foreign snapshot rejection and one retained complete backup after rotation.
- Callback-based deployment sequencing with durable phase recording before
  source/dependency/build mutations and explicit failure cleanup behavior.
- Git source inspection, target resolution without checkout mutation, explicit
  selection, preserved runtime configuration, fast-forward updates and refusal
  of dirty or diverged source.

Relevant causal evidence:

| Change | Red evidence | Green evidence |
| --- | --- | --- |
| Initial state/CLI | `5490981`, run `36294961739` | `e7babaa`, run `36295093270` |
| Snapshot implementation | `6fea6e0`, run `36295117640` | `8a311d4`, run `36305379789` |
| Phase recording before mutation | `4f0302a`, run `36305466780` | `2febb97`, run `36305546381` |
| Source selection | `97f44eb`, run `36305634573` | `5bde1d9`, run `36305762200` |

Two fixture corrections did not relax product guards: Windows temporary paths
are canonicalized before snapshot tests; clone fixtures establish
`core.autocrlf=false` before initial checkout rather than making an initially
clean Windows checkout appear modified afterward. Transaction phase tests were
also moved out of an accidentally nested test registration.

Remaining required integration, not yet implemented:

- Native systemd and Scheduled Task/ACL adapters; public deploy/update/restore
  entry wiring; external private control ownership and versioned engine handoff.
- Complete source/runtime inventory and source archive, absent-file metadata,
  native permission restoration, Windows reparse/link support and validated
  no-build historical Windows launcher. Current Windows snapshots explicitly
  reject links; do not treat this primitive as complete Windows deployment support.
- Recoverable cleanup after interruption during retirement deletion (as opposed
  to the already covered rename boundaries), native capacity preflight,
  interrupted-child ownership and explicit restore/data-loss confirmation.
- Real application first installation, historical update, subsequent rotation,
  failure and no-build restore on BOTH OSes; README/public parameter completion.

No existing deploy entry point, main branch or live service was changed.
The next batch should wire native lifecycle and recovery support, expanding
behavioral fault contracts before claiming end-to-end acceptance.

## Update enhancement checkpoint (2026-09-27)

Written enhancement approval was received after spec commit `c8e9be7`.
Implementation remains inline on `feat/deployment-backup`, with all execution
and validation in GitHub Actions. No public deploy script, main branch or live
service has been changed.

### Accepted foundation changes

- Internal operations, source errors and workflow filters use `update`, without
  an `upgrade` alias. The parser supports `--dry-run`, `--json` and positive
  `--timeout` seconds (1800 default); public/native parameter wiring is not done.
- `update-policy.mjs` supplies read-only planning and a strict accepted-identity
  no-op predicate. `source.mjs` previews local objects without fetching or index
  refresh, disables optional Git locks/lazy fetch, and reports unknown targets.
  The transaction dispatches preview before normal callbacks and requires
  compatibility admission before capacity, state changes or downtime.
- `stage-runner.mjs` uses monotonic elapsed time and cancellable stage signals.
  Deadline/cancellation waits for worker settlement with a 30-second allowance.
  Unsettled workers fail with `recoveryAllowed=false`; late success, including
  synchronous event-loop overruns, cannot become accepted success. Huge timeout
  values are scheduled in bounded timer chunks rather than overflowing timers.
- Transaction callbacks receive `context.signal`; readiness takes the shorter
  of its wait budget and stage deadline. Cleanup receives a fresh cancellation
  signal only after the failed worker has settled.
- Unsettled workers persist `blocked`, including during preflight before the
  first normal journal write. Blocked state retains the operation lock, refuses
  normal state replacement/restore, and offers inspection rather than rollback.
  It can explicitly record unknown runtime state instead of inventing absence.
- Snapshot inventory checks cancellation between entries. Copy and checksum
  pipelines accept the signal and settle their file streams before returning.
  Incomplete staging is retained; no cancellation path deletes the good backup.

### Causal Actions evidence

| Scope | Red evidence | Green evidence |
| --- | --- | --- |
| Update naming/options and pure policy | `8131e03`, `36306973858` | `da5b9bd`, `36307060713` |
| Local preview and transaction admission | `13a649e`, `36307103158` | `1fb9e93`, `36307161613` |
| Deadlines and worker settlement | `9efcf56`, `36307434631` | `087c618`, `36307505489` attempt 2 |
| Durable blocking and snapshot cancellation | `0dd8cf3`, `36307684146` | `c291c40`, `36307923573` |
| Preflight blocking and event-loop overruns | `1202e32`, `36307871306` | `c291c40`, `36307923573` |

Final code `c291c40` passed 91 Linux contracts and 90 Windows contracts with one
explicitly Linux-only skip. Earlier `5c47705` tests accidentally nested snapshot
cases and changed an ordinary recovery expectation; `0dd8cf3` repaired test
registration and restored that expectation before collecting corrected red
evidence. Those test mistakes did not relax production behavior.

Two Windows runs (`36307505489` attempt 1 and `36307731083`) failed exclusively
on the existing PowerShell process-identity query's 10-second cold-start bound.
The first passed unchanged on retry; recurrence led to a bounded 30-second
query allowance in `c291c40`. There is no missing-process fallback for timeout
or failed identity queries.

### Remaining integration gates

These are primitive/callback-engine contracts, NOT real native lifecycle
acceptance. In particular:

1. Native workers must resolve/reject only after all owned descendants and
   writers have stopped, or reject with `recoveryAllowed=false`. No real
   process-tree cancellation adapter or descendant-killing acceptance test has
   been implemented. Promise completion alone is not a native ownership proof.
2. Blocked state deliberately has no generic unlock/reset escape. Implement a
   separately verified ownership/settlement recovery path; never clear blocked
   state simply because the CLI parent died.
3. Target Node/protocol/config/SQLite compatibility and real accepted receipts
   still need collectors/adapters. The `admit` callback is a strict integration
   boundary, not an implemented database compatibility checker.
4. Bounded JSON/status rendering and exact public recovery commands still need
   dispatch wiring. Parser acceptance of `--json` is not that completed feature.
5. Finish the native snapshot/retirement/source/permission/restore work listed
   above, then real first deploy, historical update, rotation, failure and
   no-build restore on both operating systems.

Do not create the PR or deploy main until those native acceptance gates pass.

## Native ownership prerequisite: nested cleanup failures

The user reviewed and approved the native containment amendment `731d9b7`.
Continue inline, using the established fallback; do not repeat execution-mode
selection. This first bounded batch addresses a concrete existing recovery
gate defect before introducing platform workers. It does not implement native
containment or discharge the eight real-process acceptance groups in the spec.

**Files and responsibilities**

- Create `scripts/deployment/worker-errors.mjs`: a single bounded error-graph
  classifier; no OS calls and no dependency on native adapter implementation.
- Create `tests/deployment-worker-errors.test.mjs`: nested, cyclic, oversized
  and inaccessible error graph contracts.
- Modify `scripts/deployment/stage-runner.mjs`: classify the settled error
  using the shared helper, preserving its original object as cause.
- Modify `scripts/deployment/transaction.mjs`: use the helper at preflight,
  cleanup admission, blocked recording and aggregate result boundaries.
- Modify `tests/deployment-stage-runner.test.mjs` and
  `tests/deployment-transaction.test.mjs`: causal regression coverage for those
  real engine boundaries, not just a standalone helper test.
- Modify `.github/workflows/deployment-lifecycle.yml`: include the new Node
  test file in the existing two-platform contract invocation.

### Task N1: Make cleanup uncertainty survive error wrapping

- [x] **Step 1: Add failing tests with these concrete fixtures.**

```js
const unsafe = Object.assign(new Error('writer still alive'), {
  recoveryAllowed: false,
});
const wrapped = new Error('adapter failed', { cause: unsafe });
const aggregate = new AggregateError([new Error('ordinary failure'), wrapped]);
assert.equal(hasUnsettledWorker(wrapped), true);
assert.equal(hasUnsettledWorker(aggregate), true);
assert.equal(hasUnsettledWorker(new Error('ordinary failure')), false);
const cyclic = new Error('cycle');
cyclic.cause = cyclic;
assert.equal(hasUnsettledWorker(cyclic), false);
cyclic.errors = [unsafe];
assert.equal(hasUnsettledWorker(cyclic), true);
```

Also test 300 chained causes, 300 aggregate entries, accessor fields without
invoking getters, a proxy with a throwing descriptor trap, primitive causes,
and an outer `recoveryAllowed=true` wrapping an unsafe inner failure.
Uninspectable/over-budget graphs are conservatively unsafe; they cannot be
silently treated as normal failures.

Implementation refinement: include callable errors and inspect inherited
descriptors under the same bounded graph budget. The old direct property
checks recognized inherited `recoveryAllowed=false`; replacing those checks
must not regress that behavior. Prototype accessors are unsafe without being
invoked, and failed prototype inspection is unsafe like failed descriptor
inspection.

For transaction integration inject `wrapped` and `aggregate` from inspect,
snapshot, build, and recovery stop. Assert no subsequent mutation and durable
blocked phase; cleanup/state errors retain all original causes. For the stage
runner reject the wrapped error after its abort event and assert
`DEPLOYMENT_WORKER_UNSETTLED`, `recoveryAllowed=false`, and original cause.

- [x] **Step 2: Commit/push only tests and workflow.**

```bash
git add tests/deployment-worker-errors.test.mjs tests/deployment-stage-runner.test.mjs tests/deployment-transaction.test.mjs .github/workflows/deployment-lifecycle.yml
git commit -m "test: retain worker uncertainty through nested errors" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

Run only in Actions:
`node --test tests/deployment-worker-errors.test.mjs tests/deployment-stage-runner.test.mjs tests/deployment-transaction.test.mjs`
(the workflow includes existing contracts as well). Expected red: missing
worker-errors export/module and wrapped failures incorrectly permitting cleanup.
Inspect the actual returned run ID with `gh run view`; do not run tests locally.

- [x] **Step 3: Implement the bounded classifier and replace every gate.**

```js
export function hasUnsettledWorker(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === null || !['object', 'function'].includes(typeof current) || seen.has(current)) continue;
    if (seen.size >= 256) return true;
    seen.add(current);
    try {
      pending.push(Object.getPrototypeOf(current));
      const fields = ['recoveryAllowed', 'cause', 'errors'].map(key =>
        Object.getOwnPropertyDescriptor(current, key));
      if (fields.some(field => field && !Object.hasOwn(field, 'value'))) return true;
      if (fields[0]?.value === false) return true;
      if (fields[1]) pending.push(fields[1].value);
      const errors = fields[2]?.value;
      if (errors !== undefined) {
        if (!Array.isArray(errors)) return true;
        const length = Object.getOwnPropertyDescriptor(errors, 'length')?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 256) return true;
        for (let index = 0; index < length; index++) {
          const entry = Object.getOwnPropertyDescriptor(errors, String(index));
          if (!entry || !Object.hasOwn(entry, 'value')) return true;
          pending.push(entry.value);
        }
      }
    } catch {
      return true;
    }
  }
  return false;
}
```

Descriptor inspection must not invoke arbitrary getters. The catch returns
unsafe classification, which is surfaced as blocked by callers; it is not a
success fallback. The classifier uses the owned error fields emitted by these
deployment adapters; arbitrary third-party failures must be wrapped in this
contract at the boundary. Do not serialize raw causes into public output.

In both engines import the named helper from `./worker-errors.mjs`.
Replace `settled.error?.recoveryAllowed === false` with
`hasUnsettledWorker(settled.error)` and every transaction direct field check
with the same predicate. For arrays of failures use
`errors.some(hasUnsettledWorker)` and `!errors.some(hasUnsettledWorker)`.
Preserve original thrown errors and causes; do not reconstruct their messages.

- [x] **Step 4: Commit/push implementation and await both OS jobs.**

```bash
git add scripts/deployment/worker-errors.mjs scripts/deployment/stage-runner.mjs scripts/deployment/transaction.mjs
git commit -m "fix: preserve nested worker uncertainty across recovery gates" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

Expected green: all existing and new contracts pass on both OSes, retaining the
one explicitly Linux-only skip on Windows. Record actual IDs/results below.
If tests fail, inspect bounded Actions logs, fix the cause and push again.

- [x] **Step 5: Persist evidence and carry forward native gates.**

Record the accepted commit/run in this plan and session tasks. The next native
batch must specify its private bootstrap transport, OS interop and durable
admission/settlement receipts before writing platform code. Preserve the
approved spec's requirements; do not substitute process groups/taskkill or
claim that this error-classification fix delivers native process containment.

### N1 acceptance checkpoint

- Causal red: `55c1d33`, Actions `36309086437`. Both platforms fail the three
  new integration contracts (cancelled stage, preflight/mutation suppression,
  and nested cleanup plus journal failure), plus the missing classifier module.
- Initial green: `7d9a7af`, Actions `36309147470`.
- Compatibility refinement red: `c3fd589`, Actions `36309168991`. Both
  platforms expose the inherited-marker regression; ordinary direct property
  access previously respected those markers.
- Accepted implementation: `f3b90a063d5b128c2a2a2f92e2305cf56d394850`,
  Actions `36309230366`. Linux: 101 pass. Windows: 100 pass, one existing
  Linux-only skip. Zero failures on either platform.
- Classifier traversal now includes inherited descriptors and callable errors,
  shares the 256-node budget, never invokes accessors or custom array iterators,
  and blocks on malformed or uninspectable graphs. Both engine boundaries use
  it without replacing the original error objects.
- Validation ran exclusively in GitHub Actions. Only `feat/deployment-backup`
  was pushed; no main, live service, public script, or installed data changes.
- N1 is complete. Native cgroup/Job adapters, their concrete implementation
  plan, and real-process acceptance remain outstanding, followed by the
  previously recorded public deploy/update/restore lifecycle work.

## Native worker coordinator: bounded implementation batch N2

This batch implements the shared admission/settlement ordering, not an OS
adapter. Continue inline under the existing approval. Platform interop and
transport code must follow in separate batches; no public command is wired
to these callbacks until real native acceptance succeeds.

**File map**

- `scripts/deployment/owned-worker.mjs`: `runOwnedWorker` controls one gated
  domain, its durable records and final settlement.
- `tests/deployment-owned-worker.test.mjs`: deterministic adapter fixtures
  exercising the coordinator's production control flow.
- `.github/workflows/deployment-lifecycle.yml`: run the new contracts on both
  existing OS jobs without local validation.

### Adapter boundary

`runOwnedWorker({ owner, signal }, { record, prepare })` takes an owner with
exact fields `project`, `operationId`, `workerId`, `controllerIdentity`.
`project` is absolute; other fields are nonempty bounded strings. The caller
must capture the canonical project and live controller identity under the
deployment lock, and create a fresh UUID worker ID. Inputs are copied/frozen.

`record(receipt)` durably writes a receipt before returning. Receipt fields
are `version: 1`, the frozen `owner`, `phase`, and `domain` (null until
identified). It must reject write/flush failures. No commands, environment
variables or raw errors enter receipts.

`prepare({ owner, signal })` creates only a trusted gated bootstrap and returns
a handle with:

| Member | Contract |
| --- | --- |
| `identity` | Captured platform identity described below |
| `run({ signal })` | Async one-use native command grant and result |
| `closeAdmission()` | Async irrevocable revocation of grants |
| `stop()` | Async exact-domain termination request, not exit proof |
| `join()` | Async join of all launch-capable controllers |
| `observe()` | Async `{ identity, empty }` original-domain observation |
| `retire()` | Async release of retained native handles/unit evidence after durable settlement |

N2's test fixtures implement these callbacks explicitly.
`prepare`/`run` must honor the same monotonic abort signal, including a
synchronous check at the native grant boundary. Preparation must not release
target code, including preload hooks. On preparation failure the coordinator
cannot prove domain absence: record blocked, reject with
`DEPLOYMENT_WORKER_UNSETTLED`, and never retry creation.

Linux identity has exact fields `kind: 'systemd'`, `bootId` (UUID),
`manager: 'system'`, `unit` (unique `agents-deploy-<UUID>.service`),
`invocationId` (32 lowercase hex), `controlGroup` (absolute, no dot segments).
Windows identity has exact fields `kind: 'windows-job'`,
`name: 'Local\\agents-deploy-<UUID>'`, `generation` (UUID),
`accountSid`, `sessionId` (nonnegative integer), and `ownerIdentity`.
The adapter retains the original Job handle; serialized identity alone never
grants permission to recreate/query/terminate a Job. Observation returns the
same captured identity, compared field-by-field, not object property order.

Ordered flow:

```text
abort check -> record intent -> abort check -> prepare gated domain
-> validate/copy identity -> abort check -> record owned
-> abort check -> record admitted -> abort check -> run once
-> abort local grant signal -> closeAdmission -> stop -> join -> observe
-> check exact identity AND empty === true -> record settled -> retire -> return result
```

On any post-intent error, close local admission and attempt all three cleanup
callbacks in order, even when one fails. Never call `observe` if closing,
stopping or joining failed. An empty report before that sequence cannot be
used. Successful ordinary command failure still gets a settlement receipt
and rethrows the original error. A wrapped unsafe command failure, any cleanup
failure, missing/mismatched observation or receipt failure remains unsafe;
record blocked and preserve all original errors. `settled` means only no
remaining worker, never application acceptance. Cancellation is checked again
after result/receipt awaits so a late successful callback cannot return success.
Native handles/unit evidence must not be retired before the settlement record
is durable. Failed cleanup or recording retains that evidence. Retirement
itself is checked; failure records blocked and cannot return success. A
settled-then-blocked record represents failed evidence retirement, not
permission to reopen admission or repeat the command.

There is deliberately no internal Promise.race that abandons cleanup. The
existing `runStage` supplies the deadline and settlement allowance. If a native
callback never settles, runStage retains blocked state; a late continuation
still sees closed admission and cannot grant a target command.

### Task N2

- [x] **Step 1: Add causal contract tests.**

Fixtures record each callback and return a synthetic validated identity. Test:

```js
assert.deepEqual(calls, [
  'intent', 'prepare', 'owned', 'admitted', 'run',
  'closeAdmission', 'stop', 'join', 'observe', 'settled',
]);
assert.equal(result, 23);
```

Cover abort before intent; abort during intent/prepare/owned/admitted; command
error identity; detached-work cleanup ordering; each cleanup failure; identity
replacement/nonempty/malformed observation; intent/owned/admitted/settled/
blocked receipt failures; preparation ambiguity; nested unsafe errors; and
cancellation during settlement. Assert no grant after abort and no observation
after failed controller settlement. Both OS identity shapes get fixtures;
these are explicitly mocked contracts, not native process evidence.

- [x] **Step 2: Push tests and collect causal red in Actions.**

```bash
git add tests/deployment-owned-worker.test.mjs .github/workflows/deployment-lifecycle.yml docs/superpowers/plans/2026-09-27-cross-platform-deployment-backup.md
git commit -m "test: define native worker admission and settlement ordering" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

Expected red: missing `owned-worker.mjs`. Workflow runs the exact new test file
alongside existing deployment contracts, on Linux and Windows.

- [x] **Step 3: Implement coordinator with the following core structure.**

```js
import path from 'node:path';
import { hasUnsettledWorker } from './worker-errors.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const methods = ['run', 'closeAdmission', 'stop', 'join', 'observe', 'retire'];
const text = value => typeof value === 'string' && value.length > 0
  && value.length <= 4096 && !/[\0\r\n]/.test(value);

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid owned worker ${label}.`);
  }
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
}

function captureOwner(value) {
  const owner = exact(value,
    ['project', 'operationId', 'workerId', 'controllerIdentity'], 'owner');
  if (!Object.values(owner).every(text) || !path.isAbsolute(owner.project)
    || !uuid.test(owner.workerId)) throw new Error('Invalid owned worker owner.');
  return owner;
}

function captureDomain(value, owner) {
  let identity;
  if (value?.kind === 'systemd') {
    identity = exact(value,
      ['kind', 'bootId', 'manager', 'unit', 'invocationId', 'controlGroup'], 'domain');
    const unit = `agents-deploy-${owner.workerId}.service`;
    if (!Object.values(identity).every(text) || !uuid.test(identity.bootId)
      || identity.manager !== 'system' || identity.unit !== unit
      || !/^[a-f0-9]{32}$/.test(identity.invocationId)
      || !identity.controlGroup.startsWith('/')
      || !identity.controlGroup.endsWith(`/${unit}`)
      || identity.controlGroup.slice(1).split('/').some(part => ['', '.', '..'].includes(part))) {
      throw new Error('Invalid owned worker systemd identity.');
    }
  } else if (value?.kind === 'windows-job') {
    identity = exact(value,
      ['kind', 'name', 'generation', 'accountSid', 'sessionId', 'ownerIdentity'], 'domain');
    if (identity.name !== `Local\\agents-deploy-${owner.workerId}`
      || identity.generation !== owner.workerId || !text(identity.accountSid)
      || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(identity.accountSid)
      || !Number.isSafeInteger(identity.sessionId) || identity.sessionId < 0
      || identity.ownerIdentity !== owner.controllerIdentity) {
      throw new Error('Invalid owned worker Windows Job identity.');
    }
  } else {
    throw new Error('Unsupported owned worker domain.');
  }
  return identity;
}

function failureCause(errors) {
  return errors.length === 1 ? errors[0]
    : new AggregateError(errors, 'Owned worker execution, cleanup or receipt recording failed.');
}

export async function runOwnedWorker({ owner: suppliedOwner, signal }, { record, prepare }) {
  const owner = captureOwner(suppliedOwner);
  if (typeof record !== 'function' || typeof prepare !== 'function') {
    throw new Error('Invalid owned worker adapters.');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', cancel, { once: true });
  let domain = null;
  let handle;
  let attempted = false;
  let prepared = false;
  let uncertain = false;
  let result;
  const errors = [];
  const receipt = phase => Object.freeze({ version: 1, owner, phase, domain });
  const write = async phase => {
    try { await record(receipt(phase)); }
    catch (error) { uncertain = true; throw error; }
  };
  try {
    await record(receipt('intent'));
    try {
      controller.signal.throwIfAborted();
      attempted = true;
      handle = await prepare({ owner, signal: controller.signal });
      if (!handle || methods.some(name => typeof handle[name] !== 'function')) {
        throw new Error('Incomplete owned worker handle.');
      }
      domain = captureDomain(handle.identity, owner);
      prepared = true;
      controller.signal.throwIfAborted();
      await write('owned');
      controller.signal.throwIfAborted();
      await write('admitted');
      controller.signal.throwIfAborted();
      result = await handle.run({ signal: controller.signal });
      controller.signal.throwIfAborted();
    } catch (error) {
      errors.push(error);
      if (attempted && !prepared) uncertain = true;
    }

    // Close the grant signal before awaiting any native controller cleanup.
    controller.abort(new Error('Owned worker admission closed.'));
    let cleanupFailed = false;
    if (handle) {
      for (const method of ['closeAdmission', 'stop', 'join']) {
        try {
          if (typeof handle[method] !== 'function') {
            throw new Error(`Missing owned worker ${method} operation.`);
          }
          await handle[method]();
        } catch (error) {
          errors.push(error);
          cleanupFailed = true;
          uncertain = true;
        }
      }
      if (prepared && !cleanupFailed) {
        try {
          const observation = exact(await handle.observe(), ['identity', 'empty'], 'observation');
          const observed = captureDomain(observation.identity, owner);
          if (observation.empty !== true
            || Object.keys(domain).some(key => domain[key] !== observed[key])) {
            throw new Error('Owned worker extinction was not confirmed for the original domain.');
          }
        } catch (error) {
          errors.push(error);
          uncertain = true;
        }
      }
    }
    uncertain ||= errors.some(hasUnsettledWorker);
    if (!uncertain) {
      try { await write('settled'); }
      catch (error) { errors.push(error); }
    }
    if (!uncertain && handle) {
      try { await handle.retire(); }
      catch (error) { errors.push(error); uncertain = true; }
    }
    if (uncertain) {
      try { await write('blocked'); }
      catch (error) { errors.push(error); }
      throw Object.assign(new Error(
        'Owned worker settlement is uncertain; retain lock and backup. Do not restore or restart.',
        { cause: failureCause(errors) },
      ), { code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false });
    }
    if (errors.length) throw failureCause(errors);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
```

The detailed contracts, exact phases, identity schemas, cleanup order and
return/error behavior above are authoritative; the implementation is kept in
one focused file. Do not add service activation, command parsing, disk storage,
timer policy or recovery lock reclamation here.

- [x] **Step 4: Push implementation and require green on both platforms.**

```bash
git add scripts/deployment/owned-worker.mjs
git commit -m "feat: coordinate owned worker admission and settlement" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

- [x] **Step 5: Record accepted code/run and carry native integration forward.**

N2 cannot unblock existing deployment state, release a lock, or establish OS
ownership itself. Durable storage/private engine, concrete platform transport,
original-handle/cgroup observations, crash reentry and all eight real-process
groups remain required before public script integration.

### N2 acceptance checkpoint

- Initial red: `6a8380a`, Actions `36310712294`, missing coordinator module on
  both platforms. Initial implementation `37341b0`, Actions `36310787103`:
  Linux 118 pass; Windows 117 pass plus one existing Linux-only skip.
- Evidence-retirement refinement red: `f6ac359`, Actions `36310861206`.
  Both platforms fail exactly the two retirement contracts: omission of
  post-receipt retirement and incorrectly successful retirement failure.
- Accepted implementation: `18501ce19550d6c971762f3a7385c50b75f9f887`,
  Actions `36310901780`: Linux 123 pass; Windows 122 pass plus one existing
  Linux-only skip. Zero failures.
- The 22 new coordinator contracts cover both identity schemas, frozen
  receipts, cancellation at admission/settlement boundaries, original error
  retention, cleanup failures, foreign/replaced identity, receipt failures,
  ambiguous preparation, nested unsafe failures, invalid handles, native
  evidence retirement, delayed controller join and late preparation after
  the real stage runner's settlement allowance expires.
- The late-prepare regression confirms the target is never granted even when
  preparation eventually returns after the enclosing stage already rejected
  as unsafe. A late worker-only settlement receipt does not revise the
  enclosing deployment's blocked state or release its lock.
- These tests use injected native adapters. They prove coordinator ordering,
  not actual OS containment, filesystem durability or crash recovery.
  `record` remains an injected durable-writer contract; no receipt store,
  systemd unit or Windows Job has been created by this batch.
- All validation ran in Actions. Only the feature branch changed. Main,
  public deploy/update/restore entrypoints and the live installation remain
  untouched.

### Next native boundary after N2

Keep the next implementation separate from this coordinator. Before native
code is written, specify and implement the private saved-engine location and
versioned receipt store, then the bootstrap transport and platform interop.
The store must reject stale/concurrent writers and preserve intent after
partial creation; coordinator callbacks alone do not supply those guarantees.
Adapter cancellation/close/stop/join operations must be idempotent, cannot
reopen command admission and must not reuse the aborted grant signal as a
reason to skip native cleanup. Retire must release the original retained
handle/evidence, never recreate a same-name domain.

The concrete native interop/transport plan is still outstanding. No new
interop package or external native dependency has been selected. All eight
real-process acceptance groups in the approved spec remain open, followed by
the full application deployment/update/restore acceptance and main PR.

## N3: External append-only worker receipt store

This batch provides actual filesystem persistence for N2's `record` callback.
It is not a recovery-authority implementation or a saved-engine installer.
Continue inline, validate only in Actions, and keep public entrypoints gated.

**Files**

- Extract the existing `captureOwner` and `captureDomain` implementations into
  `scripts/deployment/worker-identity.mjs` as named exports; the coordinator
  imports them unchanged. Storage and execution must share one identity schema.
- Create `scripts/deployment/worker-journal.mjs`: exclusive creation, validated
  bounded receipt append/read, explicit close and retained incomplete files.
- Create `tests/deployment-worker-journal.test.mjs`: real filesystem and
  coordinator integration; add it to the existing two-platform workflow.

**Contract and storage layout**

`createWorkerJournal(root, owner)` returns `{ record, close }`.
`readWorkerJournal(root, owner)` returns the validated receipt array.
The caller provisions a private external control directory and holds the
deployment lock. Both paths must be canonical; the directory must be disjoint
from the project (not equal, inside it, or an ancestor). Linux additionally
requires current-user ownership and no group/other access. Windows ACL
provisioning/verification remains a required native preflight, not a guarantee
of POSIX mode bits. Do not expose this module in public commands yet.

Each worker uses exactly `worker-<workerId>.ndjson`, created with `wx+` and mode
0600. Existing files, including empty or partial ones, are never opened for
writing, replaced, truncated, deleted or automatically reclaimed. Exclusive
creation arbitrates concurrent creators; the captured handle is the sole
writer. No stale-writer reopen API exists. Worker IDs come from the caller's
fresh UUID generation. One operation's records cannot be reused by another.

The journal has at most five newline-terminated JSON receipts and 128 KiB.
Validate exact `version`, `owner`, `phase`, `domain` keys, version 1, the shared
identity schema, fixed owner, unchanged admitted domain and these transitions:

```js
const transitions = {
  intent: ['owned', 'settled', 'blocked'],
  owned: ['admitted', 'settled', 'blocked'],
  admitted: ['settled', 'blocked'],
  settled: ['blocked'],
  blocked: [],
};
```

Initial receipt must be intent with null domain. Owned/admitted require a
domain; intent-to-settled/blocked may discover one after preparation. A known
domain cannot disappear or change. Settled-to-blocked records a retirement
failure. No record accepts arbitrary errors, environment or command fields.

Serialize and snapshot receipts synchronously before awaiting I/O. Reject a
second concurrent append rather than queueing stale requests. Validate the
expected full prefix against the retained handle and named regular file
(including inode/device and link count) before each append. Reject replaced
root/file identity, missing file or externally changed bytes. Append then
`FileHandle.sync`; Linux also synchronizes the new directory entry before
returning a writer. On I/O failure poison the writer, retain the file, and
surface `DEPLOYMENT_WORKER_UNSETTLED`/`recoveryAllowed=false`. Close never
removes a journal or certifies process settlement.

Read-only inspection opens and reads a bounded regular file, rejects links,
empty/truncated/malformed/oversized histories and invalid transitions, and
returns immutable validated snapshots. It does not return a recovery
permission or clear deployment blocked state. Windows file flushing is tested;
power-loss durability of Windows directory entries is not claimed without
native support. Local-disk process-crash evidence is distinct from power-loss
acceptance, which remains a native integration requirement.

### Task N3

- [x] **Step 1: Write failing filesystem and coordinator contracts.**

```js
const journal = await createWorkerJournal(control, owner);
await journal.record({ version: 1, owner, phase: 'intent', domain: null });
await journal.close();
assert.equal((await readWorkerJournal(control, owner))[0].phase, 'intent');
await assert.rejects(createWorkerJournal(control, owner), /journal|exists/i);
```

Exercise full N2 execution with this real writer and both domain schemas;
aborted intent/owned paths; ambiguous prepare; frozen returned data; duplicate
creator races; simultaneous/stale appends; partial tail; external modification;
schema/owner/domain substitution; invalid transitions; root inside checkout;
symlinks and hardlinks; close before/after failure. Linux mode and owner checks
are Linux-only, while creation/read/write/flush contracts run on both OSes.

- [x] **Step 2: Commit/push tests and capture missing-module red.**

```bash
git add tests/deployment-worker-journal.test.mjs .github/workflows/deployment-lifecycle.yml docs/superpowers/plans/2026-09-27-cross-platform-deployment-backup.md
git commit -m "test: define persistent owned worker receipt contracts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

- [x] **Step 3: Extract shared identity validation and implement the journal.**

Use the exact storage/transition contract above; keep native process calls and
deployment state unlocking out of this module. Before committing, inspect the
new code and all uses of the identity exports for accidental behavior changes.

The accepted implementation is `scripts/deployment/worker-journal.mjs` at
`47bb0740528f6e3062619170a38eaa9e0c24215f`. The shared field/owner/domain
validators are in `scripts/deployment/worker-identity.mjs`; the existing
coordinator now imports them rather than defining a second schema.

Concrete coordinator wiring, executed by the integration contracts:

```js
const journal = await createWorkerJournal(control, owner);
const errors = [];
try {
  await runOwnedWorker({ owner }, {
    record: journal.record,
    async prepare() {
      throw new Error('Lost native creation reply');
    },
  });
} catch (error) { errors.push(error); }
try { await journal.close(); }
catch (error) { errors.push(error); }
if (errors.length === 1) throw errors[0];
if (errors.length > 1) throw new AggregateError(errors);
```

That example deliberately fails preparation and must leave an intent followed
by blocked, never erase the file or convert it to settlement. Real native
callbacks remain a separate implementation; the journal does not provide them.

- [x] **Step 4: Push and require all contract jobs green.**

```bash
git add scripts/deployment/worker-identity.mjs scripts/deployment/owned-worker.mjs scripts/deployment/worker-journal.mjs
git commit -m "feat: persist exclusive owned worker receipt journals" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

- [x] **Step 5: Record accepted revisions and native integration limitations.**

Keep all journal evidence until separately verified operation-level retirement;
this batch never deletes it. Bounded whole-operation metadata retirement,
Windows private ACL/directory durability, saved-engine installation, actual
cgroup/Job workers and verified reentry remain required before public release.

### N3 acceptance checkpoint

- Causal missing-module red: `8c511bf`, Actions `36311583099`, both platforms.
- Initial storage implementation: `afe6673`, Actions `36311638405`:
  Linux 140 pass; Windows 138 pass, two Linux-only skips.
- Independent-process acceptance: `25cbf6e`, Actions `36311694638`:
  Linux 144 pass; Windows 142 pass, two Linux-only skips. A real Node writer is
  killed after flushing intent; another process cannot reopen/reclaim it.
  Two independently spawned processes also race for the same journal, with
  exactly one successful writer.
- Physical write/flush faults: `da3d6d4`, Actions `36311741397` passed.
  Injected partial writes leave a rejected partial tail. Injected flush
  failure poisons the writer, prevents target admission through the actual
  coordinator and retains native evidence instead of retiring it.
- Encoding refinement red: `5aa668f`, Actions `36311768823`. Both platforms
  exposed UTF-8 replacement decoding silently changing a stored cgroup path.
  Strict fatal decoding now rejects those bytes without modifying them.
- Encoding fix: `f186f62`, Actions `36311827665`: Linux 147 pass; Windows
  145 pass, two Linux-only skips.
- Directory error preservation red: `343ecdf`, Actions `36311911595`. Linux
  exposed close failure replacing the earlier directory flush error. The
  correction retains both errors and leaves the incomplete journal intact.
- Final accepted code: `47bb0740528f6e3062619170a38eaa9e0c24215f`,
  Actions `36311978735`: Linux 148 pass; Windows 145 pass, three explicitly
  Linux-only skips; zero failures. N3 adds 25 tests to the prior 123.
- Limits: five receipts / 128 KiB per journal; immutable validated reads;
  captured-handle exclusive writer; no reopen/delete/reclaim path. Data
  flushing runs on both OSes; Linux also flushes creation's directory entry.
  Read-only inspection works even after the original checkout disappears.
- This is actual journal I/O and writer-process interruption evidence, not
  actual cgroup/Job containment or machine-power-loss evidence. Native private
  Windows ACL setup and directory-entry durability remain open. Nothing here
  grants recovery authority or changes deployment blocked state.
- All execution was in GitHub Actions; no local validation/server, main
  change, public deployment entrypoint change or live service mutation.

### Next boundary after N3

The storage writer is now implemented, but not yet invoked by public scripts.
Next implement the private external saved-engine installation and concrete
bootstrap/native transport plan; do not add an uncontained fallback to make
native tests pass. Native callback wrappers must aggregate journal-close
failure with any existing command/cleanup error, retain blocked authority and
not leak an open writer. Every native launch still requires canonical project
and live controller identity captured under the deployment lock.

Journal storage never cleans itself up. Whole-operation metadata retirement
must wait for separately verified worker settlement/operation completion and
must prevent unbounded journal accumulation across repeated updates. This
small metadata retention task is separate from the existing one-full-backup
constraint. Saved-engine code, native adapters, verified reentry and all eight
real-process/native lifecycle groups remain outstanding.

## N4: Saved worker engine and independent inspection

Continue inline. This is the worker engine, not yet the complete application
restore tool. Its purpose is to preserve the worker coordinator/receipt reader
outside the checkout and prove independent inspection after checkout removal.

**Files and responsibility**

- `scripts/deployment/worker-files.mjs`: shared private canonical directory,
  bounded regular-file I/O and checked flush/close helpers. Extract the private
  external-directory policy from `worker-journal.mjs`; retain existing tests.
- `scripts/deployment/saved-worker-engine.mjs`: fixed allowlist copy, bounded
  hash manifest, bundle verification and sanitized inspection invocation.
- `scripts/deployment/saved-worker-inspect.mjs`: read-only stdin owner input,
  verified dynamic loading of the journal reader, bounded JSON output.
- `tests/deployment-saved-worker.test.mjs`: actual external copies and Node
  invocation in Actions; add to the existing workflow.

### Storage and trust contract

`saveWorkerEngine({ source, control, project, operationId })`:

1. Validate canonical source and private external control directories, real
   project identity, and bounded operation ID. Caller holds the installation
   lock and supplies a trusted source tree admitted by source compatibility.
2. Exclusively create the single `worker-engine` directory at mode 0700.
   Existing complete OR incomplete directories reject without overwrite,
   deletion or timestamped replacement. No hard links to source files.
3. Copy only this exact built-in allowlist as newly created 0600 files, using
   at most 1 MiB per file and rejecting symlinks/hardlinks/nonregular files:

```js
const files = [
  'owned-worker.mjs', 'saved-worker-engine.mjs', 'saved-worker-inspect.mjs',
  'stage-runner.mjs', 'worker-errors.mjs', 'worker-files.mjs',
  'worker-identity.mjs', 'worker-journal.mjs',
];
```

4. Record each file's SHA-256 and size in canonical order. Re-read source files
   and compare before publishing completion, rejecting source mutation. Write
   `manifest.json` last with `{ version: 1, project, operationId, files }`,
   where `files` is an array of `{ name, bytes, sha256 }`. Flush files and, on
   Linux, directory entries. Do not claim Windows directory power-loss safety.
5. Return frozen `{ directory, entrypoint, manifestSha256 }`. The caller must
   persist the manifest digest in operation authority before any native launch.
   This batch does not extend the deployment state schema or claim that the
   digest has already been integrated there.

`verifyWorkerEngine({ control, project, operationId, manifestSha256 })`:
reject missing/partial bundle, unexpected directory entries, links, oversized
files, malformed/unsupported/extra manifest fields, wrong project/operation,
wrong externally supplied digest or any content mismatch. Manifest is capped
at 32 KiB. Source checkout need not still exist. Verify the complete allowlist
before dynamically importing a saved worker journal module. Never fetch or
repair missing files from the mutable checkout.

The private bootstrap/verifier and filesystem permissions are the trust base;
hashes detect corruption/replacement relative to the caller's pinned digest,
not an adversary able to rewrite the bootstrap and its authority. Windows
private ACL provisioning remains required before public native integration.
The system Node binary remains an external prerequisite: this bundle removes
dependency on project code/node_modules, not on the OS/runtime installation.

`workerInspectionInvocation(saved, owner)` returns an executable/argument/env
description plus stdin JSON, never a shell command. Use absolute
`process.execPath`, absolute saved entrypoint, control directory, pinned
manifest digest; remove case-insensitive NODE_OPTIONS and NODE_PATH from a
copy of the environment, without modifying the caller's environment. It does
not spawn any process itself. Native mutating targets cannot use this
read-only entrypoint as a containment bypass.

The saved entry accepts exactly two positional arguments (control and digest)
and a bounded 32 KiB owner JSON document on stdin. After whole-bundle
verification it dynamically imports the saved reader and emits exactly:

```json
{"status":"inspection-only","phase":"intent","recoveryAuthorized":false}
```

The phase comes from the last validated receipt; no automatic unlock, restore,
restart, receipt append or deletion. On error emit a fixed bounded diagnostic
on stderr, no success JSON, exit nonzero. No raw owner input, env or causes
are dumped. Verify and invocation are internal APIs, not public deploy CLI
options or a statement that native domain extinction has been established.

### Task N4

- [x] **Step 1: Write failing copy/verification/execution contracts.**

```js
const saved = await saveWorkerEngine({ source, control, project, operationId });
await rename(project, `${project}-removed`);
const command = workerInspectionInvocation(saved, owner);
const child = spawn(command.file, command.args, {
  env: command.env, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.end(command.input);
```

Assert zero exit and exact inspection-only JSON after checkout removal. Also
test: source mutation after save cannot alter the bundle; partial/duplicate/
concurrent save; wrong identity/digest; same-size tampering; extra files;
corrupt manifest and source links; saved reader must not execute before
verification; bounded stdin/output; preload env removal; copied module
dependency closure imports without node_modules; Linux private modes.

- [x] **Step 2: Push tests/workflow/plan and obtain Actions causal red.**

```bash
git add tests/deployment-saved-worker.test.mjs .github/workflows/deployment-lifecycle.yml docs/superpowers/plans/2026-09-27-cross-platform-deployment-backup.md
git commit -m "test: define independently saved worker engine contracts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

- [x] **Step 3: Implement shared file boundaries, bundle and inspector.**

Keep the saved allowlist closed; all its imports must be Node builtins or
members of that list. Reuse the journal's directory/ownership checks through
the shared helper and retain cause aggregation on I/O and close failures.
Only the journal reader is dynamically imported by the inspector after
verification. No npm install, network call or target process is admitted here.

The complete accepted implementation is pinned at
`c676fe071ddb8108caebb463d5546cacceca3831` in the four files listed above.
The shared file module provides `canonicalWorkerDirectory`,
`externalWorkerDirectory`, `requirePrivateMode`, `closeWorkerFile`,
`syncWorkerDirectory`, `writeWorkerFile` and `readWorkerFile`. The journal now
uses the same external-directory and flush/close policy rather than a copy.

Concrete inspection wiring (after provisioning private control and capturing
the source/project/operation authority):

```js
const saved = await saveWorkerEngine({ source, control, project, operationId });
await verifyWorkerEngine({
  control, project, operationId, manifestSha256: saved.manifestSha256,
});
const invocation = workerInspectionInvocation(saved, owner);
const child = spawn(invocation.file, invocation.args, {
  env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.end(invocation.input);
```

Production callers still need bounded process execution, pinned digest
persistence and aggregate-close handling; tests supply bounded execFile
execution. This example is not a public update/recovery entrypoint.

- [x] **Step 4: Push implementation and require both OS jobs green.**

```bash
git add scripts/deployment/worker-files.mjs scripts/deployment/worker-journal.mjs scripts/deployment/saved-worker-engine.mjs scripts/deployment/saved-worker-inspect.mjs
git commit -m "feat: preserve and verify external worker engine copies" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

- [x] **Step 5: Save results and retain integration gates.**

Fixed-slot operation-level retirement, pinned-digest persistence in deployment
authority, Windows private ACL/directory durability, native bootstrap transport
and cgroup/Job adapters remain required. N4 must not delete an engine still
referenced by an active/interrupted operation, invent a resume path or claim
full restore capability.

### N4 acceptance checkpoint

- Missing-module red: `ff9f157`, Actions `36314179132`, both platforms.
- Initial implementation: `aac693a`, Actions `36314326168`: Linux 163 pass;
  Windows 159 pass, four explicitly Linux-only skips.
- Interruption/canonical-identity contracts: `c547c30`, Actions
  `36314376736`. Exactly the noncanonical project identity contract fails on
  both platforms; source mutation, copy flush failure, oversize source and
  substituted entrypoint contracts pass.
- Accepted code: `c676fe071ddb8108caebb463d5546cacceca3831`,
  Actions `36314436745`: Linux 168 pass; Windows 164 pass, four Linux-only
  skips; zero failures. N4 adds 20 contracts to the prior 148.
- Real Actions subprocesses execute the saved inspector after the fixture
  checkout has been renamed away, without using its node_modules or modules.
  Another subprocess imports the complete saved library dependency closure.
  Inspection returns only `inspection-only`, the recorded phase and
  `recoveryAuthorized: false`, with no receipt or control-directory mutation.
- Whole-allowlist verification rejects same-size corruption, wrong manifest
  digest/operation/project, unknown files, malformed/unsupported manifests,
  source links, oversized files and changes during copying. Corrupted saved
  journal code is not dynamically executed. Node preload variables are
  removed case-insensitively from a copied invocation environment.
- A single fixed worker-engine slot is exclusively created; concurrent,
  duplicate and failed saves cannot overwrite it or allocate extra slots.
  Partial copies and failed flushes retain evidence. No cleanup/replacement
  or automatic recovery path was introduced.
- The verifier/entrypoint/shared bootstrap modules and private filesystem
  permissions remain the trust base; the bundle is not a defense against
  privileged rewriting of that trust base. System Node remains required.
- Only the feature branch changed. All validation ran in GitHub Actions;
  main, public deployment scripts and the live installation remain untouched.

### Next boundary after N4

The saved engine and journal foundations are now implemented. Next specify
and implement the actual native bootstrap transport/platform interop, rather
than adding another general-purpose storage abstraction. Linux needs the
unique transient system-service cgroup plus captured boot/invocation/group
identity, gated execution and exact-domain extinction observation. Windows
needs its explicit retained kill-on-close Job and trusted gated launcher.
Neither exists yet; no containment claim follows from saved helper tests.

Integrate the pinned manifest digest and helper lifetime with operation
authority before native execution. The fixed slot deliberately rejects reuse
today: verified operation-level retirement must precede subsequent updates,
without deleting helpers/journals referenced by unfinished workers. Windows
ACL provisioning and directory-entry power-loss durability remain open.
All eight native process acceptance groups, full historical deploy/update/
restore acceptance, README/public wrappers and the main-targeted PR remain
outstanding.

### N5 Linux gated adapter implementation batch

**Retirement correction from actual adapter execution:** the initial probe saw
only the short populated=0 interval. Adapter run `36314966368` correctly blocked
on later ENODEV rather than silently treating it as empty. Extended probe
`c88cbae`, run `36315065300`, retains the original directory as well as events
descriptor and demonstrates `/proc/self/fd/<original-dir>` ending with the exact
original group path plus ` (deleted)`, with unchanged boot/unit InvocationID.

Linux v6.8 `kernel/cgroup/cgroup.c:cgroup_destroy_locked` refuses populated
groups or online children, then marks the group dead to prevent migration and
child creation before kernfs removal. Therefore accept ENODEV only with the
original retained directory's exact deleted link and matching original manager/
boot identity, on a verified cgroup-v2 filesystem. Missing paths, unexpected
read errors and arbitrary deleted descriptors remain errors. This does not
claim to contain privileged target migration out of the group (already excluded).
Source: https://github.com/torvalds/linux/blob/v6.8/kernel/cgroup/cgroup.c .
Directory nlink is not a reliable deletion certificate for kernfs; do not use
it. `fs/kernfs/inode.c` recomputes directory nlink from subdirectory count.

Characterization `5406228`, Actions `36314620935`, succeeded. A retained
cgroup.events descriptor still returned `populated 0` after SIGKILL, while
systemd's failed unit retained its original InvocationID but exposed an empty
ControlGroup. Therefore use the retained descriptor, never reconstruct an
empty domain from a missing path. Unit/boot identity checks remain mandatory.

**Files**

- `scripts/deployment/worker-wire.mjs`: bounded single-line JSON socket
  messages, immutable exact target command snapshot, no shell encoding.
- `scripts/deployment/linux-worker-bootstrap.mjs`: trusted saved Node process
  inside the transient service. Connect to a private Unix socket, authenticate
  a one-use token, acknowledge PID/start/group membership, wait for one command
  grant, drain bounded output, keep the domain alive after root exit and
  observe the original controller lifetime. Transport loss exits nonzero so
  systemd kills the group. No target imports/preloads before admission.
- `scripts/deployment/linux-worker.mjs`: saved-bundle verification, preflight,
  socket owner, transient service creation, exact-domain identity, retained
  events descriptor and implementation of N2's handle contract.
- Extend saved-engine allowlist with the three files and process-identity.mjs.
  Update the saved-engine dependency-closure contract rather than silently
  relying on checkout modules.
- `tests/deployment-linux-worker.test.mjs`: real root-capable isolated Actions
  runner tests, independent of the cross-platform contract job.

**Native protocol and admission**

The controller verifies Linux/root/systemd/cgroup-v2 and its live process
identity. This first internal adapter requires explicitly requested uid=0 and
gid=0, and rejects other or implicit accounts. It is not wired to public
deployment and must not silently replace the deployment's intended account.
Non-root account support/private transport ACLs remain a later native gate.

Create a Unix socket inside the already private external control directory;
reject a path exceeding Linux's sockaddr_un limit before native creation.
Invoke systemd-run with absolute saved bootstrap and Node paths, Type=exec,
RemainAfterExit=yes, Restart=no, KillMode=control-group, SendSIGKILL=yes,
finite start/stop/runtime limits, and cleared Node bootstrap preloads.
Only bootstrap identity/token/controller PID information travels in argv;
target cwd/argv/env travels as a bounded socket frame after durable admission.
The parent retains the single socket and the exact cgroup.events handle.

```js
const ready = {
  type: 'ready', token, pid: process.pid,
  processIdentity: await processIdentity(process.pid), controlGroup,
};
const grant = { type: 'run', command: { file, args, cwd, env } };
const result = { type: 'result', exitCode, signal, stdout, stderr };
```

Frames are at most 128 KiB, commands at most 64 KiB, stdout/stderr retain
8 KiB tails each while continuing to drain. Validate frame type/shape, token,
MainPID, PID start identity, boot ID, full ControlGroup and InvocationID before
returning the handle. `run` checks its signal and permanently closed admission
immediately before writing its sole grant. Bootstrap rejects duplicate grants.
It checks controller start identity periodically; missing/reused controller or
disconnection prevents further grants and exits, independent of CLI finally.

Close admission destroys transport, preventing late commands. Stop validates
the original boot/unit invocation then targets only that UUID unit. Join
polls the retained descriptor under a finite allowance until populated=0.
Observe rechecks original boot/unit identity and retained populated state.
Retire is allowed only after N2 persisted settlement; close native observation
and reset only the matching empty failed unit. An unreadable descriptor,
replaced identity, failed query/kill or ambiguous partial creation is unsafe.
Never use process-name/port matching or missing cgroup path as extinction.

### N5 execution

- [x] Add/execute bounded native characterization in Actions.
- [x] Push real adapter contracts; collect missing-module red.
- [x] Implement the three modules and extend the saved allowlist.
- [x] Push and iterate against real Linux worker tests plus both OS contract
  jobs; capture exact accepted revision and failure causes.
- [x] Record the implementation limits. This batch cannot claim Windows Job,
  crash-reentry authorization, non-root account support, whole-operation helper
  retirement, OOM immunity or full application deployment acceptance.

Use the established feature-branch commit/push and
`gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion`
sequence. Native tests run only as
`sudo "$(command -v node)" --test tests/deployment-linux-worker.test.mjs`
inside the Actions job. Local native experiments remain prohibited.

## N5 native Linux boundary: first establish actual retirement semantics

Before selecting the Linux retirement proof, run the bounded
`tests/deployment-linux-domain-probe.mjs` in an explicit Ubuntu Actions job as
root. It creates one UUID-named transient system service running only the
trusted `/usr/bin/sleep`, with Type=exec, RemainAfterExit, no restart,
control-group kill and finite start/stop/runtime limits. It retains the exact
`cgroup.events` descriptor, observes populated=1, kills the owned service group
and records subsequent descriptor/manager observations. It targets no existing
service and always attempts cleanup of only its generated unit name.

This characterization is needed to avoid an invented successful fallback:
if a retained descriptor becomes unreadable when the group disappears, that
alone is not an empty-domain certificate. The production adapter and its exact
native acceptance contracts must reflect the observed semantics. The probe
is a test fixture, not a production implementation or zero-risk claim.

Run exclusively via the `linux-native` job in deployment-lifecycle.yml.
Capture its bounded JSON and Actions revision; do not run systemd experiments
on the user's host. Shared Linux/Windows contracts still run independently.

### N5 initial Linux native acceptance checkpoint

- Original characterization: `5406228`, Actions `36314620935`, all jobs pass.
- Missing-adapter red: `dbaa14e`, Actions `36314779931`, native job fails only
  because `linux-worker.mjs` does not exist; shared contracts remain green.
- First native implementation: `6d53c77`, Actions `36314966368`; shared jobs
  pass, native execution blocks on ENODEV after cgroup removal. No unsafe
  recovery or success-shaped missing-path fallback was introduced.
- Extended original-directory characterization: `c88cbae`, Actions
  `36315065300`, proves exact original-directory deleted linkage after
  cgroup.events transitions from populated=0 to ENODEV. Adapter remains red.
- Kernel-backed retirement correction: `411f358`, Actions `36315120078`,
  all jobs pass, eight real native tests.
- Crash/deadline/literal-path expansion: `3e0ef21`, Actions `36315222617`,
  all jobs pass. Tests kill a real native bootstrap and a separate real CLI
  controller, exercise actual runStage timeout, and use literal `%n`/`$HOME`
  in saved bootstrap/socket paths. systemd-run preserves these tested paths;
  no manual shell escaping or guessed systemd specifier rewrite was added.
- Output/protocol regressions: `cb05e2b`, Actions `36315314180`; the new
  binary output regression was initially nested in another test and exposed
  the same decoded-tail limit defect. Corrected top-level registration
  `ef6704d`, Actions `36315377362`, fails exactly that one native test.
  Shared socket contracts pass on both OSes.
- Output correction: `e2d0272`, Actions `36315441109`, all jobs pass. Binary
  replacement decoding can expand output beyond the retained raw 8 KiB;
  returned text is now bounded again at valid UTF-8 character boundaries.
- Final accepted test/code revision:
  `39240d338269ee7f9a98dec7c1d39109e8a5ce24`, Actions `36315471793`:
  **14 actual Linux systemd worker tests pass**, Linux shared contracts
  **174 pass**, Windows shared contracts **170 pass + four Linux-only skips**.
  Final test also refuses an existing same-name sentinel unit while preserving
  its original MainPID, InvocationID and active state.

The implementation consists of `worker-wire.mjs`, `linux-worker-bootstrap.mjs`
and `linux-worker.mjs`; the saved-engine allowlist also includes
`process-identity.mjs`. `tests/deployment-linux-worker.test.mjs` executes the
actual coordinator, actual flushed journal, actual saved engine and actual
transient system service. `tests/deployment-linux-controller-child.mjs` is
only the test fixture for killing the independent CLI owner.

Accepted native coverage includes:

- Exact command argument/environment transport without a shell; successful
  and nonzero exit; large independent stdout/stderr and binary output.
- Root exiting while a detached/session-changing child continues writing,
  cancelled SIGTERM-ignoring target, cancellation after readiness before grant,
  stage deadline and mutable caller command input.
- Bootstrap death stops target writers; CLI death closes transport and causes
  the manager to stop writers. CLI-death journal remains admitted, not settled
  or automatically reclaimed; the test confirms another journal writer cannot
  reopen it. This is containment-after-owner-death evidence, not reentry
  authorization.
- Original boot/unit/invocation/full-group identity, original retained events
  and directory handles, explicit closure of admission, native kill and
  bounded joining before empty-domain observation/receipt/retirement.
- Shared wire contracts for fragmented exact text, invalid/oversized/invalid
  UTF-8 messages, cancellation, timeout, concurrent reads and transport loss.

### Remaining native work after the first Linux batch

This adapter is internal and deliberately supports only explicitly requested
uid=0/gid=0. It is NOT wired to deploy/update/restore. Intended non-root runtime
accounts, private bootstrap transport access for those accounts, required
platform feature admission and application/watchdog ownership remain open.
Never broaden authority to root merely to use this initial adapter.

Windows explicit retained Job implementation is still absent. Next complete
its concrete interop/gated-launcher transport plan and real native adapter;
shared Windows contract success is not Windows process-containment evidence.

Do not claim all eight approved acceptance groups are complete. Still needed:
original-domain reconciliation under exclusive recovery authority; controller
kill at every durable boundary; changed/reused invocation and access-denied/
query/kill failure injections; revoked/late transport cases; finite watchdog
expiry under abandoned controller; intended runtime identities; actual npm/
Git/Next workload execution. Helpers/journals remain in their fixed slots;
pinned-digest authority integration and safe operation-level retirement are
not implemented. Windows ACL/directory-entry power-loss semantics remain
open. No host-wide OOM experiment was run or promised.

Only the feature branch changed, with all validation in GitHub Actions.
Main, existing public deployment scripts and live installation are unchanged.
Full historical deployment/update/restore acceptance, user README and the
main-targeted PR remain blocked on completing the preceding native work.

## N6: Explicit Windows Job primitive and gated native launcher

Continue inline. Use Windows PowerShell 7 (`pwsh`) and the installed .NET
runtime's `Add-Type` for a small checked C# Win32 boundary, avoiding an npm
native binding that `npm ci` could remove. The compiler/platform requirement
must become pre-downtime admission before public integration. No fallback to
taskkill or an uncontained target is permitted.

**Files**

- `scripts/deployment/WindowsWorkerJob.cs`: checked 64-bit Win32 Job interop,
  current-account private security descriptor, original retained handle,
  identity metadata, bounded enumeration and termination.
- `scripts/deployment/windows-worker-launcher.ps1`: trusted bootstrap which
  compiles the sibling interop source, validates its live original owner,
  joins the configured named Job, closes its temporary Job handle, reports
  readiness and only then reads a single bounded target grant from stdin.
- `tests/deployment-windows-job.ps1`: actual native tests in windows-2022.
- `tests/deployment-windows-job-owner.ps1`: isolated owner process used to
  exercise automatic kill-on-close after owner termination.
- `.github/workflows/deployment-lifecycle.yml`: separate Windows native job.

The primitive is not yet the Node coordinator adapter. Test helpers copy the
interop/launcher into private temporary directories to avoid reliance on the
checkout after launch. Production saved-engine allowlist/manifest wiring and
Node transport follow only after this native boundary is verified.

### Native API

`WindowsWorkerJob.Create(Guid generation)` uses
`Local\\agents-deploy-<generation>`; reject `ERROR_ALREADY_EXISTS` immediately
without changing the existing Job. Explicit protected DACL permits current
account SID and LocalSystem only. SECURITY_ATTRIBUTES disables inheritance.
Set KILL_ON_JOB_CLOSE before any launcher can join, with no breakaway flags;
query the flags and handle inheritance back before acknowledging creation.
Expose Name, AccountSid, SessionId, Generation and OwnerIdentity (PID/start
ticks) as captured identity, never use just the name as recovery authority.

Use `CreateJobObjectW`, `SetInformationJobObject`,
`QueryInformationJobObject`, `AssignProcessToJobObject`,
`OpenJobObjectW`, `TerminateJobObject`, `IsProcessInJob`,
`GetHandleInformation`, `CloseHandle`, SDDL conversion and LocalFree.
Validate x64/arm64 structure size/offsets at initialization (144-byte extended
limits, 64-byte basic limits); unsupported pointer size rejects.

`JoinCurrent(name)` opens only an existing Job with assignment/query rights,
verifies required limits, assigns the bootstrap itself, checks membership,
and explicitly closes the temporary handle before returning. No actual target
code or inherited Node preload executes before this point.

`Members()` queries only the original retained handle with a maximum 4096
process-ID buffer. Reject native errors, ERROR_MORE_DATA, assigned/list count
mismatch, invalid/duplicate IDs or impossible lengths. Never query a newly
created same-name object. `Terminate()` requests termination; callers must
still poll `Members()` until zero and join the launcher. `Dispose()` explicitly
closes the original non-inherited handle; OS last-handle cleanup is the owner
death safety net, not a substitute for the ordinary settlement receipt.

### Gated launcher

Launch `pwsh -NoProfile -NonInteractive -File <private-launcher>` through
ProcessStartInfo.ArgumentList with UseShellExecute=false. No command target in
argv. The launcher verifies parent PID/start identity, joins the exact Job and
closes its temporary handle before emitting one JSON ready frame. Target grant
is read only after readiness and contains exact executable, argv, cwd and env.
Use .NET ProcessStartInfo.ArgumentList and an explicitly replaced environment,
not cmd.exe, PowerShell evaluation or argument concatenation. Reject duplicate
or oversized input, NULs and malformed command shapes. Owner/control-pipe loss
must not leave a pre-admission launcher able to spawn later.

Native tests use controlled long-lived writing Node targets and their detached
descendants. Test assignment precedes target creation, cancellation before
grant, nested Job compatibility, explicit termination/query, root exits while
descendant survives, killed launcher, killed original owner, same-name collision
noninterference, and independent sentinel preservation. Poll boundedly; no
process-name/port killing and no broad OOM experiment. The native owner handle
must remain outside the Job, and the launcher must not keep an extra handle.

### N6 execution

- [x] Write and push actual Windows tests; collect missing-interop/launcher red.
- [x] Implement checked C# boundary and gated launcher.
- [x] Run native Windows acceptance and all existing Linux/Windows jobs.
- [x] Record accepted revision, actual results and the remaining Node adapter,
  saved manifest, durable receipt, account/session, ACL and recovery gates.

The implementation itself belongs in the files above, with exact executable
test fixtures. Run only in Actions:
`pwsh -NoProfile -File tests/deployment-windows-job.ps1`.
Native Windows success does not imply physical Windows installation acceptance
or complete deployment/restore support.

### N6 Windows native primitive acceptance checkpoint

- Missing-interop red: `8e5bcd6`, Actions `36315732290`. Windows native job
  fails at Add-Type because `WindowsWorkerJob.cs` is absent.
- Initial implementation: `36a5a51`, Actions `36316117901`. The real Job
  configuration/collision case passes, but launcher parsing fails on a
  PowerShell multiline boolean expression. No target was admitted.
- Launcher continuation correction: `deaeadd`, Actions `36316181862`: all
  jobs green, five native Windows cases pass.
- DACL/owner-death expansion: `d3183b1`, Actions `36316233338`, causal red for
  missing SecurityDescriptor readback. `a2f4a3a`, Actions `36316303764`, then
  exposes an incorrectly nested C# property; `02a64bf`, Actions `36316381214`,
  corrects that declaration and passes all jobs, eight Windows native cases.
- Launcher-death/sentinel/oversize cases: `177a0e9`, Actions `36316445268`,
  all jobs green, ten Windows native cases.
- Inherited-output regression: `c90d334`, Actions `36316517548`, all jobs
  green, eleven Windows native cases. Contrary to the suspected pipe lifetime
  defect, real descendants continue writing inherited stdout after the root
  exits under the current implementation; no speculative pipe rewrite was
  made.
- Final accepted revision: `ccde303dae2f82536686963876d482cf42121bae`,
  Actions `36316611256`, all four jobs succeed:
  **13 actual Windows Job cases**, **14 actual Linux systemd tests**,
  **174 Linux shared contracts**, **170 Windows shared contracts with four
  explicitly Linux-only skips**.
- Final refinement changes bounded grant input accounting from repeated
  whole-string UTF-8 encoding to incremental linear accounting and preserves
  both native creation/security-descriptor cleanup failures. It also covers
  control-pipe loss before grant and invalid generation/missing original Job/
  reused owner identity rejection.

`WindowsWorkerJob.cs` owns a non-inheritable original Job handle, configures
only KILL_ON_JOB_CLOSE, rejects ERROR_ALREADY_EXISTS before modifying limits,
and verifies assignment/query/termination/close results. The protected DACL
is read back from the original object and checked in Actions for only current
account and LocalSystem allow entries. The implementation validates the
64-bit native structure sizes and caps process enumeration at 4096 with
truncation/count/invalid-PID checks. It never reconstructs an empty same-name
Job to prove extinction.

`windows-worker-launcher.ps1` uses PowerShell 7 and sibling C# source. It
checks the original owner PID/start identity, joins the Job itself, closes
its temporary Job handle, acknowledges readiness, then accepts one bounded
target grant. Exact target argv and environment use .NET ArgumentList and an
explicit replacement environment, not cmd.exe or PowerShell evaluation.
An independent owner-lifetime timer exits on lost/reused owner identity.
Output tails are drained and retained at 8 KiB per stream, emitted as base64.

Tests use private temporary copies of the interop source and launcher. They
exercise actual nested assignment under the hosted runner's environment,
detached descendants after root exit, explicit termination followed by empty
original-Job observation, original owner-handle close, abrupt owner process
termination without finally, independent stdout/stderr, malformed/oversized
grants, launcher death while target writers remain, inherited output after
root exit, and an unrelated live sentinel unaffected by Job termination.
They join launchers and poll boundedly instead of using process-name kills.

### Remaining Windows integration after N6

This is native primitive acceptance, NOT the Windows equivalent of the Linux
coordinator integration. There is no Node `prepareWindowsWorker` adapter yet.
The C#/PowerShell files are not in the production saved-engine allowlist;
test copying is not production manifest verification. No Windows Job identity
has yet flowed through `runOwnedWorker` and the durable journal in these tests.

Next define the explicit native owner process outside the Job and its bounded
Node command/reply transport. That owner must retain the original handle until
the coordinator durably records settlement, expose generation/account/session/
owner identity, and implement closeAdmission/stop/join/observe/retire without
conflating root exit, pipe EOF or successful termination requests with
extinction. The Node controller's death must terminate this native owner (or
otherwise explicitly terminate its original Job); last-handle kill alone is
not sufficient if the owner helper itself remains alive. No target command
may be granted before the shared coordinator has persisted admission.

Required remaining work includes startup feature checks for pwsh/.NET/native
ABI; saved-engine hash and ACL verification; stale/foreign/cross-session
authority rejection; cancellation and timeout throughout preparation and
execution; duplicate/late reply handling; original Job query/termination/
assignment failure injection; truncated enumeration; partial creation and
owner kill at every durable boundary; exclusive verified recovery reentry.
The current-account native tests do not establish arbitrary runtime-account
switching or physical Windows installation support. ARM64 structure checks
are present but only hosted Windows x64 execution has been observed.

The full approved eight-group native matrix remains open. Linux non-root
account support, shared operation authority/digest persistence and fixed-slot
retirement, complete historical deploy/update/restore lifecycle acceptance,
public scripts/README and main PR also remain outstanding. No local tests,
builds or native experiments were run; only the feature branch changed.
Main and the live installation are untouched.

## N7: Windows original-handle owner and Node coordinator adapter

Continue inline. Extend the accepted primitive rather than creating another
Job implementation. Files:

- `windows-worker-owner.ps1`: saved native owner outside the Job, original
  handle retained through settlement, bounded ID-correlated RPC, startup ACL/
  account/session checks, launcher orchestration and independent Node lifetime
  supervision.
- `windows-worker.mjs`: `prepareWindowsWorker` verifies saved bundle/controller
  identity, captures immutable command, starts explicit absolute pwsh, validates
  ready identity and implements the six coordinator callbacks.
- `WindowsWorkerJob.cs`: bounded asynchronous frame read for the owner control
  loop and launcher replies, plus finite independent owner lifetime deadline.
- Saved-engine allowlist includes the C#/PowerShell native files and adapter.
- `tests/deployment-windows-worker.test.mjs` and an isolated Node controller
  fixture: actual coordinator/journal/saved-engine/native integration.

**Authority:** require an explicitly supplied absolute pwsh path, account SID
and session ID. No credential switching/automatic elevation. The helper checks
current account/session, private control/bundle ACLs and the live Node PID/start
identity before creating a Job. The Job's original owner is this native helper;
serialized domain `ownerIdentity` binds the Node operation controller, while
readiness separately reports the helper PID/start identity. Node verifies that
helper against its spawned child and never opens another named Job.

**Transport:** redirected stdin/stdout pipes with bounded newline JSON. Node
uses one receiver and correlates positive sequential request IDs. Responses
must match an outstanding request; malformed/unknown/duplicate responses
permanently invalidate transport. At most eight pending RPCs. A pending run
may overlap cleanup after cancellation, but late run replies cannot fulfill a
stop/join/observe request. No arbitrary executable instructions outside `run`.
Remove case-insensitive NODE_OPTIONS/NODE_PATH from copied bootstrap env.

```js
{ id: 1, method: 'run', command: { file, args, cwd, env } }
{ id: 1, type: 'reply', value: { exitCode: 0, stdout: '', stderr: '' } }
{ id: 2, method: 'closeAdmission' }
{ id: 2, type: 'reply', value: null }
```

The owner sends readiness only after the trusted launcher joined the configured
Job and closed its temporary handle. It forwards exactly one grant after
Node's durable admitted receipt. Its loop continues processing cleanup RPCs
while target execution is pending. `closeAdmission` irreversibly rejects future
run requests and closes launcher input. `stop` terminates the original Job.
`join` waits for launcher exit and exact original Job emptiness; `observe`
requires closed admission and completed join and returns the captured domain.
`retire` is accepted only after that sequence; dispose original handle, send
acknowledgement, exit. Node joins the helper before completing retirement.

On controller identity loss, pipe loss or native owner crash, owner process
exit closes the noninherited original handle and the OS kills the Job.
Independent 30-minute lifetime ceiling bounds a live-but-stalled Node owner.
Node records uncertainty on helper/transport loss: kill-on-close does not
magically produce a durable verified settlement receipt.
Cancellation of run rejects promptly but preserves correlation of its late
reply; native cleanup uses fresh requests rather than the aborted grant signal.
Partial preparation failure joins/kills only the actual spawned helper object,
then remains unsafe. It never recreates a Job or clears an existing journal.

**Tests and execution**

- [x] Push real Windows integration contracts and collect causal missing-module
  red in the windows-native job.
- [x] Implement helper/adapter and closed saved-bundle dependency set; add the
  bounded native frame reader without changing the existing primitive tests.
- [x] Run all four Actions jobs, diagnose bounded logs and require green.
- [x] Persist exact acceptance and outstanding account/reentry/fault gates.

Core test wiring:

```js
const saved = await saveWorkerEngine({ source, control, project, operationId: owner.operationId });
const journal = await createWorkerJournal(control, owner);
const result = await runOwnedWorker({ owner, signal }, {
  record: journal.record,
  prepare: context => prepareWindowsWorker({ ...context, saved, command, pwsh, accountSid, sessionId }),
});
```

Production wrappers still must aggregate close errors, hold installation
authority, persist the pinned digest and retire fixed slots safely. N7 does
not wire public deploy/update/restore or authorize interrupted reentry.

### N7 execution evidence

- Causal missing-adapter red: `fd8d4a1`, Actions `36317014836`.
- Initial owner/adapter: `af56bc7`, Actions `36317150588`. Shared contracts,
  Linux native and Windows primitive cases passed; Windows integration
  correctly refused the fixture's saved-file ownership before granting a
  command.
- Bounded startup diagnostics and owner lifecycle cases: `8465c2b`,
  Actions `36317266193`. The diagnostic identified the explicit private-owner
  check, rather than relaxing it based on a guessed runtime failure.
- Corrected fixture provisioning: `b0b202f`, Actions `36317398249`, all four
  jobs green, including **11 Windows coordinator integration cases**.
  Test setup explicitly assigns the intended account as saved-bundle/file
  owner; creating files under a protected directory alone did not establish
  that ownership on this hosted Windows runner. Production admission remains
  strict and does not repair or broaden ACLs automatically.
- Null-DACL characterization: `2fa2bf2`, Actions `36317504030`, all four
  jobs green, **12 Windows integration cases**. The test sets and reads back
  an actual null DACL. The existing ACL inspection rejects it, so no
  speculative permission-check rewrite was made.
- Final accepted revision: `13fdc6048fe29a084d7b16735786350931e5e014`,
  Actions `36317668488`, all four jobs green: **13 Windows coordinator
  integration cases**, **13 Windows native primitive cases**, **14 Linux
  native tests**, **174 Linux shared contracts**, **170 Windows shared
  contracts with four Linux-only skips**. This includes the real
  stage-deadline case.

The saved bundle now includes the Windows adapter, native owner, trusted
launcher and C# interop. `prepareWindowsWorker` requires an explicit absolute
pwsh executable, current account SID and session ID. The native helper is
outside the Job, owns the original noninherited handle and watches the Node
controller PID/start identity. A separate contained launcher must acknowledge
membership before readiness. The domain receipt binds the Node controller;
readiness separately verifies the actual helper PID/start identity.

Requests use one bounded receive dispatcher and sequential correlated IDs.
Run cancellation does not reuse its reply for cleanup: closeAdmission, stop,
join and observe have independent replies. Invalid transport/replies close
admission and remain unsafe. The owner retains its original handle while the
coordinator persists settlement, then closes it during explicit retirement;
Node joins the helper before returning. Both native timers have an independent
30-minute ceiling. The asynchronous frame reader dispatches on the thread
pool because `Console.In.ReadAsync` may otherwise block synchronously and
prevent the owner loop from servicing cancellation or run completion.

Actual integration cases cover durable receipt ordering/identity, literal
argv/environment and immutable command capture, binary-safe bounded output
and nonzero exit, pre-grant and running cancellation, detached descendants
after root exit, explicit account/session/runtime rejection, Node controller
death with an unreclaimed admitted journal, native owner death with a blocked
receipt, retained owner identity through durable settlement, broad ACL and
null-DACL rejection. The stage-deadline case requires the real writer to have
started and to stop before the stage reports recoverable timeout.

### Remaining gates after N7

This is an internal current-account integration, not a production deployment
entry point or a claim of zero edge cases. Public Windows setup must provision
the intended control/bundle owner and ACLs explicitly; `saveWorkerEngine` does
not currently do that. Arbitrary credential switching and physical Windows/
ARM64 support have not been accepted. Native assignment/query/termination
fault injection, bounded enumeration failure, every durable kill boundary,
transport corruption/duplicate replies and exclusive interrupted reentry
still need the complete approved matrix.

Next prioritize operation-level authority/reentry and saved-engine digest
persistence/slot retirement, together with Linux intended non-root identity.
Only then wire public deploy/update/restore and the real historical
application lifecycle, backup/restore metadata, service/watchdog/ACP shutdown
and rollback acceptance on both platforms. No main PR, main push, merge or
live installation change is authorized by this intermediate acceptance.

## N8: Durable operation authority and worker enrollment

Continue the approved design inline; do not adopt dead owners or unblock state.
This batch binds the existing exclusive lock to the saved manifest and every
worker before native preparation. It deliberately does not delete metadata:
release is refused while native evidence exists, even after worker settlement.
Slot retirement and exclusive native recovery require separate acceptance.

Files:
- Extract the existing bounded append/prefix/inode/flush mechanics from
  `worker-journal.mjs` into `evidence-journal.mjs`; preserve all worker journal
  semantics and fault contracts.
- Add `worker-operation.mjs`: create an exclusive `worker-operation.ndjson`,
  immutable lock/manifest binding, sequential enrollment (maximum 32 workers),
  actual platform adapter selection, and a seal after exact inventory and
  settlement verification. No supplied native callback can authorize execution.
- Add `assertLockOwner` in `state.mjs`, reusing current process identity and
  strict bounded lock-file reading. Reject `releaseLock` while a saved engine,
  operation journal or worker journal remains.
- Include both new modules and `state.mjs` in the saved-engine dependency set.
- Add shared filesystem contracts and actual Linux/Windows operation-worker
  cases to the existing Actions jobs.

Execution order:
- [x] Push causal missing-module tests for lock/digest binding, immutable
  capture, competing creators, malformed evidence, no implicit unlock and
  zero-worker sealing.
- [x] Extract storage without changing existing receipt validation; implement
  the operation writer and native dispatch. One in-flight operation method,
  permanent close/seal, enrollment before worker journal/native creation.
- [x] Add real native command success, nonzero exit, repeated worker rejection,
  and operation seal checks on both platforms.
- [x] Require all Actions jobs green; record exact evidence and limitations.

```js
const operation = await createWorkerOperation({ control, lock, saved });
try {
  await operation.run({ workerId, command, runtime, signal });
  await operation.seal();
} finally {
  await operation.close();
}
const records = await readWorkerOperation(control);
// records.at(-1).phase === 'sealed' certifies workers, not app acceptance
// or authorization to remove the operation lock.
```

Each persisted record has exactly
`{version:1,phase,lock,manifestSha256,workerId}`. The first phase is `opened`
with null workerId, followed by distinct `enrolled` UUIDs and optionally one
terminal `sealed` with null workerId. Lock and digest cannot change between
records. Read-only inspection never treats process death or a missing worker
journal as settlement. Empty, truncated, replaced and poisoned evidence fails
closed without rewriting any record.

### N8 execution evidence

- Missing-authority-module red: `d05b3a8`, Actions `36318066728`.
- Initial implementation: `fdbdbe6`, Actions `36318217765`, all four jobs green.
  Reused the existing durable journal storage rather than introducing another
  append/flush implementation. Existing worker-journal write, partial-tail,
  directory-sync and nested-close fault contracts remain in the suite.
- Native pre-grant replacement red: `591a5a3`, Actions `36318362622`.
  Both actual native platforms showed that a byte-identical replacement of
  the operation journal after native readiness still allowed the target.
  Added retained-prefix/inode checks at every operation authority gate,
  including immediately before the target grant.
- Same-content lock replacement red: `c69fcf3`, Actions `36318493690`,
  reproduced on both platforms. Operation authority now pins the original
  lock file with a retained read handle and compares file and lock-directory
  identities, not only serialized token equality.
- First correction: `5da71c5`, Actions `36318623012`. Both shared jobs and
  Linux native passed; Windows assertions passed but the job hit its
  ten-minute limit because the intentionally blocked case retained its
  original owner/helper. This was not a successful overall acceptance.
- Retained lock handle, aggregated close-error coverage, and explicit
  blocked-fixture cleanup: accepted revision
  `fa4e05792fe5ede7d91f65089062c41af7a5f465`, Actions `36319283090`,
  all four jobs green: **190 Linux shared contracts**, **186 Windows shared
  contracts with four Linux-only skips**, **18 Linux native integration
  tests**, **17 Windows native integration tests**, plus the existing
  **13 Windows Job primitive cases**. Test cleanup captures the actual Windows owner
  PID/start identity before injecting the fault and terminates only that
  process afterward. Linux cleanup matches the recorded InvocationID before
  resetting the test unit. No production fallback or premature retirement
  was added to make the test finish.

`worker-operation.mjs` is the internal admission entry point. It binds the
current exclusive lock to a verified saved-engine digest, persists each unique
worker enrollment before creating its worker journal or native domain, and
dispatches directly to the real platform adapter. A caller cannot inject a
mock prepare callback as production authority. Immutable command/runtime
inputs and the lock descriptor are captured before asynchronous work.

Only one run/seal is active at a time, with at most 32 enrolled workers.
Unregistered or missing worker files, another operation's state, changed
lock identity, changed helper content, missing/truncated authority, or unsafe
worker outcomes close admission. Ordinary nonzero exit remains an ordinary
command failure when the actual worker settled; it need not prevent later
enrolled work. Seal rechecks the exact inventory and all settlement receipts.
Seal is not deployment acceptance and does not release the lock.

`releaseLock` now refuses while worker evidence or the saved-engine slot
exists, including the partial setup case before operation-journal creation.
Neither seal nor close deletes evidence. Read-only inspection can read the
durable operation header after the original controller is killed; it does
not adopt that lock or authorize new work.

### Remaining gates after N8

Native blocked evidence is still deliberately retained. In particular a
Windows blocked owner can keep the controller's pipes/event loop alive until
explicit shutdown or the independent native deadline; public CLI lifetime
and recovery supervision must resolve this without inventing settlement.
The test's identity-checked fixture termination is NOT a production recovery
implementation.

Next implement the separate exclusive recovery/retirement authority:
reconcile incomplete enrollment and original native domains, persist verified
settlement, then retire exact saved-engine/journal slots without accumulating
history or releasing another owner's lock. Do not treat the sealed record,
dead controller, absent same-name Job, or elapsed deadline as sufficient
unblock authority. Helper setup before the pinned header and partial
retirement still require their own crash-boundary matrix.

Linux non-root intended-account support, Windows production control ACL
provisioning, remaining native fault injection, actual application shutdown,
backup metadata and historical deploy/update/restore acceptance remain open.
No public wrapper, main PR, merge or live installation was changed.

## N9: Successful-operation retirement and fixed-slot reuse

This batch closes a concrete repeat-update blocker: successful workers leave
the fixed helper slot and journals behind, so a second operation cannot begin.
Only the original live operation object can request retirement. Require sealed
worker admission, all exact enrolled journals settled, unchanged original
lock/operation evidence, verified helper digest and matching `accepted` or
`restored` application state. A sealed worker list alone is not sufficient.

Files: add `scripts/deployment/worker-retirement.mjs`; extend
`worker-operation.mjs`, `state.mjs`, saved-engine allowlist and corresponding
shared/native tests. The retirement helper snapshots an explicit flat file
inventory with SHA-256, dev/ino and lengths; writes an exclusive durable
`worker-retirement.json` intent before deleting anything; deletes only those
exact checked regular files, then the empty helper directory. Never recurse,
follow a link, infer ownership from a name, or delete the backup/state/lock.
Delete operation evidence and the retirement intent last, with directory
flushes. Any failure permanently closes this object's admission and retains
the lock; no reopen/retry/adoption API in this batch.

```js
await operation.seal();
// The deployment coordinator persists matching accepted/restored state.
await operation.retire();
await releaseLock(control, lock);
// A second operation can now use control/worker-engine without another slot.
```

- [x] Add causal Actions-red contracts: missing app acceptance/unsealed/closed
  authority refused, marker-only state still prevents unlock, successful
  retirement preserves backup and app state.
- [x] Implement checked retirement and exact helper allowlist; preserve errors
  from both retained-handle closes.
- [x] Exercise two actual native operations using the same fixed slot on both
  OSes; inject marker flush and partial deletion failures with bounded fixtures.
- [x] Require all four Actions jobs green and persist evidence.

Interrupted retirement is NOT automatically resumed. The fixed intent records
the original lock, helper digest and exact deletion inventory for later
exclusive recovery. Unknown files, partial intent, changed identity, missing
evidence or dead owners remain blocked. Windows directory power-loss guarantees
remain unchanged; do not claim Linux fsync semantics on Windows.

### N9 execution evidence

- Causal missing-retirement and marker-only unlock red: `e6dc6c8`, Actions
  `36319932678`.
- Initial checked retirement and repeat-operation integration: `f1ac345`,
  Actions `36320054028`. Shared contracts and Linux native passed. Windows
  reached the second operation but its test supplied an empty environment;
  Node exited 134 at `ncrypto::CSPRNG` initialization. The fixture now supplies
  an explicit runtime environment, consistent with the first command. No
  production environment fallback was introduced.
- Partial-delete, intent-flush, foreign-file, final-marker and actual controller
  death cases: `355ff8b`, Actions `36320212872`, all four jobs green, including
  two actual native operations reusing the same fixed slot on each platform.
- Application acceptance capture-race red: `3ea2d94`, Actions `36320249730`,
  reproduced on both platforms. A changed state could otherwise become the
  captured deletion authority after the initial accepted-state check.
- Accepted revision `6f0fb1c7b36d2b99926eae8b1009b75bd1208690`:
  each retirement authority check also requires the
  original parsed accepted/restored state, not just consistency with the
  subsequently captured file. Actions `36320488301`, all four jobs green:
  **200 Linux shared contracts**, **196 Windows shared contracts with four
  Linux-only skips**, **19 Linux native integration cases**, **18 Windows
  native integration cases**, plus the existing **13 Windows Job primitives**.

`operation.retire()` is permitted only on the original live, sealed and
unpoisoned object; closed handles or failed retirement cannot be retried.
The helper manifest and every enrolled settled journal are reverified.
Retirement captures original file handles plus exact dev/ino/length/SHA-256
inventory and writes an exclusive flush-before-delete intent. The original
state, lock, control directory, helper directory and deletion inventory are
checked throughout. Only exact regular files are unlinked, then the empty
helper directory. There is no recursive production deletion.

Worker operation evidence is removed last among planned files. Original
handles are closed with aggregated errors; only then can the matching intent
be removed and the control directory flushed. No backup, application state
or lock is part of the deletion inventory. `releaseLock` rejects every
`worker-` artifact, including a lone malformed retirement intent.

The native repeat-operation test runs real commands, seals workers, writes
synthetic accepted application state, retires helpers/journals, releases the
first lock, acquires a second lock and repeats native execution/retirement
using the same control and helper paths. The backup sentinel survives both
cycles and the final control directory contains only backup and state.
This proves slot reuse and native sequencing, NOT a real npm/Next update or
application-health acceptance.

The real crash fixture kills its controller after the first helper unlink.
The original intent and partial inventory remain, accepted state alone does
not grant a second lock, and a new controller cannot release the old lock.
Automatic resumed cleanup is deliberately absent.

### Remaining gates after N9

The successful live path can now release evidence and reuse fixed slots.
The next recovery gate is still exclusive interrupted-operation authority,
including partial retirement, pending enrollment and original native domain
reconciliation. Do not reconstruct a same-name Job or assume absent paths
mean stopped workers. Saved recovery code availability during partial helper
deletion must be addressed explicitly before implementing cold reentry.

Blocked Windows owner shutdown/supervision, Linux non-root runtime, production
Windows ownership/ACL setup, remaining native faults, application/watchdog/ACP
shutdown, full backup metadata and historical deploy/update/restore lifecycle
acceptance remain. These tests do not justify a main PR or live deployment.

## N10: Cold recovery of interrupted accepted cleanup

Continue inline under the approved recovery design. This narrowly permits
resuming N9 deletion, not recovering an unsettled native domain.

- Add `saved-recovery-engine.mjs` and `retirement-recovery-entry.mjs`. Save a
  closed dependency set in a fixed private `recovery-engine` directory,
  independent of `worker-engine`, project and node_modules. The code bundle
  contains no operation history and may be reused only when all source hashes
  match. Never silently replace a different or incomplete installed bundle.
- Add `retirement-recovery.mjs`: strict v2 retirement-intent validation with
  exact lock-file/control/lock-directory/helper-directory identities, fixed
  allowlisted deletion paths and content hashes. All remaining files must
  match before deletion. Missing files are authorized only by this completed
  deletion intent; an absent Job/cgroup does not enter this path.
- Extend the N9 intent to record those identity fields before any unlink.
  Reject older/unrecognized formats rather than guessing missing authority.
- Acquire `recovery-lock` with exclusive mkdir only after validating the
  original owner is absent or its PID has a different start identity.
  Retain the original lock and an immutable cleanup lease. Every mutation
  rechecks state, lock, lease and remaining inventory.
- After exact deletion, write a completion receipt inside `recovery-lock`,
  remove the intent and then the exact old lock. Remove the recovery guard
  last. `acquireLock` and `releaseLock` refuse a recovery guard; a crashed
  recovery itself remains blocked pending a later verified takeover design.

```js
const engine = await saveRecoveryEngine({ source, control });
const invocation = retirementRecoveryInvocation(engine, {
  control, project, operationId,
});
// Run independently from the saved absolute entry, with no Node preloads.
// Only successful checked cleanup reports status='retired'; it does not restore.
```

- [x] Actions-red: saved entry survives renamed checkout and a partly deleted
  worker bundle; refuses live owner, malformed intent, altered state/foreign
  paths, concurrent recovery and preexisting recovery guard.
- [x] Implement fixed recovery bundle and strict cleanup protocol; no recursive
  deletion or user-supplied removal path.
- [x] Actual child-process kill after first deletion, independent saved recovery,
  next-lock acquisition and backup/state preservation on both Actions OSes.
- [x] Record accepted evidence and cold-recovery limits.

The recovery bundle is a single retained tooling slot, not a second backup.
Its own trusted entry/verifier/private directory are the trust base, as with
the saved worker engine. Windows setup must provision ACLs explicitly; the
existing Node filesystem helpers do not provide Windows ACL hardening.
The bundle update protocol, stale recovery-lease takeover, crash after an N9
marker was already removed, and unresolved native workers remain separate
gates. Do not claim this narrow cleanup path supplies those authorizations.

### N10 execution evidence

- Missing independent-recovery module red: `7ccf165`, Actions `36321012466`.
- Initial implementation: `acaf933`, Actions `36321167339`, all four jobs
  green. An actual cleanup controller is killed after its first helper
  deletion; the verified separate saved entry finishes cleanup after the
  fixture checkout is renamed away and permits a new deployment lock.
- Expanded fault/guard tests: `c6615dd`, Actions `36321314255`. Deletion
  failure, old-lock removal failure, missing-file sequence gaps, recovery
  implementation tampering and actual recovery-controller death behave
  conservatively. Two status regressions fail on both OSes: a leftover
  recovery guard was reported idle without an old lock, or merely interrupted
  after recovery-controller death.
- Status correction plus actual native-worker cold-cleanup integration:
  accepted revision `44e56ff0eaf0814019884d300635b4a8eda07e44`, Actions
  `36321462991`, all four jobs green: **212 Linux shared contracts**,
  **208 Windows shared contracts with four Linux-only skips**, **20 Linux
  native cases**, **19 Windows native cases**, plus **13 Windows Job
  primitive cases**. The additional
  native case runs a real systemd/Job-contained command before sealing and
  entering retirement, kills that retirement controller, then uses the
  independent saved recovery entry to clean up and acquire the next lock.

`recovery-engine` is a fixed closed dependency set with a bounded SHA-256
manifest. It excludes application dependencies and native worker scripts;
the worker allowlist is present only as verification metadata. Saving identical
code reuses this slot; different/incomplete source cannot silently overwrite
it. The absolute Node invocation removes case-insensitive Node preloads.
The trusted saved entry verifies the bundle before importing the cleanup
implementation, and emits only a bounded fixed failure message on stderr.

N9 now emits v2 retirement intent containing original lock-file, control,
lock-directory and helper-directory identities as well as state/file hashes.
Cold cleanup accepts only that exact format and the exact helper allowlist,
up to 32 uniquely named worker journals, and operation journal last. Already
missing files must be a prefix of the recorded deletion sequence; arbitrary
gaps or foreign files do not count as completed cleanup. Remaining files are
retained and validated before mutation. The matching old controller must
have ended; a live PID/start identity prevents even recovery-guard creation.

`recovery-lock` uses exclusive directory creation and a pinned intent digest
in its owner receipt. Concurrent recoveries cannot both succeed. State, old
lock, marker, guard and remaining inventory are checked throughout deletion.
The original accepted/restored state and backup are never rewritten.
Completion is recorded inside the guard before removal of the marker and
old lock; the recovery guard is removed last. Ordinary acquisition/release
and status now recognize this guard independently of the old deployment lock.

### Remaining gates after N10

This restores only an already accepted operation whose workers had settled
and whose complete v2 deletion intent exists. It does not reconstruct or
settle an interrupted native domain, recover incomplete worker enrollment,
adopt a stale recovery guard, or recover the window after normal retirement
removed its marker but before its controller released the old lock.
If the recovery controller itself dies, its exclusive guard remains blocked.
Completion receipts preserve diagnostics but are not a general takeover API.

The fixed saved recovery bundle still needs production permission provisioning
and a verified code-update protocol; it must not be silently overwritten on
the next source version. Linux directory fsync behavior is not claimed for
Windows. Private bootstrap/verifier code remains part of the trust base.
These tests do not model privileged malicious filesystem writers or establish
physical Windows/ARM64 acceptance.

Continue toward the public deployment flow with intended runtime identities,
application/service/watchdog shutdown and real npm/Next execution, while
retaining the explicit unresolved recovery gates above. Real historical
deploy/update/restore acceptance, documentation and main PR remain outstanding.

## Delivery gate 1: Explicit Linux command identity

The existing public Linux script explicitly runs git/npm and the service as
the invoking root account. Do not silently switch existing installations to
SUDO_USER. This internal change enables the future service-inspected/explicit
account path without changing public defaults yet.

Keep systemd control and the trusted saved bootstrap root-owned: the private
control directory and Unix socket must not become readable to the target.
Capture explicit numeric uid/gid, send them with the one-use command grant,
clear supplementary groups in the isolated bootstrap, and set target uid/gid
in spawn before exec. The root bootstrap contains no application code.
Set `NoNewPrivileges=yes` on the transient unit so target exec cannot regain
privilege through setuid/file capabilities. Reject missing/negative/noninteger/
out-of-range IDs before native creation. No credential or environment fallback.

Modify `worker-identity.mjs`, `linux-worker.mjs` and the saved Linux bootstrap.
Extend actual Linux native tests using an explicit unprivileged UID/GID,
private control root, writable target directory and exact HOME/env. Assert
real/effective UID/GID, supplementary groups, NoNewPrivs, file ownership,
inability to regain root or read private control, and contained detached
descendants after cancellation. Preserve existing explicit root behavior.

```js
prepareLinuxWorker({ owner, saved, command, uid: 65534, gid: 65534, signal });
// Only the target and its descendants use this account; manager control
// remains root and still verifies the original retained cgroup.
```

- [x] Push causal non-root native contracts and observe root-only rejection.
- [x] Implement immutable account capture and privilege-safe target exec.
- [x] Validate on Actions with all existing worker/operation/recovery cases.
- [x] Record limits: no supplemental-group policy, account-name/service
  resolution or public service-account migration supplied by this helper.

Causal red: `63bd223`, Actions `36321810730`. Accepted implementation:
`4d1cbc3c3390e5ccfc0f243ff3167ecd20427466`, Actions `36321949034`,
all four jobs successful. Exact evidence: 25 Linux native; 19 Windows native
coordinator plus 13 Job primitives; 212 Linux shared; 208 Windows shared plus
four Linux-only skips. Includes actual non-root npm invocation and explicit
permission-denied failure with no privilege fallback. This does not count as
acceptance of public deployment scripts or application lifecycle.

The next part of the same gate adds read-only systemd account inspection in
`linux-runtime.mjs`, with real transient-service tests. Read the configured
User/Group, WorkingDirectory, DynamicUser, SupplementaryGroups and MainPID
from the system manager. Resolve numeric credentials and HOME through bounded
NSS commands, not SUDO_USER, project ownership or executing target code.
Reject missing/unloaded units, mismatched canonical project, DynamicUser,
nonempty extra groups, unsupported chroot/root-image configuration and an
observed running process whose real/effective/saved IDs differ from the
resolved account. Default empty systemd User/Group according to systemd's
root/primary-group semantics, not the invoking interactive user.

Factor bounded native manager execution/properties parsing into
`linux-systemd.mjs` and reuse it from `linux-worker.mjs` and the runtime
inspector. Include both new modules in the closed saved-worker bundle.
No service mutation or account migration is introduced. Actual service stop,
restart suppression and watchdog/ACP ownership remain separate work.

### Installed Linux account inspection acceptance

- [x] Causal missing-module red `52d16b3`, Actions `36322114084`.
- [x] Implement read-only configured/running account inspection and shared
  bounded systemd command/property reader in `f37823e`.
- [x] Resolve named/numeric User/Group and implicit root/primary group from
  NSS; capture NSS HOME without substituting SUDO_USER or project ownership.
- [x] Refuse a different canonical project, dynamic accounts, explicit or
  inherited supplementary groups, root namespaces and process UID/GID/group
  disagreement. Compare the service snapshot and PID/start identity again
  before returning; make no service mutation.
- [x] Accept a failed service's configured identity without inventing a live
  process. Real failed-unit and process-only group drift cases in `bc875a1`.
- [x] Final full Actions acceptance:
  `bc875a1d60b603b5c02368441a19646f791d4c1a`, run `36322656839`.
  All four jobs succeeded: 38 Linux native (25 prior worker/operation cases
  plus 13 account-inspection cases), 19 Windows coordinator cases plus 13
  Job primitives, 212 Linux shared, 208 Windows shared plus four platform skips.

Intermediate run `36322276541` failed only because the DynamicUser test unit
did not start, before reaching inspection. Test provisioning now uses `/`
for that fixture's working directory rather than its host temporary directory,
registers cleanup before startup, and reports bounded systemd exit properties
on startup failure. Production checks were not relaxed. `a0a7940` /
`36322483913` passed all four jobs before the final additional boundary cases.

This is a read-only account snapshot, not proof of service ownership and not
authority for a future destructive action. The future locked service adapter
must validate ExecStart/unit sources, retain the actual application domain,
prevent restart/reentry, and revalidate identity before service mutation.
Accounts needing supplementary groups are explicitly unsupported for now;
they are not silently migrated to fewer groups or to root. Windows installed
account/ACL/task handling remains unfinished. Public deploy/update/restore
files, main and the live deployment remain unchanged.

### Installed Linux service ownership, before stop admission

Continue the approved native-service task with a read-only retained inspection
in `scripts/deployment/linux-service-inspection.mjs`. Do not give stop authority
to the preceding account-only snapshot. Accept a loaded, non-transient,
canonical service in system.slice with Type=simple/exec, control-group kill,
SIGKILL enabled and no delegation, hooks or alternate activation units.
Read ExecStartEx as typed busctl JSON, not a shell or a delimiter-based parser:
require exactly the explicitly supplied absolute npm executable and literal
`start` argument, with no privilege/ignore-failure/expansion flags.

Retain root-owned non-writable original fragment/drop-in file descriptors,
their inode and bounded digest, and the original cgroup directory/events.
Check the current main process's Node executable, cgroup and start identity;
re-read configuration and account before returning. `check()` must reject
changed source files (including byte-identical replacement), stale manager
configuration, replaced service generations or changed account/placement.
Return fingerprints, not file contents or environment values. `close()` closes
only inspection handles; it never stops, reloads or modifies the service.

API used by actual persistent service tests:

```js
const service = await inspectLinuxService({
  unit, project, npm: absoluteNpm, node: absoluteNode,
});
try {
  assert.equal(service.identity.runtime.project, project);
  assert.equal((await service.check()).populated, true);
} finally {
  await service.close();
}
```

- [x] Add `tests/deployment-linux-service.test.mjs` to the Linux Actions job;
  prove missing-module red before implementation.
- [x] Implement retained source/configuration/native-domain checks and add
  the module to the closed saved-worker bundle and its contract.
- [x] Exercise actual npm services, wrong executable/argv/privilege flags,
  same-content file replacement, drop-in drift, generation replacement and
  detached descendant placement, while keeping a foreign sentinel untouched.
- [x] Record exact Actions evidence and remaining limitations. This inspection
  is not itself downtime, restart inhibition or full deploy acceptance.

Accepted implementation `5b120871cb77659396edb616e65af6893c460f7c`,
Actions `36324005421`: all four jobs successful. Exact counts: 46 Linux
native (38 previous plus eight installed-service tests); 19 Windows coordinator
plus 13 Job primitives; 212 Linux shared; 208 Windows shared plus four
Linux-only skips. Includes actual non-root npm service and wrong expected
Node executable, root-owned sources in a project with spaces, unsafe kill
policy/delegation/stop hooks, and writable source rejection. Inspection closes
its own descriptors only and leaves service MainPID/InvocationID unchanged.

Evidence progression:

- `94f4c37` / `36323349252`: causal missing-module red.
- `0ecc70e` / `36323522713`: persistent test units failed to load before the
  inspector ran. Corrected fixture WorkingDirectory serialization (raw path,
  not ExecStart-style quoted argv) in `364a3cd`.
- `364a3cd` / `36323683195`: actual services ran; strict human-readable
  property parsing rejected missing empty hook properties. Changed hook and
  activation arrays to typed D-Bus reads rather than treating missing as empty.
- `9a4b0cd` / `36323853825`: exposed busctl property-value versus method-reply
  tuple shape difference. `5b12087` decodes each documented shape explicitly;
  no alternate-shape guessing or success-shaped fallback.

The retained inspection currently requires a stable active/running service.
It is not cold recovery, proof that arbitrary external writers are absent,
or permission to stop an inactive/failed service with unknown remnants.
It deliberately refuses transient/aliased/noncanonical services, custom
launchers, additional npm args/command flags, execution hooks, alternate
activation units, delegated cgroups and unsupported account policies. It
captures unit/drop-in identity, not a complete backup of environment files.

Next: use this live authority in the locked service adapter, persist restart
inhibition before stopping, retain/observe the original domain until empty,
and refuse backup/restart on uncertain outcomes. Original source ownership
and application acceptance must also authorize eventual removal of inhibition.
These mutation/recovery paths are not supplied by `inspectLinuxService`.
Public entry scripts, main and the live deployment remain unchanged.

### Durable Linux service inhibition and original-domain stop

Implement `stopLinuxService({control, lock, unit, project, npm, node})` in
`scripts/deployment/linux-service-stop.mjs`. Require the live original lock and
matching `stopped` application phase before admission. Obtain the retained
inspection internally, never trust a caller-provided ownership descriptor.
Persist `service-stop.ndjson` intent before manager/configuration mutation.
Use one exclusive root-owned persistent drop-in:
`/etc/systemd/system/<unit>.d/90-agents-chat-deployment.conf`.

```ini
[Unit]
RefuseManualStart=yes
ConditionPathExists=!/etc/systemd/system/<unit>.d/90-agents-chat-deployment.conf
[Service]
Restart=no
```

The drop-in inhibits manual starts and dependency/automatic starts, including
after controller death or reboot; its own existence is the false start
condition. Automatic restarts require the separate explicit `Restart=no`;
they cannot be assumed to recheck start conditions. Verify its retained
inode/content, effective manager condition and restart policy before requesting
stop. Do not overwrite an existing inhibition file.
Append inhibited -> stop-requested -> stopped receipts, pinning the lock and
service identity. Use systemctl stop --no-block, then bounded observation;
only the retained original cgroup's empty/deleted evidence plus matching
stopped manager generation permits the final stopped receipt.

Return `checkStopped()` and `close()`; close releases inspection descriptors,
not the persistent inhibition or journal. This batch intentionally has no
unconditional unmask/uninhibit, generic stale-lock adoption or automatic
restart API. Releasing inhibition needs the subsequent activation/recovery
state protocol; until then the public scripts must not call this helper.

`service-*` evidence must block generic lock acquire/release, status must
report blocked, and both live worker retirement and its independent cold
cleanup must refuse it. Worker execution itself remains possible under the
same live transaction lock for the future stopped-update sequence.

- [x] Write real installed-service stop contracts first and observe Actions red.
- [x] Add inhibited/stopped observations to the retained service inspector,
  preserving existing read-only checks.
- [x] Implement exclusive durable inhibition, lock/file authority, bounded
  stop and original-domain empty proof; include saved helper coverage.
- [x] Validate actual npm/detached writers, manual and dependency starts,
  controller death, evidence replacement and lock/recovery barriers in Actions.
- [x] Persist accepted evidence and the explicit not-yet-supplied activation
  and cold-service recovery paths.

Accepted executable revision `464ef20704a29aac10ed480830042b8ed55b9bd4`,
Actions `36325844750`: all four jobs successful. Counts: 54 Linux native,
19 Windows coordinator plus 13 Job primitives, 215 Linux shared, 211 Windows
shared plus four Linux-only skips. There are eight new top-level native stop
tests (some contain multiple fault cases) and three shared service-evidence
barrier tests. All execution was in Actions; no local service/test process.

Key evidence:

- `b414d6a` / `36324572157`: causal missing stop module and missing maintenance
  lock-release barrier on both shared platforms.
- `a513aa7` / `36324753827`: implementation initially failed parsing because
  the new state export was nested; corrected in `99829a1`.
- `99829a1` / `36324862348`: actual stop succeeded, but observation incorrectly
  rejected systemd's terminal-state cgroup/InvocationID clearing. Now only
  original-or-empty identities, terminal states and MainPID zero are allowed
  after original-domain extinction; a new generation remains rejected.
- `9ecf8d4` / `36325093600`: fixture teardown raced its real writer while
  removing the project. `0decbc0` stops the fixture before removing files;
  `36325274816` passed. This was not final automatic-restart acceptance.
- `e265512` / `36325329245`: expanded restart test failed; subsequent
  `d623fdf` also made fault tests top-level instead of unintentionally nested.
- **Causal automatic-restart red** `d623fdf` / `36325618748`: after killing the
  maintenance controller and then the actual npm MainPID, systemd started a
  new MainPID with `NRestarts=1`, `ActiveState=active`, `ConditionResult=yes`.
  A start condition plus RefuseManualStart is not automatic restart suppression.
- **Fix** `464ef20` / `36325844750`: persist `[Service] Restart=no`, verify the
  effective restart policy, and refuse nonempty `RestartForceExitStatus`.
  The real crash test confirms terminal state, MainPID zero and NRestarts zero
  beyond the fixture's original one-second restart interval. Manual and
  dependency activation remain separately covered.

Actual controller SIGKILL is exercised after the durable stop-requested
receipt (application still running) and after the stopped receipt (original
domain empty). Both preserve the inhibitor and blocked status. There is no
claim that controller death before the stop request itself stops the app.
Receipt flush faults before inhibition and before stop do not cross the next
manager mutation. Existing inhibition is never overwritten; byte-identical
replacement of the inhibitor, journal or lock poisons the live authority.
A refused stop leaves intent/inhibited/stop-requested evidence, never stopped.
Restoring the original inhibitor inode after starting a replacement generation
does not make that new generation authoritative.

Remaining boundaries and next work:

- This helper is internal and intentionally leaves service inhibition/journal
  and the transaction lock in place. It is not yet wired into public scripts.
  `close()` only closes descriptors; it is not a recovery/unlock operation.
- Implement state-authorized activation/uninhibition and verified prior-runtime
  restart before exposing this path. Do not add a generic delete-marker or
  unmask command. Explicit cold service recovery, controller takeover, initial
  inactive/failed installations and reboot reentry remain unsupported.
- The persistent drop-in is designed to survive reboot; this batch exercised
  controller death and daemon-reload, not a real reboot.
- Backup metadata must distinguish original service/drop-ins from the generated
  maintenance inhibitor; do not restore the inhibitor as ordinary application
  configuration or discard it as worker cleanup. Worker execution may continue
  under the same live lock while the app is stopped; worker retirement and
  independent cold worker cleanup must refuse remaining service evidence.
- No full historical app deploy/update/restore lifecycle, main PR, live service
  change or Windows installed-service/task-control completion is claimed.

### Controlled live Linux activation

Extend the original stop handle with one-use `activate({purpose})`, implemented
in `linux-service-activation.mjs`, not a standalone unmask CLI. `deployment`
requires matching `activating` state; `prior-runtime` is restricted to
stopped/copying/rotating/backup-ready before source mutation. Preserve the
original service configuration; changed unit/drop-ins are not silently adopted.
Require no worker evidence, or one matching sealed operation whose complete
registered worker set is settled. Pin that evidence throughout admission.

Use a separate exclusive `service-activation.ndjson`, retaining the existing
stop journal. Before removing the inhibitor, record intent and create an
exclusive same-directory held hard link to its original inode. Record staging,
unlink only the verified original name, flush, reload and verify restored
original policy, then record a start request before starting. This retains
exact inhibition contents outside the checkout if startup fails.

On startup failure, restore only the original held inode with no-clobber link
creation, reload the verified service configuration and preserve both journals
and lock. A running but uncertain generation is blocked, never certified empty
or permission for backup. Return `active-unverified` only after inspecting the
new actual service identity. This is not HTTP/application acceptance and does
not retire maintenance evidence or release the lock.

```js
const stopped = await stopLinuxService(options);
const active = await stopped.activate({ purpose: 'prior-runtime' });
assert.equal(active.status, 'active-unverified');
await stopped.close(); // closes retained handles, never unlocks or deletes evidence
```

- [x] Add real prior-runtime/deployment activation and invalid-admission tests;
  observe missing-method red in Actions.
- [x] Implement original-policy inactive observation, exclusive activation
  journal and held inode, sealed worker admission, actual startup verification.
- [x] Exercise start failure, receipt flush faults and controller interruption;
  verify no install/build is performed and unsafe evidence remains blocked.
- [x] Record Actions evidence and remaining accepted-service retirement,
  cold recovery, changed-unit configuration and public-wiring boundaries.

Accepted executable revision `f98f1412ebc63e6ff49bbd1cded3588d3af5bec6`,
Actions `36326875767`, all four jobs successful: 61 Linux native, 19 Windows
coordinator plus 13 Job primitives, 216 Linux shared, 212 Windows shared plus
four Linux-only skips. Seven additional native activation tests include
multiple rejection/fault/controller-death cases; one shared test covers the
activation/worker admission barrier on both operating systems.

Evidence sequence:

- `b803423` / `36326304534`: actual services stopped, but activation calls
  failed because the live stop handle had no activation method.
- `7b1d956` / `36326458206`: initial purpose/phase-authorized startup and
  no-install/no-build command path passed all four jobs.
- `05d617c` / `36326654082`: actual sealed-worker, failed startup and
  controller-death cases passed Linux native. Shared contracts on both OSes
  exposed that a partial activation journal did not close worker admission.
- `f98f141` / `36326875767`: every operation verification, including the
  final pre-grant check, now refuses `service-activation.ndjson`. The
  activation file is created exclusively before its first intent check:
  an earlier racing worker changes the pinned inventory and blocks activation;
  a later worker cannot pass admission. The original worker operation must
  already be sealed and its exact registered journals settled.

Activation uses `service-activation-workers.mjs` to retain and check the
sealed operation/journal inventory while granting startup; it does not treat
an empty cgroup or a missing worker journal as settled. It retains a
same-directory hard link `<inhibition>.<lock-token>.held` to the original
inhibitor. Staging temporarily has two names for that one inode; startup keeps
only the held name. No overwrite/replace of a foreign held/inhibitor path is
allowed. A native failed start (non-root working-directory denial) restores
the exact original inode and `Restart=no`, records reinhibited and returns
an unsafe failure without claiming runtime restoration.

Controller SIGKILL after staged, uninhibited and started receipts retains
the precise phase and held inode, locks out ordinary reentry and never
reports application acceptance. After uninhibition/start admission, controller
death does **not** promise that the app remains inhibited or stopped. Likewise
a poisoned activation journal can prevent safe re-inhibition; the files and
lock are retained as blocked, not silently discarded or automatically retried.
Flush-fault tests verify no startup is granted at failed intent, staged or
start-requested recording. The phase gate is the trusted transaction's
source-mutation boundary, not an independent forensic assertion that nobody
else has edited checkout files.

Remaining integration: close accepted live service evidence only after
matching application acceptance and current runtime verification, then permit
worker retirement/unlock. Keep prior-runtime restart outcomes distinct from
new application acceptance. The helper currently preserves original unit
configuration and only handles an initially running service under its original
live controller. Changed-unit deployment, initially inactive installations,
explicit restore/new-controller service recovery, reboot reentry and failure
after successful activation still require their recovery integration.
No public deploy/update/restore file, main branch or live deployment changed.

### Accepted live service-evidence retirement

Add one-use `retire()` to the original stop/activation handle, implemented in
`linux-service-retirement.mjs`. Only a `deployment` activation followed by
matching `accepted` application state qualifies; prior-runtime restart is not
new deployment acceptance. Keep restore/new-controller cleanup unsupported
until its own authority protocol is wired.

Before deletion, verify the original lock, both live journals, held inhibitor,
sealed worker inventory, unchanged deployment identity and the exact activated
service generation. Retain independent handles/hashes for state, lock and the
three exact deletion targets. Persist `service-retirement.json` intent first;
delete held inhibitor, activation journal and stop journal in that order,
checking remaining/removed inventory, original directories, acceptance and
current service identity between mutations. Never recursively delete.

On success remove the intent last and leave the application running, backup
and state untouched, and transaction lock owned by its current controller.
The caller may then retire workers and release the lock through the existing
APIs. `close()` remains descriptor cleanup only. Failed/partial retirement
retains the intent and lock for inspection; no generic retry or cold adoption.

- [x] Push native retirement contracts and confirm causal missing-method red.
- [x] Implement original live handoff, accepted-state gate and exact durable
  deletion inventory; include helper in saved engine.
- [x] Exercise preserved backup/state/runtime, worker retirement/unlock,
  rejection before acceptance/prior-runtime/changed generation, replacement
  and partial deletion/controller-death cases in Actions.
- [x] Record evidence and remaining explicit service-recovery/public wiring.

Accepted executable revision `26cf423db79e4e8808c44396e4fcb1dcc63b617e`,
Actions `36327943345`: all four jobs successful. Exact counts: 66 Linux native,
19 Windows coordinator plus 13 Job primitives, 216 Linux shared, 212 Windows
shared plus four Linux-only skips. The five new retirement tests include
multiple rejection and deletion-fault cases. Linux native job budget is now
ten minutes to cover the expanded real-service lifecycle suite.

- Causal red `e6dd19c` / `36327393383`: missing live `retire()` method.
- Initial implementation `a03245f` / `36327616728`: all four jobs passed.
- Faults and repeated operation coverage `71222c9` / `36327856081`: all four
  jobs passed, including actual controller death after the held-file unlink.
- Final `26cf423` / `36327943345`: close original authority handles before
  removing the last service-retirement marker; retain blocked evidence on
  close failure. Worker admission remains closed by the retirement marker
  after the activation journal has been deleted.

The original live activation performs a handoff check after independently
capturing the exact deletion files, so a replaced journal/held inode cannot
become new authority merely by being captured. Checks retain original state
and lock files/directories, source configuration and activated runtime
generation. The accepted state must preserve the activation's transaction
identity and metadata; prior-runtime restart and an unaccepted running
service are rejected. The original activated service must still be running;
a subsequent systemd restart is not adopted.

Two real native cycles now execute stop -> owned command -> seal -> activate
-> synthetic acceptance -> service retirement -> worker retirement -> unlock,
then reuse the same control/helper slots. The runtime is an actual installed
npm fixture with detached children; synthetic acceptance is **not** an HTTP
health check or complete Next.js historical deployment acceptance.
State and backup sentinels remain byte-identical, and retirement preserves
the activated InvocationID rather than stopping/restarting the application.

Fault coverage includes retirement-intent flush, second unlink, final marker
unlink, acceptance drift after first unlink and descriptor close. Every fault
retains service evidence and blocks ordinary lock release/reentry. Real
controller SIGKILL after the held-file unlink leaves the accepted service
running, durable exact intent, both journals and the original lock.
No recursive production deletion or implicit retry is provided.

Next delivery work remains: explicit service recovery/cleanup from a new
controller, prior-runtime restart terminal-state handling, recovery after
activation/health failure, and initially inactive or changed-unit installations.
The final marker-removed-before-unlock window still leaves the original lock
on controller death; no generic stale-lock adoption is implied. Windows
installed-service/task/account control, complete native snapshot inventory,
public deploy/update/restore wiring and true historical app acceptance remain
outstanding. Main, public entry scripts and the live deployment are unchanged.

### Failed update with verified prior runtime restored

Complete the pre-source failure outcome, not a new successful deployment.
Introduce terminal `prior-runtime-restored` only from stopped/copying/rotating/
backup-ready with priorRuntime=running, a non-null failure code and deploy/update
operation. Never allow it from source-selected/building/activating or restore.
After a safe pre-source failure, transaction start and verify use
activationPurpose=prior-runtime with a fresh recovery signal; even --wait=0
must verify this recovery. Re-throw the original update error after persisting
the explicit recovered-runtime outcome. Restart/verify failures remain
recovery-required or blocked; do not claim prior runtime recovery.

Extend matching live service retirement for this purpose/phase without
loosening deployment acceptance. Shared worker retirement and its saved cold
cleanup may retire this completed failure outcome after exact state/lock
verification. Ordinary new-operation state admission and status recognize
the finished failure, while already-current must still require accepted target
provenance. Recovery advice offers retry, not database restore or update success.

- [x] Write causal transaction/state and real Linux failure-closeout contracts.
- [x] Implement phase validation/status/advice and verified recovery ordering.
- [x] Wire service and worker retirement, saved recovery and no-op semantics.
- [x] Validate actual backup failure -> old npm service restart -> verify ->
  failed terminal state -> evidence cleanup/unlock, plus restart/verify/state
  write failures and post-source refusal in Actions.

Causal Actions `36328912391` at test-only `3ca8d4d` failed both shared contract
jobs and the real Linux backup-failure closeout while the Windows native job
passed. Evidence includes missing recovery verification and activation purpose.
The cancelled-caller contract now preserves the existing stage cancellation
error with the backup failure as its cause, rather than requiring cancellation
to be erased. Non-cancelled failures still preserve original error identity.
Shared live/cold worker cleanup contracts retain the failed-update state and
backup; ordinary worker enrollment stays closed by that terminal outcome.

#### Prior-runtime failure closeout checkpoint (2026-09-27)

Executable `c9a840287aed7a7dec3e10b913e5946ad0da4a74`, Actions
`36329338667`, passed all four jobs: 69 Linux native contracts, 221 Linux
shared contracts, 217 Windows shared contracts with four platform skips, and
19 Windows coordinator contracts plus the native Job primitive step.
All execution was in Actions; no local validation or live service changes.

Real installed npm fixtures exercise the failed snapshot transaction with
no worker artifacts, with an actual settled/sealed native worker, and with
failed verification after the original service was restarted. The first two
persist the explicit failure code, retire exact service/worker evidence and
unlock without accepting the target deployment. The third retains
recovery-required state, service evidence and the lock; ordinary status
remains blocked. Successful recovery does not erase the original exception.
Cold saved worker cleanup also preserves the terminal failed-update state
and backup bytes after the retirement controller is killed.

This completes only the **live pre-source failure closeout**. The verification
adapter in the native fixture checks the actual service generation/account,
not real application HTTP or database continuity. A new controller still
cannot adopt interrupted service maintenance, partial service retirement or
the final marker/unlock gap. Recovery after source mutation or failed new
activation, inactive/changed-unit installations, Windows installed task/account
integration, complete backup metadata/rotation, thin public scripts and actual
dual-platform historical application lifecycle acceptance remain outstanding.
No PR, main change or physical deployment is authorized by this checkpoint.

### Cold Linux service retirement: exact completed-operation handoff

Continue the approved independent recovery architecture, initially only when
there are no outstanding worker artifacts. This is not generic stale-lock
adoption, service restart, backup restoration or reboot recovery. Existing
service-retirement v1 markers without durable command/policy identity are
not adopted. A missing retirement marker or preexisting recovery guard also
remains blocked. Worker-bearing service recovery needs a later explicit
combined service/worker handoff; never discard those journals to unlock.

Files and responsibilities:
- `linux-service-inspection.mjs`: include inspected executable identities and
  effective configuration in its serializable runtime evidence.
- `linux-service-retirement.mjs`: persist v2 intent with the richer runtime
  evidence before any deletion, preserving live cleanup semantics.
- New `linux-service-recovery.mjs`: validate the exact v2 intent, matching
  completed state and old lock, original service generation/boot/source/
  account/policy, original directories, retained files and deletion prefix.
  Claim exclusive `recovery-lock`, delete only the remaining allowlisted
  held-inhibitor/activation/stop files, record cleanup completion, then retire
  the original lock and recovery guard. Preserve state, backup and service.
- `saved-recovery-engine.mjs` and `retirement-recovery-entry.mjs`: include the
  new helper and its Linux dependencies in the fixed verified bundle; explicit
  `kind: 'service'` invocation, retaining default worker recovery semantics.
- New `tests/deployment-linux-service-fixture.mjs`: shared actual npm service
  fixture extracted unchanged from the existing service suite.
- New `tests/deployment-linux-service-recovery.test.mjs`: kill the real original
  controller before deletion and after each deletion; run the independent saved
  recovery after moving the source scripts. Assert unchanged service invocation,
  state/backup bytes, removed maintenance/lock artifacts and new lock admission.

- [x] Push causal contracts and observe missing service recovery in Actions.
- [x] Implement exact intent validation and saved recovery dispatch.
- [x] Exercise invalid path/gap/state/boot/source/generation/file replacement,
  live owner, worker evidence and competing/stale recovery guards before deletion.
- [x] Add deletion/close/controller-death faults during recovery; retain guard
  and diagnostics, never automatic retries or force-unlock.
- [x] Push and await all Actions jobs, inspect bounded failures and checkpoint.

Native success assertion:
```javascript
const command = retirementRecoveryInvocation(saved, {
  control, project, operationId, kind: 'service',
});
const result = JSON.parse((await execute(command.file, command.args, {
  env: command.env, timeout: 90000, maxBuffer: 8192,
})).stdout);
assert.deepEqual(result, { status: 'service-retired', operationId, restored: false });
```

Validation uses the existing `Deployment lifecycle` workflow only. The Linux
job includes the new native suite; both shared contract jobs and Windows native
ownership remain required. No local test/server/package execution.

Causal test-only `b9e53b7` / Actions `36330081492`: exactly the five new
service recovery success paths failed at the old worker-only entrypoint.
Both shared jobs and Windows native passed. The new recovery suite now has
its own Linux runner/job so its real persistent-service faults do not share
systemd daemon reloads with the existing lifecycle suite.

Initial implementation `eb8157f` / Actions `36330423169` passed all five jobs:
21 new cold-service contracts, 69 existing Linux native contracts, 221 Linux
shared, 217 Windows shared plus four skips, and 19 Windows coordinator contracts
plus the native Job step. Closing review freezes the newly exposed nested
configuration/executable evidence so a caller cannot mutate the live inspector's
comparison baseline. Final acceptance of that guard is recorded below.

#### Cold service retirement checkpoint (2026-09-27)

Final executable `60544d4aba8a4de0a647e7a819f6c50ba4bf422c`, Actions
`36330782872`, passed all five jobs. It includes the unchanged 21 cold-service
contracts, 69 existing Linux native contracts, both shared contract matrices
and Windows native ownership. Both the initial and final implementations ran
exclusively in Actions.

The saved independent recovery bundle can now finish exact v2 service
retirement after controller SIGKILL before the first deletion or after any
of the three allowlisted deletions. It verifies the same boot, systemd
InvocationID, process/account, effective configuration, executable/source
identities, original completed state and old lock. Only a missing prefix is
accepted; a gap, replacement, legacy intent, active owner, changed service,
unknown evidence or existing recovery guard is refused. The source scripts
can be moved away: the recovery uses only the pinned external bundle and
observes the still-running original service.

Recovery preserves accepted or prior-runtime-restored state and backup bytes,
does not stop/restart the app, and permits a fresh lock only after exact
cleanup. Deletion failure, state drift, descriptor-close failure, old-lock
deletion failure and actual recovery-controller death leave blocking evidence.
The latter does not silently grant a second recovery controller.

Remaining limitations are intentional and not hidden by this checkpoint:
worker-bearing service retirement still needs an explicit combined cleanup
handoff; preexisting/interrupted recovery guards are not adopted; service
retirement with its marker already removed but old lock retained has no
generic unlock path. Pre-acceptance stop/activation interruption, reboot,
post-source/health failure, inactive or changed-unit installations remain
separate recovery work. Windows installed task/account control, complete
backup metadata and rotation, public scripts and real historical Next.js
lifecycle acceptance are still outstanding. Main/PR/live deployment unchanged.

### Combined service and settled-worker retirement handoff

Extend the approved cold recovery, without adopting active/unsettled workers.
The live service retirement v3 intent pins the matching sealed operation,
settled journals, saved engine manifest/files and original engine directory.
`service-activation-workers.mjs` supplies the verified enrollment list;
`linux-service-retirement.mjs` retains/hashes the complete worker inventory
and rechecks live activation authority before writing that intent.
Ordinary live cleanup remains service retirement then worker retirement.

Cold `linux-service-recovery.mjs` validates the v3 allowlist and exact combined
deletion order: held inhibitor, service activation journal, stop journal,
worker journals, saved helper files, operation journal, then empty helper
directory. It checks state/service/lock and the remaining exact inventory
between mutations. Version2 remains no-workers-only. The service marker and
exclusive recovery guard remain until all combined evidence is retired;
the old lock cannot be released while any listed worker files remain.

- [x] Push real settled-worker and sealed-empty-operation causal contracts.
- [x] Pin live worker deletion descriptors into the v3 service intent.
- [x] Extend cold missing-prefix/inventory checks to the complete allowlist.
- [x] Cover worker/helper tampering, unknown files, missing journals and
  redirected deletion paths before service deletion; inject worker cleanup
  failure/controller death and retain both original lock and recovery guard.
- [x] Require all five Actions jobs, then save exact acceptance and limitations.

Native contract:
```javascript
assert.equal(intent.version, 3);
assert.ok(intent.workers.files.some(entry =>
  path.basename(entry.file) === 'worker-operation.ndjson'));
assert.match(intent.workers.manifestSha256, /^[a-f0-9]{64}$/);
assert.deepEqual(JSON.parse((await recover()).stdout), {
  status: 'service-retired', operationId, restored: false,
});
```

This does not yet adopt interrupted recovery guards or invent missing
service-retirement intents. No public/main/live changes or local validation.

Causal `17ccf7e` / Actions `36331268908` failed exactly the three new combined
success paths (intent version remained2) and the worker-path binding contract
(no worker inventory). The other four jobs passed. Implementation preserves
version2 no-worker recovery, pins version3 worker evidence through retained
handles and checks exact helper contents/directories during live handoff and
cold deletion. Added helper-delete/directory-delete failures and recovery
controller SIGKILL after a real helper unlink, with the service journals already
gone but original lock, combined marker and recovery guard retained.

#### Combined retirement checkpoint (2026-09-27)

Executable `11d16ff2fafe9e8d5cf4c3a550bdaf66907b6225`, Actions
`36331613299`, passed all five jobs: **34 Linux service-recovery contracts,
69 existing Linux native contracts, 221 Linux shared contracts, 217 Windows
shared contracts with four platform skips, 19 Windows coordinator contracts
plus the native Job primitive step**. Validation ran exclusively in Actions.

Actual native owned commands finish before the service is activated and
synthetically accepted (or the prior-runtime failure outcome is recorded).
Controller SIGKILL at service-retirement intent, held-file deletion or final
service-journal deletion now leaves a single v3 inventory that a fresh saved
engine can finish, including settled-worker journals, all pinned helper files,
the sealed operation journal and empty helper directory. State and backup
remain byte-identical, service InvocationID is unchanged, and a fresh lock is
admitted only after combined cleanup. Sealed operations with no enrolled
commands are covered too.

The live path still retires service evidence then worker evidence using the
original live handles; repeated normal service/worker cycles remain covered.
V2 no-worker service recovery remains supported, but downgrading a worker-
bearing marker to v2 does not authorize those worker files. Unknown, modified
or missing worker evidence and redirected paths are rejected before deleting
the held service inhibitor. Helper deletion/rmdir failure and recovery SIGKILL
after the first helper unlink retain the original lock, service-retirement
marker and exclusive recovery guard, even after service journals are gone.

This closes the combined service/settled-worker handoff, **not** restartable
recovery itself. Next priority is explicit continuation after recovery-owner
death and the durable completion/marker/unlock windows. Missing intent,
unsettled workers, pre-acceptance stop/activation interruption, reboot,
post-source/health failure and inactive/changed-unit support remain separate.
Complete native backups, Windows installed task/account integration, public
entrypoints and dual-platform historical Next.js acceptance remain outstanding.
No PR, main or live-deployment changes.

### Restartable service recovery through final unlock

One execution batch covers dead recovery-owner continuation and its final
metadata/lock deletion windows. It does not infer missing original live-service
retirement authority or accept malformed/incomplete initial recovery leases.

Use a retained Linux control-directory descriptor with `flock` on its inherited
open-file description. Every service recovery acquires this nonblocking native
admission before examining/mutating recovery evidence. Admission survives the
short flock subprocess and releases automatically on actual controller death;
the directory inode is retained and rechecked. A dead immutable recovery lease
may be continued without deleting/replacing the guard or rewriting its owner.
Live original/recovery owners, changed directories and competing admissions
remain refusals.

Publish full completion authority atomically as root `recovery-complete.json`
before removing the service marker: original intent bytes/digest, original
guard identity and lease file descriptor/content. This final receipt is outside
the guard and survives removal of marker, lock owner/directory and guard
owner/directory. It is retained after success for explicit idempotent recovery,
but cannot release a newly acquired lock or accept changed application state.
A later fresh recovery may retire a validated superseded receipt only while
holding native admission, with no existing recovery guard and a different
original lock token.

- [x] Add Actions-only native directory-admission/competition/SIGKILL contracts.
- [x] Implement `linux-recovery-admission.mjs` and include it in the saved bundle.
- [x] Resume only exact dead-owner leases under native admission.
- [x] Persist full completion proof and finish only its missing deletion prefix.
- [x] Kill the real recovery at service/worker deletion, completion publication,
  service marker unlink, old lock owner/directory removal and guard owner/
  directory removal; retry and verify byte-identical state/backup, same service,
  exclusive admission and refusal to touch the next operation's lock.
- [x] Require all Actions jobs and record final evidence and scope boundaries.

Causal `b2051d5` / Actions `36332487070`: the recovery job failed for the
missing native admission module and eight unrecoverable controller-death
boundaries; the other four jobs passed. New leases are version2 and bind the
original guard directory identity. Existing legacy/partial leases remain
refusals rather than guessed ownership. Ordinary Linux lock acquisition
shares directory admission, preventing a new operation racing final cleanup.
The persistent completion receipt is intentionally retained after success;
tests expect it and prove it cannot unlock a newly acquired operation.

Initial `a052d71` / Actions `36332873227` passed all five jobs: 44 Linux
recovery/admission contracts, 69 existing Linux native, 221 Linux shared,
217 Windows shared with four skips, 19 Windows coordinator plus native Job.
The kernel admission probe proves the flock subprocess can exit while the
parent retains exclusion; actual SIGKILL releases it without unlinking any
lock pathname. All eight final-cleanup death boundaries resume successfully.
Follow-up acceptance adds unchanged-lease recovery dying twice, guard/lease/
completion tamper, completion deletion gaps, runtime replacement and ordinary
deployment admission while native recovery admission is held.

#### Restartable recovery checkpoint (2026-09-27)

Final executable `1694d43b63ada8515b2caae4c9651f82bb8589e5`, Actions
`36333329618`, passed all five jobs: **52 Linux recovery/admission tests,
69 existing Linux native tests, 221 Linux shared, 217 Windows shared with
four platform skips, 19 Windows coordinator tests plus the native Job step**.
No local tests, servers or package installation were used.

This batch completes continuation of an existing validated v2 recovery lease,
including ten actual recovery-controller SIGKILL boundaries: durable lease,
service deletion, worker helper deletion, durable pending completion, atomic
completion publication, service marker unlink, old lock owner unlink, old
lock directory removal, recovery owner unlink and recovery directory removal.
The kernel-held control-directory lock excludes live competing recovery and
ordinary deployment admission without unlinking a lock file. Repeated recovery
death preserves the immutable first lease; its owner is not rewritten or
misrepresented as the new controller.

The independent saved recovery validates the full external completion proof,
same original terminal state, service boot/generation/account/configuration,
source and maintenance-directory identity, exact file identities/hashes and
final missing deletion prefix. It leaves `recovery-complete.json` for
idempotent explicit retry after guard/old-lock removal. A newly acquired
deployment lock is never removed by replay. A later distinct operation can
retire the prior validated receipt under native admission, and replace it
with its own completion proof after exact combined cleanup. State/backup bytes
and service InvocationID remain unchanged.

Tampered lease/digest, replaced guard, final deletion gap, changed runtime,
unknown/partial evidence and live owners remain blocked without further
deletion. Legacy recovery leases are not retroactively adopted; incomplete
initial owner creation or a partially written pending completion still needs
inspection. The original **live** service-retirement path's marker-deleted/
old-lock-retained window is separate from this now-covered **recovery**
completion window and is not claimed solved here. Earlier service-stop/
activation interruption, reboot, post-source/health failure, inactive/changed
units, Windows installed tasks/accounts, complete backups, public script
wiring and real dual-platform historical application acceptance remain.
No main/PR/live-deployment changes.

### Normal live retirement through unlock

Keep the original service-retirement intent after successful live cleanup by
atomically renaming it to `live-retirement.json`, rather than deleting the last
authority before worker retirement/unlock. It has identical v3 contents and
retains the service/state/worker bindings. Ordinary worker retirement may still
proceed, but new lock admission and idle reporting must refuse this receipt.
Original live lock release shares native admission, verifies the receipt
against the exact original lock/state/directories, and deletes old lock owner,
old lock directory, then receipt. Failure retains the receipt.

Saved service recovery accepts the live receipt as an alternative original
intent. It requires the exact old lock when any worker evidence remains.
If the old lock is already partly removed, all service/worker cleanup must
be complete before continuation. Final completion proof uses the live order
old lock owner/directory -> live receipt -> recovery owner/directory; normal
service-retirement recovery keeps its existing order. Replay cannot touch a
new operation's lock. A worker-retirement intent coexisting with the live service
receipt remains blocked until explicit combined handoff support is implemented.
Worker-only recovery must not delete its lock beneath that receipt; only the
original live worker retirement may proceed with the receipt present.

- [x] Push native controller-death contracts at live receipt publication,
  settled-worker cleanup completion, old lock owner deletion and lock directory
  deletion, with original service/state/backup preservation and new-lock refusal.
- [x] Implement no-clobber live intent handoff and exact live unlock validation.
- [x] Wire alternative-intent recovery and its ordered completion proof.
- [x] Validate existing live repeated cycles, fault barriers, all new crash
  boundaries and both platform contract matrices in Actions, then checkpoint.

Causal test-only `0134505` / Actions `36356286137` failed the five new live
publication/worker-complete/lock deletion paths: no live receipt existed.
Implementation retains identical intent bytes by rename, permits the existing
sealed live worker retirement, and verifies service/state/original lock under
kernel admission for live unlock. Cold recovery uses completion version2 for
the live order (old lock before live receipt), preserving version1 recovery.

**Checkpoint (2026-09-28):** Executable/workflow head
`c99b62292d6c6cf8fd27e6345f77c8f2a3905166`, Actions `36364440674`, all five jobs
passed: 59 Linux service recovery/admission contracts, 70 Linux native contracts,
222 Linux shared contracts, 218 Windows shared contracts plus 4 platform skips,
19 Windows coordinator contracts and the native Job probe. The Windows job also
passed five independent samples of the two previously failing recovery paths
(10 additional successful executions). Samples stop at their first failure;
they do not retry a failed cleanup or turn a failure into a successful job.

The covered live boundaries are receipt publication (without workers and with
a settled worker), completed worker retirement, old owner deletion, and old lock
directory deletion. Cold continuation preserves state, backup and the original
running service generation; successful continuation permits the next operation
but old receipt replay cannot touch that operation. Original live unlock refuses
changed state/runtime, foreign worker evidence and a recovery guard.
Worker-only cold recovery now refuses a live service receipt before creating its
guard or deleting evidence. Only original live worker retirement opts into
continuing beneath that receipt.

**Unresolved Windows diagnostic:** `654388b` / `36362744251` failed the
prior-runtime-restored cold-worker case; `641ed2f` / `36363291489` failed the
displaced-checkout cold-worker case. The latter reported
`DEPLOYMENT_RECOVERY_UNSETTLED` with a nested unclassified error. Neither log
identifies the root cause. `d9b842d` adds bounded static file/directory/content/
inventory error codes, not a speculative Windows fix; its run `36363891973`
passed, followed by the final matrix and five diagnostic samples above.
Non-reproduction does not establish a root-cause fix. Keep this investigation
open and use the more specific error codes on recurrence.

**Remaining boundary:** controller death during ordinary worker retirement can
leave both `worker-retirement.json` and `live-retirement.json`. Both recovery
paths deliberately refuse that combination; explicit validated combined
handoff is still required. Partial initial recovery records, earlier deployment
interruptions/reboot, installed Windows task/account integration, complete
backup/restore/public entrypoint wiring and actual dual-platform application
lifecycle acceptance remain outside this checkpoint. No main branch, PR,
installed deployment, or public script changed.

### Interrupted live worker retirement handoff

Continue the approved combined-retirement design inline. Do not invoke worker-only
recovery underneath a live service receipt and do not ignore a second marker.
`linux-service-recovery.mjs` remains the coordinator; a focused helper will validate
the exact worker v2 intent against the already validated live service v3 intent:
lock, control/lock/engine identities, state descriptor, manifest and every ordered
file descriptor must agree after converting relative paths to absolute paths.
The worker marker is retained and rechecked alongside existing authority.

Only after original-owner death, exact remaining-prefix inventory, original lock,
service generation and exclusive recovery lease are established may service
recovery unlink the matching worker marker. This is a transfer of duplicate
cleanup authority, not loss of the sole receipt: the live service receipt still
binds all worker files and survives through final unlock. Death before transfer
revalidates both markers; death after transfer resumes the existing service-only
combined inventory. Empty helper-directory removal before worker-operation deletion
is accepted because ordinary live retirement uses that order. Gaps or absent
helpers with remaining helper files are refused by the existing inventory checks.

Files: new `scripts/deployment/linux-worker-retirement-handoff.mjs`, modify
`linux-service-recovery.mjs` and the saved recovery allowlist. Extract reusable
native fixture into `tests/deployment-linux-service-recovery-fixture.mjs`; new
`tests/deployment-linux-worker-handoff.test.mjs`; extend both native pause children.
Run the new matrix in an isolated Linux Actions job, keeping the existing native
recovery matrix (roughly seven minutes) within its ten-minute limit.

- [x] Push causal native SIGKILL contracts at worker intent, journal, first/last
  helper, helper directory, operation and marker deletion. Example result:
  `assert.equal(JSON.parse((await f.recover()).stdout).status, 'service-retired')`.
  Require original service generation/state/backup and next-operation protection.
- [x] Observe the expected refusals in the new Actions job before implementation:
  `sudo "$(command -v node)" --test tests/deployment-linux-worker-handoff.test.mjs`.
- [x] Implement exact cross-binding and guarded marker transfer; keep partial,
  foreign, gap, absent-lock and tampered records blocked before any deletion.
- [x] Require recovery-controller SIGKILL before/after transfer and during remaining
  cleanup to resume, plus marker-unlink failure preserving both receipts and lock.
- [x] Push implementation, inspect all six Actions jobs, record exact results and
  remaining limits, and commit the checkpoint. No local validation or live changes.

**Checkpoint (2026-09-28):** Causal test-only `92da06a` /
Actions `36365970793` produced the expected 11 handoff failures (seven original
worker interruption paths, three recovery-controller interruptions, and the
unreached marker-unlink fault). Nine existing/refusal paths passed; the other
five jobs passed. The recorded cause was the unrecognized worker marker in the
combined inventory, not a fixture timeout or missing runtime dependency.

Executable `d0f27a5a5af07a6a3150f4170beb5de420093241` /
Actions `36366523791` passed all six jobs: 20 new handoff contracts, 59 existing
Linux recovery/admission contracts, 70 Linux native contracts, 222 Linux shared
contracts, 218 Windows shared contracts plus four platform skips, and 19 Windows
coordinator contracts plus the native Job probe. Five further Windows diagnostic
samples (ten executions) passed; the previously unexplained Windows refusal
remains unproven as fixed.

The new handoff helper compares the entire worker intent to a projection of the
validated original service intent. It grants no independent worker recovery
authority. Both original marker handles and bytes are retained until transfer;
all checks are repeated with the immutable exclusive recovery lease present
before deleting the duplicate worker marker. Original service/state/lock and
remaining file bindings continue to govern every subsequent deletion. No new
receipt schema or synthesized ownership is needed. Eight live interruption
cases include sealed-empty and actual settled workers and a failed-update
`prior-runtime-restored` outcome. Recovery resumes after SIGKILL at durable lease,
worker-marker removal and subsequent helper removal; explicit unlink failure
keeps both handoffs, lock and recovery lease and does not authorize another
controller while the first is alive.

This resolves the coexisting complete worker/live-service marker gap noted in
the preceding checkpoint. Partial worker-marker writes, partial initial recovery
records, interrupted pre-acceptance service phases/reboot and Windows installed
task/account integration remain blocked or unimplemented as previously noted.
Full backup/restore/public entrypoints and real dual-platform application
lifecycle acceptance are still separate delivery gates. Feature branch only;
no main/PR/public entrypoint/live deployment changes.

### Read-only persisted database shape admission

This batch implements the database portion of approved delta D, not the entire
target/config/runtime compatibility decision. Historical base is
`638c553c62406dbb7e6b5aeb41cdddf4cd6de179`. The five store files are unchanged
between that base and this branch: chatStore blob `aa201f3edc25e3d66bc76e9453c1cb3cda55db99`,
configStore `7f037928778e147cc68e46c550bf109759227765`,
chatSyncStore `005a819da01dff4e5dd512e40658ebdbdf4ebbb5`,
chatTransferStore `bb03a556703881ff086aa958db22ebbe6bf0cc17`,
scheduleStore `ecb14acd9f5f1107094e9621ba4da7cb273e56cd`.
They use `.data/chats.db` and `.data/config.db`; sync, transfers and scheduler
share chats.db. Missing lazy table groups are supported, but a partially present
group is not. Config migrations are import/add-column receipts, not a schema
version. Require the five known completed keys for initialized config.db.

`chatStore.ts:211` drops `orchestrations` at initialization. Do not run it in
admission. Refuse nonempty orchestration parent/child tables for this baseline
instead of declaring a destructive startup safe. Do not modify application
migration behavior in this batch. Persisted JSON content and target-version
semantics need separate checks; schema support alone cannot authorize downtime.

- [x] Add `tests/deployment-database-fixture.mjs`: derive test-only DDL from the
  five pinned historical blobs (verify Git blob IDs), never import store modules.
  Fixtures create databases using the repository's installed `better-sqlite3`.
- [x] Add `tests/deployment-database-compatibility.test.mjs`: actual historical
  schema, lazy groups, committed WAL-only schema changes, missing database/
  sidecar, unknown table/column/type/default/index/view/trigger/version/migration,
  partial group and populated orchestrations; verify no main/WAL byte changes
  or new application files after success and refusal.
- [x] Run a dedicated Ubuntu/Windows Actions matrix with `npm ci` and
  `node --test tests/deployment-database-compatibility.test.mjs`. First observe
  missing inspector failure; no local installs/tests.
- [x] Add `database-shape-policy.mjs` with fixed, trusted reference DDL and
  groups. Add `database-compatibility.mjs` exporting
  `inspectDeploymentDatabases({ project, profile, signal })`. Require the explicit
  supported profile, return only `status: 'schema-supported'` per existing DB
  or `status: 'absent'`, never `compatibility: 'passed'`.
- [x] Resolve `better-sqlite3` from the installed project, open with
  `{readonly:true,fileMustExist:true}`, use `query_only` and one read transaction
  per DB, compare bounded table/column/foreign-key/index metadata against a
  trusted in-memory reference. Never call store initialization or checkpoint.
  Reject unknown/corrupt formats with a static error code and next action.
- [x] Require canonical regular single-link DB files; reject rollback journals.
  Read the SQLite header before opening. WAL mode requires existing nonempty
  WAL/SHM files, avoiding SQLite's missing-sidecar creation path; absence is a
  refusal, not permission to use immutable mode. Recheck original path identities
  after inspection. This is not a substitute for later stopped-runtime snapshot
  ownership; cross-database snapshots and adversarial path races are not claimed.
- [x] Push implementation, inspect all Actions results, checkpoint the exact
  supported shapes and limits. Target Git metadata, Node/config/content checks
  and public adapter wiring remain separate required admission work.

**Checkpoint (2026-09-28):** Executable
`be6794daf326b57923d62cfbbd0f58dac9ea397e`, Actions `36370131506`: all eight jobs
passed. Database admission passed 39 contracts on each OS; Linux shared 222,
Windows shared 218 plus four platform skips, Linux native 70, Linux recovery 59,
Linux handoff 20 and Windows coordinator 19 plus native Job probe. Five Windows
cold-retirement diagnostic samples also passed; prior unexplained refusal remains
an open investigation, not an asserted fix.

Causal `469fa56` / `36368208629` failed both database jobs for the missing
inspector while the other six jobs passed. Initial `1fbdec6` /
`36368887672` exposed two fixture issues: chatSyncStore's DDL ends at a template
literal without a semicolon, and Windows cleanup attempted unlink before closing
the fixture writer. `07ec8f7` fixed those test mechanisms and passed all eight
jobs (`36369514666`). Final `be6794d` added actual concurrent-WAL snapshot and
existing-empty-data-directory coverage; no relaxed schema checks or retries.

The inspector compares bounded schema SQL (preserving quoted literal contents)
and table/foreign-key/index metadata to a fixed trusted in-memory schema.
Unknown versions, tables, columns, defaults, constraints, views, triggers,
indexes and migration keys refuse with static diagnostics; no stored values
are exposed. Lazy groups match actual shared-store initialization. Both a
schema refusal and a successful `schema-supported` result alone are proven
insufficient to authorize transaction downtime. Installed binding resolution,
hard-link refusal, absent DBs, missing sidecars, rollback journals, corrupt
headers, orphan WAL and extra DB files have explicit coverage.

For existing WAL databases the checker requires existing WAL/SHM sidecars and
uses one SQLite read transaction per database. A concurrent writer schema change
after the first schema read does not split that snapshot; the next independent
inspection sees and rejects the new schema. Main database and WAL bytes and
directory inventory are unchanged in the non-concurrent success/refusal cases.
SHM byte equality is intentionally not asserted: SQLite readers participate in
shared-memory coordination. No immutable mode, initialization, migration,
checkpoint, persistent scratch DB or application file creation is used.

**Limits:** closed WAL-mode databases without sidecars fail closed rather than
allowing SQLite to create sidecars; supporting that state requires a separate
safe inspection path. File identity rechecks do not make external writers/path
replacement races impossible, and the two DB snapshots are not a single
cross-database transaction. Native integration must retain appropriate runtime/
directory ownership and recheck before mutation. This profile establishes only
the reviewed baseline SQL shape, not row JSON validity, database-wide integrity,
target compatibility or no-loss application restart. Target Git-object metadata,
Node requirements, configuration/content checks, public admission wiring and
actual historical-update acceptance remain mandatory follow-on work.

### Target Git-object and effective authentication configuration admission

Continue approved delta D inline. Use two bounded readers, not candidate execution:
`target-compatibility.mjs` reads literal full commit Git objects; a private fixed
profile binds package.json, package-lock.json, all five reviewed stores and both
authentication files to their historical blob identities. New targets must declare
the existing v1 protocol and new compatibility.json profiles. The one exact
historical baseline may omit both; return protocol null and pending historical
adapter, never invent support for re-entry into an old transaction implementation.
Changed source with unchanged profile is refused until explicitly reviewed.

The runtime profile initially supports Node 24 stable on Linux/Windows only,
matching actual native validation. This is intentionally narrower than the pinned
Next >=20.9 and better-sqlite3 20/22/23/24/25 declared ranges. Do not implement an
incomplete general semver parser or assume future packages compatible. Existing
package.json has no engines field; lockfile and package hash pin this policy.

`configuration-compatibility.mjs` takes the explicit effective runtime environment,
not controller process.env or candidate dotenv execution. Require non-placeholder
NEXTAUTH_SECRET, HTTP(S) NEXTAUTH_URL without embedded credentials, complete local/
GitHub credential pairs and at least one enabled provider. Preserve reviewed
Azure public-client behavior (client secret optional), and GitHub explicit-email/
ADMIN_EMAILS fallback. Return provider names only; errors report static setting
names/check codes, never supplied values. This is an auth configuration check,
not collection of service env files or validation of every app setting.

- [x] Push `tests/deployment-target-compatibility.test.mjs` into existing installed
  Ubuntu/Windows matrix and observe missing-module failures. Use cloned disposable
  Git repos with real historical objects; assert checkout/index unchanged.
- [x] Implement fixed-profile source binding, regular blob mode/size checks,
  local-only Git with replacement objects disabled and bounded JSON declarations.
  Read blobs by immutable object identity, check bytes against the object digest,
  and sanitize all Git/parse errors. Cancellation precedes and bounds each read.
- [x] Add compatibility.json with exact database/config/runtime profile names.
  Keep `protocol.json` schema unchanged. Do not add package dependencies.
- [x] Implement explicit effective-env auth checks; validate target/error secret
  non-disclosure and prove combined partial results still cannot yield
  `compatibility: passed` or cause downtime.
- [x] Inspect both new matrices plus native regressions and checkpoint. Persisted
  row-content compatibility, effective-environment collection, integrity/runtime
  observation and public admission wiring remain required before full step1 closes.

**Checkpoint (2026-09-28):** Final executable/tests
`122ed90aa11a5c33b56e4637c8f82860eb3b398a`, Actions `36373234163`: all eight jobs
passed. Installed admission matrices each passed 80 contracts (39 database and
41 target/config); all six pre-existing shared/native jobs passed. Test-only
`7fe2d44` / `36371985871` failed both installed matrices because target inspector
was missing, with the other six jobs green. Implementation `666b9d8` /
`36372584715` passed before the final object-substitution/config boundary tests.

Target inspection requires a literal SHA-1 commit and regular non-executable
declaration blobs no larger than 16KiB. It disables Git replacements, lazy fetch
and optional locks, removes inherited Git redirection, reads declarations by blob
ID and verifies their byte digest. Real disposable-repository tests cover dirty
checkout/index preservation, altered package/lock/store/auth sources, unsupported
declarations and runtime versions, replacements and executable/symlink modes.
No candidate module is imported and no fetch, checkout or index refresh is used.
The current branch HEAD declares the reviewed profiles and passes inspection.

Configuration tests cover complete provider pairs, no-provider refusal, URL
credentials/fragments, placeholder secrets, bounded scalar settings, rejected
accessors/inherited settings, Azure public-client behavior and GitHub allowlist
fallback. Results contain only static profile/provider names, not env values or
hashes of low-entropy secrets. The caller must supply the actual effective service
environment; process.env is not implicitly consulted for configuration.

**Remaining:** neither target/config nor database inspection returns
`compatibility: passed`. A transaction test proves their combined partial results
still refuse before record/capacity/stop. This checkpoint does not complete
delivery step1: persisted data content/integrity, effective service environment
collection, native runtime-version observation and final admission orchestration
remain. The fixed reviewed Node24 profile deliberately refuses other majors;
expanding it or accepting changed package/store/auth files requires explicit
review and acceptance, not copying the profile declaration. Historical baseline
protocol remains null and needs a distinct historical adapter. Public
deploy/update/restore scripts, main, PR and the live installation remain untouched.

### Continuous delivery: persisted data and native admission

Do not stop for user continuation at subtask checkpoints. Continue approved delta
D through real native/public integration; preserve explicit safety refusals and
Actions-only validation. Persist changes and evidence before switching tasks.

Data content inspection extends the same read transaction used for schema checks,
with SQLite integrity/foreign-key checks, declared scalar storage types, bounded
JSON parsing and historical message/session/agent structures. A separate
`inspectDeploymentData` entry returns data-supported; the earlier shape entry
remains shape-only. New helper `database-content.mjs` owns content validation,
not store initialization. Bound each JSON value at 16MiB and streamed rows at
100,000 per table; exceeding either limit is an explicit unsupported result,
never truncated acceptance. Large-installation support needs a separate budget.
Do not emit stored row values or native integrity diagnostics.

- [x] Push actual populated/WAL fixtures and failures before implementing.
- [x] Add data checks inside the existing coherent read transaction. Verify
  integrity failures, wrong scalar/JSON/message/session/agent values and orphaned
  references without persistent mutation.
- [ ] Validate in the installed dual-platform matrix, then continue with effective
  environment collection and the native admission coordinator, without waiting
  for another user message. Record remaining limits rather than claim full deploy.

Implementation `cae81a73a303aef6fb657ed999122cdeddfefc4c`, run `36389236435`,
passed all eight jobs after causal `49f5c5e` / `36388505663` failed both installed
matrices on the missing data inspector export. Extended acceptance at `c9447c1`
also covers workflow/scheduler/sync/transfer records, complete-transfer hashes,
row/value budgets and a writer changing content after the schema snapshot starts.
Target bindings now also pin the reviewed message, transfer, workflow and
scheduler validators. The workflow checker reuses the controller's pure validator;
it does not import a candidate Git object or initialize a store.

The content budget applies to every scalar value, not only JSON. All integer
storage must fit the JavaScript safe range. Workflow graphs are limited to 128
nodes/dependencies per node before the shared semantic validator runs. Unfinished
uploads are valid; complete uploads must match their retained digest. Schema and
content share one database transaction, not an atomic snapshot across both DBs.
SQLite's synchronous integrity/scan work still needs an owned native worker to
enforce the stage deadline. A data-supported observation is not downtime authority.

Next configuration work retains ordered systemd EnvironmentFile observations and
the four production Next dotenv candidates, including absence and exact identity.
Only unambiguous single-line assignment syntax is initially supported; expansion,
multiline values and escapes refuse explicitly rather than being guessed.
Systemd files override explicit runtime environment; production Next dotenv files
fill only missing keys in their documented priority. The caller must collect the
actual native service environment, not supply controller process.env implicitly.
Results expose profile/provider/source names, never secrets or secret hashes.
Native checks must detect a stale running environment and recheck source evidence
before permitting downtime. Windows Task environment collection remains separate.

**Data/configuration checkpoint (2026-09-28):** `c9447c10efdffd567546f45e50f6353926f4b7dd`
/ Actions `36389382331` passed all eight jobs. Configuration-file implementation
`ff708a95768ce5c293b1a90d6790f0d858b0c6a2` / Actions `36391111852` also passed all
eight jobs after both causal shared jobs at `73b61df` / `36390601408` failed on
the missing file reader. Files are read with a 1MiB bound, regular/single-link
checks, descriptor/path identity rechecks, exact retained bytes and absence
observations. No secret hashes or values are returned. Unsupported shell/Next
expansion, escapes, multiline values and backtick quoting refuse explicitly.

Native startup-environment tests at `f33066b` / `36391401055` exposed missing
stale-value comparisons in both shared jobs; native tests additionally require a
new reader. Implementation `01b0aa3` observes typed systemd Environment and
EnvironmentFiles, compares pre-dotenv settings against the original npm process
environment, and retains original service/configuration/file observations through
recheck. PassEnvironment, UnsetEnvironment and PAMName are deliberately unsupported.
This detects changed EnvironmentFile content without restarting the installed
service. The actual Next loader differential tests are the next validation layer.
No configuration reader grants compatibility-passed by itself.

Native configuration run `36392107696` failed one fixture assertion: a quoted
EnvironmentFile path did not appear in the manager's effective file inventory.
All other jobs and six other native configuration contracts passed. The fixture
now uses the existing service template's unquoted whole-path directive; the next
run must establish this correction rather than hiding the missing source.
Both installed Next-loader differential matrices passed at `3407bc2` /
`36392777491`; its shared/native jobs intentionally lack the Node observer.
Node observation implementation is `b20dceccc788742736cab6ce14e66f3dbfff4119`,
queued in `36393607443`. It uses the owned worker journal, explicit retained
service account/HOME and executable, no inherited NODE_OPTIONS, original service
rechecks, bounded exact version output, and preserves unsettled-worker refusal.

Next, run the database inspector inside the existing owned worker rather than
loading the installed native binding or blocking on SQLite in the privileged
controller. Capture a closed list of trusted controller module bytes into an
in-memory Node24 module registry; transmit that immutable bounded payload to the
worker using the existing command protocol. This avoids executing candidate
scripts, exposing the private control directory, or creating a second mutable
temporary-code cleanup tree. The installed SQLite dependency is loaded only
after the native worker starts under the retained application account. The
payload contains source code and project/profile identifiers, never secrets or
database contents. Bound compressed/uncompressed payloads and validate the exact
small result shape. A blocked SQLite/native import must be killed/joined by the
existing stage/worker lifecycle; uncertain cleanup must still prohibit downtime.

**Owned database checkpoint (2026-09-28, validation in progress):** Native runtime
and configuration `b20dcec` / `36393607443` passed all eight jobs. Owned database
causal `c737bcb` / `36398975040` failed the missing command/native reader imports.
Implementation `6f87b3c` / `36399100244` passed both installed matrices and native
blocked-binding/descendant cancellation. The real non-root binding fixture failed
`inspection-unavailable` when linked through the runner workspace; no production
refusal was weakened. Fixture `9b9c277` copies only better-sqlite3 and its two
runtime dependencies into readable installation directories and first opens the
binding with uid65534. Its native data job in `36399901278` passed, including
actual read-only SQLite, cancellation and a 15-second deadline that settles the
blocked process before allowing recovery. Full nine-job completion is pending.

Before full compatibility admission, cover configStore's first-start imports:
when config.db is absent, agents.json and nodes.json are automatically imported,
and the historical initializer records import completion even after parse errors.
Read and validate those files without initializing either store; reject duplicates
that INSERT OR IGNORE would discard, validate known agent/model/env/flag fields
using the same data validator, bound source size, and retain file/absence evidence.
When the known config.db migration receipts already exist, those files are dormant
and must not spuriously block an update. This belongs inside the owned data payload
as well as the data inspection API. Causal tests are `fd33a66` / `36400621102`.
Legacy implementation is `604d810` / `36401552315`; installed Linux and native
data jobs have passed, with the full matrix still running. Owned database
`9b9c27762e6f2665a3ed911852bb3f9e64b5d627` / `36399901278` finished all nine jobs
green. The controller captures only the fixed module registry, then the original
worker protocol delivers it to the service-account Node process; no native
SQLite binding is loaded in the privileged controller.

### Composed Linux compatibility and remaining transaction integration

Native composed-admission causal tests are `2a98e6b` / `36402372897`. The next
adapter composes original running-service evidence, owned installed Node version,
immutable target source bindings, effective configuration, owned data/legacy
inspection and final configuration recheck. Only all these successful observations
may return compatibility-passed. Historical metadata absence is supported only
for the exact reviewed baseline/source-profile adapter, without executing its
deployment scripts. The returned check repeats configuration and owned data
inspection before downtime. Privileged Git object reads must scope safe.directory
to this already-canonical explicit project rather than change global trust or
silently substitute controller ownership for the installed application account.

This closes the live-Linux compatibility reader, not public transaction delivery:
the controller must retain and invoke the check before service stop, handle
first-install/inactive services separately, and retire failed preflight workers
without calling the operation accepted or prior-runtime-restored. A rejected
admission has not restarted anything. Add an explicit settled preflight-refusal
terminal outcome before wiring that failure path into public update/deploy.
Unsettled workers continue to retain the lock and forbid all recovery actions.
Windows Task/account environment admission and actual dual-platform application
lifecycle acceptance remain required; fixture-native acceptance is not that gate.

**Live Linux admission/closeout checkpoint:** `39a313e0be3a1ee7372a7a51ccac0f1be8262516`
/ Actions `36404188122` passed all nine jobs. Native composed tests prove declared
and exact historical target admission, original-runtime preservation on invalid
auth/legacy data, and configuration/data mutation refusal on recheck. The root
controller reads Git objects using a command-scoped safe.directory for the exact
canonical installation; no global Git trust is changed. A separate
`preflight-refused` terminal phase permits settled worker retirement and retry
without claiming acceptance or a restart. Native closeout verifies original
lock/state/runtime, seals the original operation, records refusal, retires
worker evidence and unlocks. Any failure retains evidence with recovery disallowed.
It cannot run after a stopped/source-mutation phase.

The next transaction integration is `0133382` / `36405903448` (pending): retain
the admission object, run its check after capacity and before the first durable
stop/source-mutation phase, and give that check a fresh cancellable stage budget.
The initial admission stage's signal is not reused for later checks. Causal
`42af874` / `36404995443` exposed skipped checks and the old captured-signal
failure. Existing abstract adapters without a retained checker keep their prior
contract; the concrete Linux adapter always supplies one. Public deployment
controller, inactive/first-install native admission and Windows integration are
still not wired. Do not mistake this checkpoint for application lifecycle delivery.

**Retained-check checkpoint:** `013338276c284abb065a53ae54a0d54b273d03e2` /
Actions `36405903448` passed all nine jobs. Causal `36404995443` was cancelled
after the intended shared skipped-recheck and native stale-signal failures were
observed; implementation acceptance was not substituted by rerunning failed tests.

### Complete project scope and Linux external resources

Backup inventory now selects all actual project top-level contents except `.git`,
`logs`, `.npm`, `.pnpm-store`, with nested `.next/cache` and `node_modules/.cache`
excluded explicitly. It never treats `.data/deployments` or unknown model/asset
directories as disposable. Nested repository/worktree markers and links into
excluded content refuse instead of creating incomplete snapshots. Entry counts
and manifest bytes are bounded. Optional runtime/configuration paths are recorded
as absent and checked before capture and completion; scope identity/top-level
inventory can be rechecked before copying. Existing callers without explicit
absence/exclusions remain supported. These are additive fields in the unpublished
snapshot-v1 format, not a claim of compatibility with a shipped restore reader.

Scope causal `72c5d72` / `36407100381` failed on the missing scope module in both
shared jobs, then was cancelled to advance full implementation validation.
Implementation `1effc08` / `36407209112` passed all nine jobs. External resource causal
contracts `c689843` / `36407467455` require Linux unit/drop-in/environment files,
source modes/uid/gid, checksums, and explicit absence in the same completed
snapshot. The Linux causal job failed on missing external metadata/payload,
missing rejection and dropped special mode bits; the remaining run was cancelled
after those failures were established. They require no stored secrets in metadata,
private payload files, and refuse unsupported Windows ACL capture. Native
stopped-systemd and final-authority-check causal tests are committed at `22c3ea3`,
Actions `36408441381`: native job failed on missing `linux-snapshot.mjs`, shared
contracts failed on the missing final source recheck. Implementation now captures
external files with byte/identity retention and private payloads, and composes
native stopped authority with file-only configuration rechecks. Cancellation in
the final source check cannot write the completion marker. Full matrix acceptance
is pending the implementation commit.

The native Linux wrapper must prove original stopped/inhibited service authority,
recheck admitted configuration bytes without requiring the process still run,
and capture original unit/drop-ins, never its temporary deployment inhibitor.
Recheck runtime/configuration/scope immediately before writing the completion
marker. This work does not yet implement no-build restoration or Windows ACLs;
extended permission support and saved restore engine remain delivery requirements.
External inputs are bounded to 64 files of at most 1 MiB each. Even optional files
require an existing canonical parent directory; unsupported missing parents refuse
rather than inventing restoration ownership/permissions for an uncaptured directory.

**Native snapshot acceptance:** `52900612c94e7c8c587aa9c55e7684972187c409` /
Actions `36409369077` passed all nine jobs, including actual non-root systemd
stop/snapshot and stale admitted-configuration refusal.

**Completion consistency follow-up:** causal `a662b6d` / `36409495671` demonstrated
that changes at the final authority boundary could still seal stale source,
inventory, permissions or external configuration; corrupt copied payload was
detected only after writing completion. Cancelled that causal run after the
Linux contract failures were established. The implementation reuses selected
inventory/implicit-parent capture, rechecks original metadata and file digests,
then verifies owner, complete copied inventory, external payload and serialized
manifest before sealing. File streams flush before closure; Linux directories
are synchronized bottom-up before completion and the containing directory is
synchronized after completion. Capacity includes actual serialized manifest size,
and over-budget manifests refuse before creating staging. These durability
operations are not a power-loss simulation or a Windows directory-ACL guarantee.
Implementation full matrix is pending. Public restoration is still not wired.

**Completion acceptance:** `858a8f0a255bb9a619f310b82675e496139db957` /
Actions `36410292431` passed all nine jobs. OOM recovery confirmed a clean
worktree at that commit; none of the accepted workloads were repeated locally.

### Explicit restore transaction

The shared restore coordinator requires literal data-loss acknowledgement before
any callback, validates managed runtime ownership and a retained backup check,
checks capacity, and rechecks the backup with a fresh stage signal before downtime.
It records restore-preflight/restoring/restore-activating/restored and calls only
stop, file restoration, configuration restoration, no-build activation and health
verification. No dependency, build, source-selection, backup creation or rotation
operation belongs in restoration. Health verification cannot be disabled.

Settled failures after stop leave recovery-required and stop partial activation
using a fresh cleanup signal. Unsettled writers instead leave blocked and forbid
further restoration/activation; cleanup and state-write errors preserve the
original error. The authoritative backup remains available for retry, not removed
or rotated. Causal `fbed2eb` / `36412176382` failed in Linux contracts on the
missing coordinator, then was cancelled to advance implementation. Native file
restoration, cold restore authority and external recovery entry remain unimplemented;
shared coordinator acceptance alone is not no-build application recovery acceptance.

**Restore coordinator acceptance:** `58f623be8e50ab368b7565a2154598ef16e9800c` /
Actions `36412316042` passed all nine jobs.

### Project-file restoration

Snapshots explicitly distinguish complete-project from selected-file scope and
record the project directory's original uid/gid/mode. Full scope must match actual
top-level inventory and the fixed exclusions at capture and completion. Older
selected snapshots remain verifiable but cannot authorize whole-project deletion.

The Linux project restore helper checks acknowledgement, backup ownership,
full scope, stopped/inhibited authority, capacity, original project identity and
the current removal inventory before replacing application contents. It preserves
the project directory itself and excluded top-level Git/log/cache roots. Nested
build caches are inspected (including mount/link/worktree checks) before removal,
not silently traversed. Links are removed before targets so interrupted removal
can be inspected again. Copies are independent, streamed and flushed; saved
ownership/modes and originally absent files are restored. Final inventory,
metadata, file hashes and retained backup are verified without install/build.
Cancellation/authority-loss leaves the backup unchanged and permits retry.

Causal scope/project tests `5f82a0b` were superseded in the pending Actions slot
by native tests `24a0331` / `36412692496`. Shared Linux failures demonstrate
missing full-scope/root metadata checks; shared and native jobs fail on missing
`restore-project.mjs`. The causal run was then cancelled to advance implementation.
Actual stopped systemd fixture now checks restoration of uid/gid 65534 and mode
0640, not only mocked file content. Full implementation acceptance is pending.

This is a project-file primitive, not yet a public restore: the external unit/env
restorer, durable cold restore authority, Git provenance/index restoration,
saved recovery engine, native activation and extended permission/Windows ACL
support remain required. No application restore acceptance is claimed here.

**Project restore acceptance:** `a96f85c0e63bb7e69ecfbd2d19928016833753f6` /
Actions `36413305133` passed all nine jobs, including actual stopped systemd
project restoration with original non-root ownership.

### Authorized external-file restoration

The Linux external restore primitive requires an exact independently authorized
destination list, acknowledged data loss, stopped/inhibited authority and a valid
snapshot belonging to the project. Before any file mutation it checks every
parent, destination type/link count, payload digest, ownership applicability and
space. Missing parents refuse instead of inventing directory metadata. It restores
saved bytes/modes/uid/gid or original absence, flushes writes and parent directories,
and verifies the resulting files and unchanged backup. Partial writes are retryable
from the same backup and never allocate additional retained copies.

Causal `526a2b0` / `36415354573` failed on missing `restore-external.mjs` in Linux
contracts and was cancelled after recording that evidence. Implementation validation
is pending. The caller must derive authorization from native restore evidence, not
blindly echo a manifest. Existing live stop authority intentionally rejects changed
unit-source evidence, so this primitive is not yet composed with service activation.
Cold/native restoration authority and external recovery tooling remain outstanding.

**External restore acceptance:** `d4ed91c80a3f23586cd09059fdea1018b475ef8b` /
Actions `36415501626` passed all nine jobs.

### Live native restore activation and terminal cleanup

Linux live stop authority now admits restore/restoring separately from deployment
stop and pins the operation type through all subsequent checks. Restore activation
requires restore-activating; retirement requires restored acceptance rather than
update acceptance. Live unlock and saved cold retirement cleanup recognize this
verified restore terminal state without weakening original lock, source, generation,
worker or deletion-inventory checks. Cold cleanup does not itself restore files.

External files already matching saved bytes, ownership and permissions are not
rewritten. This preserves retained original unit identity and modification metadata
for same-policy restoration. Reading may update access time; source authority
intentionally binds modification/change times instead.

Causal `92b74a5` / `36416403093` failed native admission because restoring was not
an admitted stop phase, and shared Linux contracts exposed unnecessary external
rewrites. The run was cancelled after retaining both failures. New native coverage
restores saved server code/data from a stopped fixture, activates a new npm service
generation, records restored, retires evidence and unlocks with backup intact.
Additional SIGKILL cases cover restore retirement deletion and partial live unlock
using the saved engine after checkout helper displacement. Implementation validation
is pending. Changed-unit policy rebinding, interrupted pre-acceptance/cold restore,
actual application readiness and public entry points remain outstanding.

**Live restore iteration:** `987ac9e` / `36416651343` passed eight jobs,
including saved cold cleanup for restored acceptance after SIGKILL. The native
snapshot job restored and activated the service but its test called `retire()` on
the activation result instead of the retained stop authority. Corrected that
fixture to the existing `stopped.retire()` API; full acceptance still pending.

### Native pre-downtime restore admission

Linux snapshot runtime metadata now retains the observed npm/Node executable
identities. Restore admission checks complete-project scope, project, unit,
uid/gid/user/HOME and those executable identities before stopping the current
service. It derives external destinations from the inspected service sources and
actual admitted configuration files, instead of accepting manifest paths as their
own authorization. Changed unit/drop-in bytes or permissions deliberately refuse
until policy rebinding is implemented. Backup and current service/configuration
are rechecked with the replacement stage signal before downtime.

Causal `31736c3` / `36416849913` introduces native admission tests against a
captured backup and reactivated actual non-root service, plus incompatible saved
identity/policy/path cases. These remain module/native fixture acceptance, not a
claim of public recovery or real application acceptance.

**Native restore admission acceptance:** `6ac37afdbd3ae1f7809079ff608d26d7e08cb152` /
Actions `36417717423` passed all nine jobs, including live restoration activation
and corrected original-authority retirement, incompatible backup refusal before
downtime, and cold restored-terminal cleanup.

### Interrupted chained-link restoration

Causal `5e24514` / `36418874673` exposed a real retry gap: creating a link before
its target link could leave a dangling live path if cancellation occurred between
the two creations. The next attempt correctly refused that uninspectable tree.
After capturing the Linux ENOENT failure, the causal run was cancelled. Restoration
now creates links only once their final target is present and matches the saved
target, defers unresolved dependencies, and refuses missing/circular targets.
Files/directories are flushed before link creation and link parents after each
creation. The interrupted test proves the first created link resolves, then retries
from the same unchanged backup. Implementation full matrix remains pending.

**Link retry acceptance:** `c63928ffda7311b97aaf29e9d8c64f629cb0a33f` /
Actions `36418991197` passed all nine jobs.

### Stopping a live activation rejected by health verification

Causal `9c47f33` / `36420070149` failed on missing `stopActivated` in the native
restore fixture and was cancelled after retaining the failure. A live activation
now retains a separate cleanup operation using its exact new service generation,
not the pre-deployment generation or a port lookup. Before requesting stop it
rechecks original activation/state/worker/held-inhibitor evidence, journals intent,
relinks the held inhibitor, reloads systemd, verifies effective inhibition and
journals the stop request. Completion requires the retained new cgroup be empty.
The four stop records bind the exact started identity and remain on disk.

Repeated live checks can prove the stopped/inhibited result; retirement as a
successful activation is forbidden afterward. If another actor restarted the
service, cleanup refuses before stop instead of terminating that replacement.
Any uncertain cleanup retains evidence and recoveryAllowed=false. The helper is
included in the saved worker engine's closed module list. Native tests assert
descendant writes stop, repeated observation works, and replacement generation
remains running. Full implementation acceptance is pending; cold recovery of an
interrupted activation-stop sequence remains a separate unfinished requirement.

**Activation-stop iteration:** `e0a5e90` / `36420355815` proved native stop,
descendant quiescence, repeat observation and replacement-generation refusal.
Three jobs failed on test expectations: both shared jobs retained the old explicit
saved-engine inventory, and the native test matched an inner retirement-refusal
message against the intentionally generic outer uncertainty error. Updated the
independent file allowlist and asserted recoveryAllowed=false plus the nested
cause. No production safety gate was relaxed; full corrected matrix is pending.

**Activation-stop acceptance:** `d7ea25b26f8d1259c926def7e6626e57125285f9` /
Actions `36421391543` passed all nine jobs. OOM recovery confirmed the clean
feature worktree and did not repeat accepted workloads locally.

### Service-owned HTTP readiness

Readiness must not accept a foreign healthy listener. The Linux probe first binds
the explicit port's unique TCP listening inode to a descriptor in the inspected
service's original cgroup and the controller network namespace. The same process
start identity, descriptor, socket inode and service generation are rechecked after
the HTTP response. Multiple listeners, other namespaces, inaccessible evidence or
unowned sockets refuse; no port-derived process termination is performed.

HTTP probes connect directly to IPv4 loopback with no proxy, redirects, shared
connection pool or credential headers. They request the existing
`/api/auth/providers` endpoint and require HTTP 200, bounded uncompressed JSON,
exact admitted provider IDs/types and structurally valid endpoint URLs.
Headers, body size and wall-clock duration are bounded. Cancellation destroys
the request and settles before returning. Response bodies and provider URLs
are not exposed in errors or the acceptance result.

Causal `98fef40` / `36422847700` adds real non-root systemd HTTP fixtures for
IPv4 and dual-stack wildcard sockets, foreign listeners that must receive no
probe, malformed/oversized/redirect responses, cancellation and changed service
generation. This remains endpoint/ownership acceptance, not authentication login,
database continuity or full application acceptance. Public integration remains
unfinished.

### Composed live Linux restoration

`runLinuxLiveRestore` connects the shared acknowledged restore transaction to
native backup admission, original lock/state checks, filesystem capacity,
project and external-file restoration, retained stop/activation authority and
owned HTTP readiness. Restored effective configuration is inspected again after
activation, so readiness does not reuse the pre-restore provider list. Acceptance
precedes evidence retirement and lock release. Failed health acceptance stops the
new generation and retains lock, stop evidence and backup for explicit recovery.
Native fixtures cover success and invalid-provider failure without install/build.
This is the running-service/same-policy composition, not the public or cold
recovery controller; incomplete-state recovery, Git restoration and saved restore
entrypoint remain outstanding.

Readiness-wait implementation `021acfb` / `36424238681` was superseded in the
queue, not accepted. Composition causal `3e1fe75` / `36424270838` failed on missing
`linux-restore.mjs` and also exposed the wait export accidentally nested inside
the one-shot probe. Moved it to module scope and retained the startup/cancellation
tests unchanged. Cancelled the causal run after both errors were recorded;
the complete combined implementation matrix is pending.

Composition implementation `5d25011` / `36425313943` passed eight jobs including
readiness startup/deadline cases; native composition exposed a clean-stop
systemd garbage-collection boundary during fixture backup capture. A successful
service exit can unload the unit between `show` and `GetUnit`. Inspection now
uses `LoadUnit` (policy load, not start) before the same typed properties;
systemd typed object lookup also reloads unloaded units. No source, inhibitor,
generation or empty-cgroup checks were relaxed. Root cause confirmed against
systemd v255 `src/core/dbus.c` `find_unit`/`manager_load_unit_from_dbus_path`.

Backup-binding causal `c2a64c0` / `36425368603` proved both destructive primitives
previously accepted another valid manifest instead of the pre-downtime admitted
one. Cancelled after exact missing-rejection evidence. Both now accept an
expected snapshot and refuse mismatch before mutation; live composition passes
its retained admitted manifest into each primitive.

Combined correction `b92de5c` / `36426602317`: all nine Actions jobs accepted.
Live Linux restore now has native success, failed-health owned-stop and no
install/build evidence, with restored provider inspection and bounded startup
waiting. Next extend the existing external recovery engine's closed helper set
and add a saved live-restore entry. A native child-process fixture will displace
checkout helpers, refuse missing data-loss acknowledgement before locking or
stopping, then restore through the external entry. This does not yet authorize
inactive-service or interrupted pre-acceptance recovery.

Saved-entry causal `338ba4d` / `36427847562`: eight jobs passed; native case
failed on the missing external `linux-restore-entry.mjs`, with the live
composition cases still passing. Extended the existing recovery engine (rather
than allocating another helper slot) with the pinned closed restore dependencies.
The entry verifies the complete saved manifest before loading native restore
modules, requires literal data-loss acknowledgement, reads bounded typed input,
inspects the live service/configuration, acquires its own lock and runs the
accepted composition. Pre-downtime rejection releases only its own pristine
lock after state equality and original-service checks; mutated or uncertain
transactions retain evidence. Native coverage also corrupts a saved helper and
supplies a missing backup before successful checkout-independent restoration.

Saved-entry implementation `fb601b0` / `36428977367` passed eight jobs but failed
the external restore with `ERR_MODULE_NOT_FOUND` before service inspection.
`snapshot.mjs` re-exports `snapshot-rotation.mjs`; that transitive dependency was
absent from the fixed saved manifest. Include it without weakening manifest
verification. Add cross-platform closure coverage that displaces the source,
checks saved relative module references, and imports the restore and recovery
compositions in a fresh process. Strengthen the native missing-backup case to
require `stage=restore` and `ENOENT`, preventing unrelated import errors from
satisfying the pre-downtime refusal assertion. The existing failed native run is
the causal evidence; no repeat missing-entry run is needed. Correction `f64f218`
/ Actions `36432769102` passed all nine jobs, including the external native
restore entry, the precise missing-backup refusal and both module-closure tests.

### Cold pre-acceptance recovery: stopped-service evidence

The next prerequisite is native read-only reinspection after the original
controller and its open cgroup/source handles are gone. Reuse the existing
systemd policy, source-file and executable inspection, rather than accepting a
service name or port as ownership. `linux-cold-service.mjs` checks the original
boot, account, executable identities, unit source identities/content, exact
deployment inhibition, terminal generation and absent or retained empty cgroup.
It accepts an optional matching held inhibitor hardlink for interrupted
activation-stop recovery. Different boots, replaced source/policy, changed
inhibitor, populated/recreated domains and foreign generations remain refused.
This read-only object is not permission to replace the old lock or write data.

Native causal cases in `deployment-linux-cold-service.test.mjs` kill the original
controller at its durable stopped receipt, then require reinspection without
the original handles. They also require refusal of missing/changed inhibition,
changed account/source evidence and a replacement running generation without
stopping that generation. Implement the inspector only after these cases are
pushed for Actions-red evidence. Follow with exclusive cold restore admission,
durable recovery ownership and interrupted activation-stop settlement before
connecting the external restore entry; do not report the inspector alone as
cold restoration acceptance.

Cold-inspection causal `04510d3` / `36433145755` failed on the missing
`linux-cold-service.mjs` as intended. It also had an independent Windows
retirement-fixture failure: a PowerShell process-start identity query exited
after roughly 33 seconds with no stderr (query budget is 30 seconds). This is
not evidence of a cold-inspection regression or an established timeout cause.
`8d94eb2` adds bounded code/signal/killed fixture diagnostics; no retry, identity
relaxation or timeout increase was added. Implementation `bb8e75f` passed all
nine jobs in `36433873228`; this does not classify the earlier Windows failure.
Additional native coverage kills the controller after
its activated-generation stop receipt and binds both original inhibitor links.

### Saved effective configuration before destructive restoration

`snapshot-configuration.mjs` resolves dotenv files and declared ordered
EnvironmentFiles against the verified full backup, never the current project.
External sources must be captured explicitly, including optional absence;
excluded project paths are refused rather than treated as empty settings.
Reuse the existing bounded configuration parser, precedence rules and auth
profile. Require snapshot equality on admission and recheck. Keep environment
values out of returned diagnostics.

`linux-configuration.mjs` obtains the same-policy unit's declared environment;
`linux-restore-compatibility.mjs` checks its saved effective configuration before
any downtime. Unit loading remains read-only (`LoadUnit`, not service start),
including after inactive unit garbage collection. Add the new module to the
existing saved recovery closure.

Causal tests `b1ae915` require both cross-platform saved-source behavior and
native rejection of a checksum-valid backup with invalid dotenv syntax while
the healthy installed generation stays unchanged. This is also a prerequisite
for cold restoration, where inspecting a nonexistent old process environment
cannot establish the restored configuration. Remote red/green evidence is
pending; no tests or servers were run locally.

Run `36434780266` at `8d94eb2` confirmed the missing saved-configuration module
on both contract hosts. Native saved-configuration rejection was **not**
established: an existing parent restoration activation failed, cancelling its
unawaited nested subtests before the new assertion ran. Await those subtests
with their explicit parent context, and capture bounded failed-unit journal
output before fixture cleanup. Do not call a later pass a diagnosis of that
activation failure. Cancel the remaining causal jobs after preserving these
outcomes; the combined implementation/fixture gate must pass independently.

### Exclusive cold restore admission

`linux-cold-restore-admission.mjs` holds the native recovery flock while binding
the dead original controller, unchanged lock/state file handles, complete stop
journal, optional fully stopped activation journal, and sealed/settled worker
evidence. It then combines cold same-policy service inspection with complete
backup checks and saved effective configuration admission. Live owners,
competing recovery, partial stop evidence, unclassified workers, replacement
file identities and changed backups are refused without repairing evidence.
An incomplete activation-stop sequence still needs explicit native settlement.

Extract the existing complete-backup/nonroot HTTP fixture for reuse by live and
cold tests. Native causal tests at `5c6dd09` require original-owner refusal,
exclusive reentry, unchanged lock/state/data, corrupted-evidence refusal,
backup recheck and complete activation-stop binding. The admitted object is
read-only: it does not take over the old lock, clear blocked state, restore
files or restart the service. Durable cold ownership transfer and a restartable
restoration transaction remain the next mutating boundary.

Saved-configuration/fixture correction `405e924` / `36436308202` passed all nine
jobs. Cold-admission causal `5c6dd09` / `36436753268` recorded 35 passing native
cases and one missing-module failure, with no cancelled subtests. Remaining
causal jobs were cancelled after that evidence. Cold admission `154b1fa` /
`36437554325` then passed all nine jobs.

### Durable cold recovery lease without discarding the application lock

Keep the original application lock, state and maintenance evidence unchanged.
`linux-cold-restore-lease.mjs` publishes a separate recovery controller lease in
the already-reserved `recovery-lock` guard. The lease binds the original
lock/state, control and lock directory identities, exact selected backup digest,
and the new controller's process-start identity. A private fixed staging
directory permits atomic first publication and atomic renewal of a dead
controller's lease. Renewal also binds the prior lease checksum. Only a
complete validated staging record, or the precisely identified empty staging
directory left after publication, can be reconciled; malformed/foreign evidence
is retained and refused.

`admitLinuxColdRestore` recognizes these bound dead leases under native recovery
admission, and still rejects live recovery owners. Separate source-evidence
rechecks let lease publication change only its own guard/staging paths while
all original lock/state, service, worker and backup checks remain enforced.
The returned live lease pins both the guard directory and owner-file handles.
Closing the controller's handles does not remove the durable guard or claim
restoration success.

Causal `ca2a1ba` / `36440467810`: eight jobs passed; the native job failed only
because the new lease module was missing. Child-process tests pause after
complete staging and after atomic guard publication, kill that controller,
then require another controller to obtain a validated lease with the original
application lock/state/data unchanged. They also cover competing/live owners
and refusal to repair a malformed staging record. Full implementation
acceptance is pending. This lease is not yet the file restoration, activation,
state transition or terminal recovery-cleanup composition.

Lease implementation `d6ff7b8` / `36442221791` passed all nine Actions jobs,
including both killed-controller publication boundaries and malformed staging
refusal. The original application lock/state remain unchanged.

### Actual cold file restoration under the recovery lease

`linux-cold-restore-files.mjs` applies the admitted complete project and external
snapshot through the existing destructive primitives, with explicit data-loss
acknowledgement, per-stage deadlines and retained stopped-service ownership.
Every primitive receives the exact admitted snapshot. Runtime Node/npm
executables inside the mutable project are refused during backup admission.

The repeated stopped-authority callback checks lock/state, owned service,
workers and lease evidence without rehashing the entire backup for every
top-level project entry. Full backup/configuration checks still occur at
admission, stage boundaries and the underlying restoration integrity checks.
Each new stage supplies its own signal; returned authority must not retain an
expired admission-stage signal.

After both project and external restoration verify, publish a private immutable
`recovery-lock/files-restored.json` checkpoint bound to the original operation
and exact backup. Retain its file identity/content through lease renewal.
Reentry always repeats restoration rather than treating that checkpoint as
proof that externally writable application files have stayed unchanged.
This stage returns only `files-restored`: it does not start the service, change
application state or unlock.

Causal tests `3358dd8` kill a cold controller after deleting the first saved-data
file, then require a new controller to restore actual saved bytes and service
files while preserving the old lock/state and keeping MainPID zero. The
checkpoint is inspected separately from final application acceptance.

Cold-files causal `3358dd8` / `36443837610` recorded 35 native passes, one
missing-module failure and no cancellations before its remaining jobs were
cancelled. Implementation `9b97cce` / `36444258404` passed the new real
interrupted-copy restoration case and seven other jobs, but **did not obtain
full acceptance**: Ubuntu database-content testing aborted inside
`better_sqlite3.node` `Database::~Database()` with Node 24.21.0's
`RemoveEnvironmentCleanupHook` assertion `(env) != nullptr`. The dependency
manifests, database inspector and data-content fixtures are unchanged from the
accepted lease commit. This identifies the failing native boundary, not its
root cause; no dependency substitution, timeout relaxation or blind retry was
performed.

### Retained cold policy observation for activation

The cold service object now distinguishes policy observation from stopped
authority. `checkPolicy` may inspect the original unit/account/executables
after explicitly requested uninhibition or a new generation; it never returns
a stopped/owned-running result. `check()` and `checkInhibited({stopped:true})`
still require the retained original inhibited, empty domain. A requested
stopped policy check rejects a newly running generation.

Native causal `f2d169d` exercises the missing policy method, then explicit
uninhibition and startup while proving ordinary cold stopped checks cannot
be reused afterward. This prepares the existing native activation composition;
it does not itself activate the restored application or complete recovery.

Cold policy implementation `2076855` / `36445815509` passed all nine jobs,
including actual interrupted cold file restoration. This does not diagnose the
earlier native SQLite destructor failure.

### Cold restored-artifact activation and owned health acceptance

Native causal `1d58e5d` requires healthy cold activation, failed-health stop of
only the new generation, and refusal of post-copy configuration drift before
uninhibition. The old application lock/state and recovery guard remain present;
the intermediate result is `ready-to-commit`, not final restored acceptance.

Reuse the native activation and readiness primitives under a durable immutable
`recovery-lock/activation-intent.json`. The intent binds the current recovery
owner, original lock and exact restored backup. Stop-only admission remains
strict: only explicitly armed activation checks may observe the new activation
journal without insisting the old service remains stopped. Original retained
lock/state/stop/worker evidence must remain unchanged. Existing activation
evidence cannot be overwritten; that branch still requires explicit recovery.

Before arming, read effective configuration from the actual restored files and
compare their bytes/absence with the snapshot. Retain the file and declared
environment observations through startup, then independently inspect the new
process's effective configuration and probe only its owned listener. Failed
health must invoke the retained new-generation stop authority before handles
close. Successful health leaves durable intent and journals for the forthcoming
accepted-state/retirement composition. An interrupted cold activation remains
blocked until that recovery path is wired; no application lock is discarded.

Causal `1d58e5d` / `36502895645` failed specifically on the absent new activation
module. Implementation `ecdc0c4` / `36503000258` passed eight jobs; both native
activation cases exposed a temporal-dead-zone error in `prepareActivation`,
before activation intent publication. Rename its returned activation-only check
so the pre-publication call resolves the outer stopped lease check. Configuration
drift refusal and all previous cold restore cases already passed in this run.

Fix `f406d24` / `36504314416` passed all nine jobs, including healthy cold
activation, stopped failed-health generation and pre-uninhibition config drift.
Next persist the already-observed health result as `activation-ready.json`,
bound to the recovery owner, activation intent digest, exact backup and new
runtime generation. This is a retirement prerequisite, not a restored result:
old lock/state and recovery guard stay retained. The native test must require
this receipt, detect identical-byte inode replacement and require its absence
on failed health. Terminal publication/cleanup still needs its own crash-safe
handoff and must not infer acceptance from files-restored or activation-started.

Causal `532d7b8` / `36505055349` failed exactly when opening the missing
`recovery-lock/activation-ready.json` after healthy activation. Publish the
receipt only after owned readiness and effective-configuration recheck. Pin its
inode, single-link identity and bytes for subsequent authority checks; failed
health must never create it. This remains intermediate health evidence, not
permission to unlock or to skip fresh runtime checks after controller death.

### Re-establishing healthy cold activation after controller death

The native killed-controller case (`6b87403`) pauses only after the readiness
receipt is durable. Require exclusive admission while the controller is alive,
then kill it and re-inspect without changing old lock/state, recovery owner,
activation intent or journals. Refuse a changed intent digest, restored-config
drift and a replacement running generation; readiness history is never current
runtime authority.

`linux-cold-activation-recovery.mjs` holds recovery admission and pins original
evidence while validating both dead controllers, the exact lease/intent/ready
chain, complete stop/start journals, held inhibitor, sealed workers, unchanged
service policy/account/executables, selected snapshot and effective live/saved
configuration. It probes the recorded port only after matching the owned live
generation. It returns only `ready-to-commit` with retained checks and close,
without renewing ownership or deleting evidence. Ordinary cold file admission
still refuses an activation-bearing guard. A dedicated opt-in lease reader is
used only by this read-only recovery inspector.

The restored-configuration inspector is renamed to describe its actual shared
responsibility: compare restored files with the snapshot under the caller's
native service authority, which may be either stopped or freshly owned active.
No stopped ownership check is relaxed in the file restoration path.

Readiness receipt implementation `9cf48c3` / `36507440802` passed all nine jobs.
Reentry implementation `cc393e9` / `36507681254` reached successful killed-owner
admission and tampered-receipt refusal, then failed in the test's own `.env`
read: this fixture intentionally configures auth in systemd and has no `.env`.
The drift case must assert initial absence, create the unexpected file and
unlink only that test-created file before testing generation replacement.
The causal reentry run was superseded while pending (Actions concurrency),
not a red test result; it was explicitly rerun after implementation started.

Corrected reentry fixture `e08705b` / `36508857836` passed all nine jobs.
Rerun causal `6b87403` / `36507545961` failed on the absent
`linux-cold-activation-recovery.mjs`, establishing the missing implementation.

### Cold restored-state publication and terminal retirement

After fresh owned readiness, capture a fixed retirement proof containing the
old lock/state, recovery lease/intent/ready receipt, native runtime generation,
held inhibitor and settled worker deletion inventory. Publish
`service-cold-retirement.json` before changing state or deleting evidence.
It blocks ordinary application lock acquisition throughout retirement.

Write the exact restored state through a fixed private staged file and atomic
rename, preserving the selected backup and new runtime. Delete only the
captured inventory, in order, checking identities and hashes each time.
Application lock removal precedes recovery guard removal. Rename the retirement
proof to `cold-restore-complete.json` only after all required deletions; retain
that receipt for idempotent completion. Reentry must reject gaps, replacement
files, changed runtime/configuration, alive foreign controllers and incomplete
staged state rather than guessing or rebuilding. Both live completion and
post-controller-death completion must freshly inspect the same owned generation.

Causal `7ea5225` / `36510310073` failed on the missing
`linux-cold-restore-completion.mjs`. The implementation separates strict
retirement-proof serialization/path validation from native state publication
and ordered cleanup. Native fault injection pauses after restored-state rename,
application-owner removal and recovery-guard removal; reentry must keep the
same service InvocationID and retained backup. Identical-byte owner replacement
must block cleanup, and idempotent completion must still recheck live ownership
and health rather than returning success from a receipt alone.

Terminal implementation `9e0ac48` / `36543429865` passed all nine jobs.
Saved cold entry causal `596c200` / `36543900080` failed at
`stage=service-inspection`: the external entry still assumed a running service.
Route existing application/recovery locks and cold retirement receipts through
the cold composition instead. Bind caller-specified unit and runtime executable
paths against retained evidence before lease publication or file mutation.
Healthy interrupted activation proceeds through fresh admission/completion;
fully stopped original operations restore files, activate and retire normally.
Incomplete activation remains refused, never silently retried or unlocked.
Keep the unchanged live restore path when no cold authority exists.

The saved-entry test was accidentally registered inside each terminal crash
case; move it to one top-level test without removing any crash assertions.

Saved cold entry `d67e550` / `36545627216` and extended identity/idempotence
coverage `df4b820` / `36545709295` both passed all nine jobs.

### Superseding a completed cold recovery receipt

The completed cold receipt is valid for idempotent recovery only until a new
operation starts. Leaving it forever makes the external entry select an obsolete
recovery instead of the new operation. Before acquiring the next lock, under the
existing exclusive admission, validate the receipt, exact terminal state,
absence of every retired path and expected root inventory. Then remove only
that completed receipt and sync the directory. No backup or terminal state is
deleted, and no service action occurs. A crash before new lock creation leaves a
normal terminal state; incomplete recovery never enters this path because its
guard/service marker blocks ordinary lock admission first.

Receipt supersession adds the proof reader to the saved worker engine because
`state.mjs` dynamically imports it. Initial implementation `859eb2a` exposed
the independently pinned helper inventory in `deployment-saved-worker.test.mjs`;
update that exact inventory, preserving the complete-manifest contract rather
than removing the closure assertion.

Extend the saved-entry native case through a second stopped/killed deployment
controller in the same project and control directory. Its next lock must
supersede the first completion receipt; a second external restore must return
the new operation ID, restore saved data, complete and unlock normally. This
checks the actual repeated recovery route, not merely receipt absence.

Both manifest correction `626a940` / `36548797100` and consecutive saved
recovery `f39a1a8` / `36549612383` passed all nine jobs.

### Exact Git metadata prerequisite for source restoration

Project snapshots intentionally exclude `.git`; restored files alone do not
restore checkout HEAD/index. Establish bounded, read-only capture of exact HEAD
and index bytes, the resolved commit and optional local branch ref. Pin the
standalone Git directory and metadata observations and reject changed metadata,
active Git lock files or linked/shared worktree layouts rather than writing
another worktree's state. Support both packed branch refs and detached HEAD.
The initial contract runs actual Git on Linux and Windows and verifies no index
refresh. Subsequent work must bind this record into complete snapshots and
restore it under owned stopped-runtime authority; this capture alone does not
claim Git restoration or verified build provenance.

Git metadata causal `6d1486a` / `36551551506` failed on the missing
`git-metadata.mjs`. Implementation `e909d37` / `36551643979` passed both
platform contracts and six other jobs, but the native service recovery job
failed in the existing cold-service activated-generation-stop fixture before
its pause. The child reported only `Service activation failed`; cleanup's
conditional failure diagnostic did not retain that unit's earlier journal.
Do not classify this as fixed or assume a stale systemd state race. Include
bounded activation state/InvocationID/job/result evidence in the native error,
and collect the isolated fixture unit's state and last 24 journal lines on
failed pause admission even when its eventual Result is success. No retry,
timeout relaxation or altered acceptance behavior is introduced.

Diagnostic commit `3f6738a` / `36553414300` passed all nine jobs; the previous
native activation failure remains unclassified, not fixed by that pass.
Snapshot-binding causal `3c0231f` / `36553465727` failed on both platforms:
no Git descriptor was returned and HEAD drift did not prevent completion.

Capture a separately bounded `git.json` payload only from a retained Git
observation. Its version/size/hash are bound into the completed snapshot
manifest, verified along with every other payload, and included in capacity.
Validate canonical base64, exact source/HEAD/ref agreement and the index checksum
both on capture and on saved reads. Recheck the retained source before
publishing completion. Legacy snapshots without this descriptor retain their
current behavior; this change does not yet make native restore update Git.
Include the two new modules in the saved recovery engine dependency closure.

### Stopped Git metadata restoration

The internal `restoreGitMetadata` primitive restores only the selected local
branch ref, exact index and HEAD bytes. It does not run checkout, hooks, npm or a
build and does not touch worktree files, objects or configuration. Require
retained stopped/inhibited authority before staging and every publication.
Use exclusive standard Git lockfiles and a private `.git/agents-chat-restore`
intent binding original/staged file identities, saved-byte hashes, canonical
parent directories and unchanged config/packed refs. Publish ref, index, HEAD
in order; recover only a completed publication prefix. Reject identical-byte
inode replacement, foreign locks, incomplete staging and target drift.

Both platform tests kill the helper after each of the three renames and resume
using the same saved record, asserting unchanged worktree contents and exact
HEAD/index restoration. This primitive still needs wiring before native
restoration can claim Git/source provenance.

Native integration captures Git metadata whenever the installed project has a
standalone `.git` directory; an existing unsupported layout is refused, not
treated as absent. Complete-project restoration applies saved Git metadata under
the same stopped authority after capacity/integrity checks, before worktree
replacement, and checks the exact restored record again afterward. Both live
and cold/saved paths share this primitive. Extend the real systemd fixture with
a real two-commit repository to require matching source files, branch HEAD and
byte-identical saved index. Synthetic non-Git fixtures and legacy snapshots
without Git metadata keep their explicit existing behavior.

This restores checkout metadata, not a Git object database backup or proof that
the captured build was produced from that commit. Object availability and
build/dependency provenance still require explicit admission before public
controllers may claim full source-based recovery.

Actions 36561410292 accepted snapshot binding in all nine jobs. Native causal
run 36562369885 demonstrated both missing Git snapshot metadata and a cold
restore that left HEAD at the newer commit. Native wiring is now implemented
in the shared stopped-project path. Cold interruption coverage also kills the
controller after index publication and during worktree removal, requiring
reentry to restore exact HEAD/index and source bytes without starting a service.

Windows contracts in 36561683828 and 36562369885 exposed Git restoration's
numeric filesystem identity validation: native file IDs may exceed JavaScript's
safe integer range. Git file and directory observations now use bigint stats,
serialize dev/ino as decimal strings, and retain nanosecond change checks.
Tests compare saved identities directly with bigint filesystem observations,
including each interrupted publication prefix. Do not relax identity checks or
convert an already-rounded numeric ID to a string. Remote validation is pending.

Actions 36570291906 accepted commit 3866ab6 in all nine jobs, including actual
Linux live/saved cold Git restoration and Windows exact-identity contracts.

### Owned npm execution integration

`npm-command.mjs` prepares fixed dependency/build commands for the existing
enrolled native operation, never spawns them in the CLI process. Invoke explicit
Node plus `npm-cli.js` instead of shell/cmd wrappers; normalize PATH to the
selected Node and refuse Node preload variables. Dependencies use
`ci --include=dev --no-audit --no-fund` so a production service environment does
not omit the compiler/type packages required by the build. Build uses only
`run build`, never an implicit install. Require a supported lock for dependency
installation and an explicit build script for the build stage.

Both native Actions jobs run actual npm against an isolated no-external-dependency
package: install, successful artifact creation, failed build, then cancellation
of a build with a detached writer. Require worker settlement and unchanged writer
bytes afterward. Existing saved native operation evidence and seal rules apply.
This is command/native integration, not yet complete application build provenance
or public deploy/update wiring. It does not install machine-level prerequisites.

### Owned Git source execution

`source-command.mjs` captures the existing source helper and its filesystem
dependency before source mutation. It runs inspect/resolve/select inside the
enrolled native worker using explicit Node/Git paths, rather than allowing a
controller-owned Git process to outlive a killed CLI. The child module registry
does not load code from the checkout being replaced. Git output is processed
inside the worker with the existing 8 MiB bound; only a validated 4 KiB source
receipt crosses the native diagnostic-tail transport, preventing a truncated
dirty-file listing from becoming successful admission.

Existing direct source readers remain available for read-only preview. The
owned path supplies the executable/environment explicitly and passes through
the same dirty-source, target identity and fast-forward policies. Both platform
native jobs exercise actual Git inspection, explicit selection, local-remote
fetch without checkout mutation, fast-forward selection, and dirty-source refusal.
No public controller or successful build receipt is claimed by this batch.

Retain `captureSourceCommands` before selecting new source. Subsequent stages
prepare commands from this captured registry and environment, without reopening
controller modules from the now-replaced checkout or retaining an expired stage
signal. Native coverage copies the helper closure, captures it, displaces its
directory, then executes every real Git stage through the retained factory.
Each command accepts its own fresh cancellation signal.

The native npm fixture additionally runs its detached writer through the actual
`runStage` deadline (15 seconds). Require that the writer really started, that
the stage reports `DEPLOYMENT_STAGE_TIMEOUT` with proven settlement, and that
writer bytes stop changing before the operation can seal. This verifies the
deadline boundary with npm rather than only synthetic stage adapters.

Npm causal run 36576419555 reported the missing command module as intended.
Implementation 29f0d93 passed all nine jobs in 36576520876, including real native
npm install/build and detached-writer cancellation on both platforms. Source
causal 36577701957 likewise reports the missing source-command module; owned
source implementation acceptance is still pending.

### Prior-generation failed state during queued activation

Source implementation run 36578775194 passed both contracts and native source
workers but failed native service recovery. Job 109443877572 captured the
previous generation with MainPID=0, ActiveState/SubState=failed, Result=timeout,
Job=1824 and unchanged InvocationID after `start --no-block`. The subsequent
fixture observation and journal showed a healthy new generation. The activation
loop had mistaken the old stop timeout for failure of the newly queued start.

Wait within the existing 30-second activation budget only when this exact
old-generation, no-main-process, pending-numeric-job failed state is observed.
Failure without a pending job, a new generation's failure, any live old process,
and auto-restart remain immediate refusals. Do not increase deadlines or blindly
retry starting the service. Add deterministic regression for each boundary; the
existing real service recovery matrix still exercises native start/stop.

### Installed Linux source/build composition

`prepareLinuxSourceBuild` captures source execution before downtime using the
observed installed Node/npm and explicitly selected Git. All workers use the
installed service uid/gid, not the privileged controller identity. Read-only
inspection and target resolution recheck the running service; source selection
and npm stages require the retained stopped/inhibited service and unchanged
unit policy before/after execution. Npm stages require exact selected Git
metadata and reject tracked-source drift afterward. They do not mark a build
as accepted or create a provenance receipt.

The native systemd fixture creates a two-commit source checkout owned by the
installed non-root account. It refuses selection before stop and npm with the
wrong commit, then performs actual selection, npm ci and build under durable
inhibition. Assert the artifact's contents and ownership both identify uid
65534, the expected source is selected, and no service activation occurred.
Environment is an explicit caller-supplied capture; public controller admission
still needs to bind the complete configured build environment and receipts.

Retained source capture cc337f8 passed all nine jobs in Actions 36579603389,
including displaced-helper native Git execution on both systems. The earlier
queued-activation failure is addressed separately above; a later green run by
itself is not evidence that the race disappeared. Npm command preparation also
captures environment values before its first asynchronous filesystem operation,
so caller mutation cannot change the eventual command's environment.

### Build artifact identity admission

`inspectBuildArtifacts` hashes the full `.next` and `node_modules` inventories,
including file bytes, paths, links, ownership and modes, excluding only the
existing `.next/cache` and `node_modules/.cache` cache policy. It separately
binds package/lock bytes and a bounded Next BUILD_ID; matching BUILD_ID alone
never accepts replaced output or dependencies. Reinventory and bigint file
identity/timestamp checks reject changes during hashing. A retained check
rehashes artifacts using the current stage signal.

Installed Linux npm stages pin package/lock inputs before execution and reject
post-command changes. Successful build returns selected commit plus retained
artifact observation; it still does not publish application acceptance.
The native fixture requires artifact identity, uid/gid, source commit and stopped
authority to agree, and rejects later output changes. Cross-platform contracts
exercise output/dependency/inventory/lock drift and allowed runtime cache writes.
Actual Next application builds and durable successful deployment receipts remain
separate gates; fixture success must not be represented as those gates passing.

Two dedicated Actions jobs now clone the current actual application source,
run real npm ci and Next build through Linux cgroup/Windows Job ownership, hash
complete build/dependency artifacts and require the tracked checkout still to
match its selected commit. Each owned command has a ten-minute deadline; the
job has a 25-minute ceiling. Only a small allowlist of OS environment variables
plus explicit isolated build settings reaches the application; GitHub tokens
are not passed to build subprocesses. These are actual application **build**
gates, not first-install/update/restore or HTTP/data acceptance gates.

Actual application run 36585216792: ten jobs passed, including Linux real npm
ci/Next build plus complete artifact observation and source cleanliness.
Windows also finished npm ci/build but artifact capture refused Next's
`.next/node_modules/better-sqlite3-*` absolute internal junction.

Artifact observation opts into internal Windows absolute links only: resolve
the canonical target, require it strictly inside the same project, require it
in the captured non-cache inventory, then hash its project-relative linkage.
Default snapshot behavior still rejects absolute links; Windows restoration
must explicitly implement its native link/ACL semantics before enabling them.
Regression covers default refusal, accepted internal dependency junction,
dependency tampering, outside-project target and uncaptured cache target.

Actions 36587582415 accepted de94a9f in all eleven jobs, including real
application source installation/build and complete artifact checks on both
Linux and Windows. This is not complete deploy/update/restore acceptance.

### Durable accepted deployment receipt

`deployment-receipt.mjs` publishes private `deployment.json` only under the
original application lock, matching accepted state/target, and a caller's fresh
source/artifact/config/service identity checks. The bounded record contains
hashes, project/operation identity and acceptance time, never credentials.
Publication stages, fsyncs and renames under repeated state/lock/file identity
checks. Identical completed publication is idempotent; matching interrupted
staging can resume only after fresh acceptance, while malformed/foreign staging
is preserved and refused. Windows rename durability has the existing platform
limit (no directory fsync).

The receipt primitive does not establish runtime health itself. Controller
composition must supply real identity/health checks, publish before retiring
its lock, and never treat a receipt alone as current-state verification.

`captureLinuxDeploymentAcceptance` supplies the native receipt checker: retained
Git metadata and complete build/dependency artifacts, effective configuration
file hashes/absence/permissions, installed service generation identity, and
owned HTTP provider readiness are rechecked together. Configuration values are
not serialized into the receipt. Checks accept fresh per-stage signals rather
than holding an expired capture signal. Native systemd coverage requires a
healthy provider response before publication and refuses unhealthy responses
or artifact drift even if a previous accepted receipt remains on disk.
This binds observed acceptance; prior-source/build provenance must still come
from the controlled build pipeline, not a newly guessed Git HEAD.

Receipt implementation `ac78956` / Actions `36590344899` passed all eleven jobs.
Native acceptance integration `cf49d50` failed before execution because its
parameterized test had a misplaced closing brace; `5b11776` fixes that exact
parse error. The native acceptance result must not be inferred from the receipt
primitive's passing contract tests.

### Existing-running Linux deployment composition

`linux-deployment.mjs` composes the existing transaction with installed-account
source/dependency/build workers, target/config/data admission, pre-stop space
and snapshot-slot checks, complete backup/rotation, unchanged service-policy
activation, owned HTTP acceptance and durable receipt publication. The build
returns retained Git authority, so acceptance does not recapture an unrelated
HEAD after building. Workers seal before activation and are retired through the
existing service handoff, not independently while service evidence still owns
them. Settled preflight refusal unlocks without downtime; pre-source failure
can verify/retire the restarted prior runtime. Post-source failure retains the
complete backup and stops only the new owned generation.
The complete external recovery engine is saved and verified before downtime,
independently of the per-operation worker engine. It remains after successful
retirement so later restore does not import helpers from replaced source.

The internal entry requires a running inspected service, caller-owned lock,
positive readiness wait and explicit additional build-space budget. It does
not implement public argument handling, first install/inactive services,
changed service policy, already-current or cold receipt takeover. Publication
failure after accepted state retains the lock and live evidence; it cannot
claim complete delivery or silently downgrade the terminal state.

The new Actions-only composition gate upgrades a synthetic running service
into the actual current application, including real npm ci/Next build and
native activation/receipt/retirement. A second case refuses an unsupported
target before downtime and checks settled preflight cleanup. This is not the
historical application upgrade, second update, restore or API-data continuity
gate; those remain required independently.

The first native composition run reaching the controller (`3c7bdb0` /
`36596723621`) passed unsupported-target refusal and exposed two integration
mistakes. The synthetic source must retain the same tracked `agents.json` as
its target; otherwise the source policy correctly refuses configuration changes
before installation. Service retirement transfers authority to worker
retirement: call `workers.retire()` after `stopped.retire()`, not merely
`workers.close()`, before unlocking. The latter leaves evidence that correctly
blocks release. Keep both failure-path contracts to exercise this ordering.

`9f6bf70` / `36597940934` passed all three native failure-path contracts and
the eleven existing jobs. The actual application completed source/install/build
and activation, then correctly failed strict readiness on provider mismatch.
The reviewed auth route explicitly uses ID `admin-login` (type `credentials`),
not the default ID `credentials`. It always registers that provider even when
admin login is disabled; OAuth-only installations still advertise it.
Correct the compatibility prediction and all native fixtures to that exact
profile, while separately requiring at least one enabled login mechanism.
Readiness retains exact provider-set/type matching, owned-listener admission
and refusal of the wrong default ID. No application auth changes are needed.

Extend the composed real-application case through the saved external restore
entry from `/`, with a minimal environment. Require the previous source commit,
owned provider readiness, unchanged retained backup and released lock afterward.
The synthetic old package has no build script or lockfile, so restore must use
its saved runnable source rather than install/build. The old deployment receipt
remains historical evidence while state becomes `restored`, not `accepted`.
This tests the composition-to-recovery handoff; it still does not establish
historical application/database continuity.

### Self-contained Git object payload

`65bf0bd` / `36600220171` passed all twelve jobs, including composed application
deployment followed by saved external no-build restoration. Object causal
`1deabdf` / `36602661062` then failed both contract platforms as intended:
no object descriptor, accepted external alternates, and Linux restored HEAD
without the deleted packed objects needed by `git show`.

`git-objects.mjs` reuses the existing complete snapshot copy/hash/inventory
implementation for a single nested `git-objects` payload. Its manifest digest
and total bytes are bound into the application manifest; nested payloads cannot
contain further Git payloads or external files. Capture accepts canonical loose
objects and complete pack/index pairs (optional rev/bitmap), rejects links,
alternates, promisor packs, writer files and unsupported auxiliary layouts,
and rechecks original bytes before the outer completion marker. Both snapshot
and deployment/restore capacity calculations include object storage. The saved
recovery closure includes the helper, so offline recovery has no checkout import.

Linux restore adds missing objects before publishing HEAD/index, preserves newer
objects and refuses differing existing object bytes instead of overwriting them.
Private staged copies are checked, metadata-restored, synced and exclusively
linked into place. Reentry handles a complete staged file and the linked-but-not-
unlinked publication window. Incomplete stages remain explicit recovery blockers;
this is not yet automatic recovery from death at every byte of object copying.
Existing metadata-only snapshots remain readable and retain their old object-
availability limitation. This preserves the captured object store; it does not
claim a new Git connectivity audit of arbitrary already-corrupt repositories.
Exclude `objects/info/packs`, Git's derived dumb-HTTP pack listing, from the
payload and restore. It is not an object and may change during repacking;
restoring an old listing would incorrectly describe a newer additive store.
Other auxiliary entries remain explicitly refused with their relative path.
Restore also refuses newly introduced alternates/unsupported layouts before
mutation. Boundary contracts cover complete staging, linked publication,
partial staging and conflicting destination objects without changing HEAD or
the worktree on refusal. Extend the real-application saved-entry case by
removing its live `.git/objects/pack` before invoking the external restore;
both the restored prior HEAD and the later target commit must then be readable
from recovered local objects without a fetch.

`006b22e` / Actions `36688729210` passed all twelve jobs, including the real
saved-entry missing-pack case. Add a second current-application update before
restore: log in through real CSRF/credentials endpoints, persist and read a
conversation, update to a distinct commit with the same reviewed source tree,
verify data survives and the one retained backup now refers to the first
application revision. Rename the conversation after that snapshot, restore
with the saved external entry, and require the old name/messages plus the
first application commit. This exercises SQLite/API continuity and backup
rotation but is not the exact historical-baseline or Windows lifecycle gate.
Add the same API sequence using exact reviewed baseline
`638c553c62406dbb7e6b5aeb41cdddf4cd6de179` as the first real application,
then the current target, then saved no-build restoration to the baseline.
The baseline's tracked `agents.json` blob matches the current target, so this
does not bypass the deliberate tracked-runtime-configuration refusal.
The initial service remains a synthetic bootstrap: first-install/public
wrapper acceptance and all Windows lifecycle acceptance remain outstanding.

`6133391` / `36709970036` passed all twelve jobs, including authenticated chat
API continuity across a second current-source update and saved rollback. The
exact historical variant is separately pending; do not infer its result.

### Native artifact-aware already-current

The native controller retains the previous terminal state before starting its
owned inspection operation. Only update with equal resolved/current source,
an accepted prior receipt, complete matching artifacts, configuration and
owned runtime readiness can skip. Missing provenance/artifacts or changed
artifact identities takes the ordinary update path; inspection failures remain
errors. Recheck the acceptance and unchanged receipt after sealing workers.

The native inspection itself has owned workers and needs a durable terminal
outcome for safe retirement: add `already-current` only from preflight, for a
running update with equal non-null source/target and no error. Keep the original
accepted receipt and retained backup unchanged. Repeated no-ops can use that
terminal state, but failed/restored/unverified states cannot. This differs from
the pure transaction's no-write skip: native ownership evidence is recorded and
retired, while service generation, backup and deployment receipt are untouched.
Real application tests require two consecutive no-ops before the distinct
revision update and subsequent chat-data restore.

Historical run `42e7e92` / `36710043285` reached the 25-minute job limit:
synthetic completed in 219 seconds and current-source data continuity in
773 seconds, leaving insufficient time for historical acceptance. It is
cancelled, not a passing historical gate. Separate the three independent
scenarios into Actions matrix jobs, each retaining the same 25-minute ceiling
and failure contracts. Do not raise stage deadlines or retry the interrupted
scenario into an assumed success.

Acceptance checkpoint: `f41b4f5` / Actions `36713981704` passed all 14 jobs.
The isolated historical scenario deployed exact
`638c553c62406dbb7e6b5aeb41cdddf4cd6de179`, authenticated through real CSRF and
credentials endpoints, preserved chat data across upgrade to current source,
and restored the historical source and pre-snapshot chat data through the
external saved entry. Historical and current scenarios both verified two
consecutive no-op updates without service-generation, receipt or backup changes.
The earlier causal run `319c984` / `36711326112` failed both no-op lifecycle
assertions (accepted/new backup instead of already-current/no backup) and
both state contract jobs; its Linux build job never acquired a runner after
five attempts and is not application regression evidence.
This accepts the existing-running Linux internal controller, not first install,
public commands, no-wait verification, Windows lifecycle or physical delivery.

### Installed build configuration, before public command wiring

The native controller currently accepts caller-supplied npm environment while
admitting the installed service configuration separately. Bind npm execution to
the same effective systemd/EnvironmentFile/production-dotenv configuration:
expose it through a non-serialized `buildEnvironment` function on the retained
configuration observation. Accept only explicit operational caller settings
(executable search, account/home/temp paths, npm cache and telemetry/CI switches)
or identical installed settings. Refuse conflicting or unconfigured application
settings and unsupported Node injection before downtime, without logging values.
Capture the merged environment during admission, pass that immutable capture to
both npm stages, and keep existing retained file/policy checks through activation.

Add cross-platform configuration contracts and an actual Linux pre-stop refusal.
Observe their failures in Actions before implementation; rerun the full native
current/historical composition afterward. This does not yet provide public
bootstrap, first-install configuration or changed-service-policy support.

Installed configuration checkpoint: `4e8e51c` / Actions `36719176508` passed
all 14 jobs, including real historical/current upgrade and saved restoration.
The causal run `26b11c8` / `36718886265` failed the missing configuration-method
contracts and native conflicting-environment refusal (the old implementation
completed deployment rather than rejecting). Watcher HTTP 502 responses were
monitoring failures only; reconnecting did not rerun validation.

Next native acceptance case: keep the accepted source commit unchanged, add
nonfunctional files to both `.next` and `node_modules`, and require normal
installation/build rather than `already-current`. Assert removal of both files,
a new runtime generation, backup rotation and unchanged chat data; saved restore
must restore the exact pre-update files and data without install/build. Run this
as a separate `rebuild` matrix case under the same 25-minute bound. Keep lightweight
failure cases on the synthetic runner only instead of repeating them per scenario.

Artifact rebuild checkpoint: `96d86ef` / Actions `36729774272` passed all
15 jobs, including same-source reinstall/build/new generation and exact saved
artifact/data restoration. The matrix now executes failure contracts once.

Public Linux command prerequisite: discover the installed npm command from
typed systemd `ExecStartEx`, and Node from the observed main process executable,
not the invoking user's PATH or a guessed version-manager directory. Require
literal npm start, a resolved npm-cli.js, original account/project/generation,
and the existing complete service inspection before returning authority.
Reject inactive services at this running-only boundary without starting them.
Native tests cover nonroot service discovery, wrong project, a direct Node
command and stopped service. Feed discovered authority to the existing native
controller in actual lifecycle scenarios; this is not first-install support.

Discovery checkpoint: `2bb223e` / Actions `36732150329` passed all 15 jobs.
The causal `cbb35c1` / `36731984066` failed exactly the two missing discovery
function tests. Actual source-based lifecycle scenarios now enter through
discovered installed executables.

Next command composition boundary: normalize update arguments before inspecting
the host; derive a private sibling control directory from the canonical project;
inspect status without creating that directory; reject foreign/incomplete state
before acquiring a lock. Discover the running service and obtain npm environment
from retained installed configuration plus account/home/executable-path defaults,
never the controller environment. Use `/usr/bin/git` with a clear prerequisite
refusal if unavailable. Invoke the existing controller under a caller-owned lock,
closing only unchanged pre-transaction admission on failure. Initially refuse
dry-run, verify and wait=0 explicitly before side effects rather than pretending
those unsupported native paths work. Keep this internal until public command
help and supported-mode coverage are ready; first install remains a separate gate.

Command causal run `1f3eca7` / `36735954695` exposed a second, real integration
failure before source inspection: the specified sibling control name for the
space-containing project exceeds the worker Unix socket pathname budget.
Do not shorten the fixture or change the control naming contract. Bind/connect
through a retained root-private control-directory fd at
`/proc/<controller-pid>/fd/<fd>/w-<worker-id>.sock`; keep that fd until the server
has closed and unlinked its socket. This retains filesystem access protection
and socket placement inside control (unlike an unprotected abstract socket)
without putting the complete project path in `sun_path`. Native lifecycle
scenarios now cover this realistic long control path. Missing command-module
failures remain separate expected causal evidence.

The command fixture now configures its npm cache in the service so command
execution needs no caller environment. Accordingly, the dependency-failure
case must make that same installed cache inaccessible to the nonroot account,
not override its location: the latter correctly fails configuration admission
before downtime and no longer tests dependency-stage recovery. Retain its
original dependencies-phase, complete-backup and inhibition assertions.

Public update wrapper slice: `scripts/update.sh` bootstraps the Node controller
without inherited Node injection options; `linux-update-entry.mjs` renders
human/JSON outcomes and nonzero, secret-free failures. Help documents only the
currently supported running-service path and explicitly names unavailable
first-install/dry-run/deferred-verification behavior. Test the actual shell
entry from `/`, pointing newer tools at an external space-containing project,
with deliberately conflicting controller auth/mode environment, twice for
no-op and once for the distinct revision update plus status and saved restore.
The isolated fixture owns the standard `agents-chat.service` name only after
exclusive unit-file creation, so cleanup cannot overwrite a pre-existing unit.

Do not yet admit in-place execution of this public wrapper: some retained
controller modules still have dynamic imports after source replacement.
Require a separate tools checkout outside the installed project until the full
controller has an independently captured module closure. Status/help remain
available without that restriction. Document and test the explicit refusal
instead of allowing historical selection to remove a later-needed controller.

### Removing the in-place controller restriction

Capture the complete flat deployment-helper inventory plus its external
`lib/workflow/workflowSchema.mjs` dependency into a root-private temporary
directory before loading the controller or changing project/control state.
Keep the original relative layout for dynamic imports and file-based worker
bootstrap capture. Reject links, directories, unknown extensions, oversized
files and changing source inventories; recheck all captured bytes before import.
Bound capture memory to one helper file at a time. Run only the copied command
module, retain it through cleanup, and delete only the same owned temporary
directory afterward. An abruptly killed controller can leave this code-only
temporary directory; it contains no config, data or credentials and is not
recovery authority. Permanent recovery helpers remain in the control directory.

An independent Actions case invokes the actual script inside the installed
checkout (no --project-dir), then selects exact historical source that removes
that script and its controller modules. Require completed acceptance, unchanged
chat data, no remaining worker lock and saved restoration to the prior current
source. Read-only status/help must not capture or write temporary helpers.

In-place checkpoint: `b3f9c50` / Actions `36744968548` passed all 17 jobs.
The installed public script successfully selected exact historical source that
removed itself and its deployment modules, finished acceptance, and restored the
prior current application and chat data through the saved external engine.

### Public Linux restore command

Add `scripts/restore.sh` with the shared restore parser and mandatory explicit
data-loss acknowledgement. Resolve the canonical project and sibling control,
verify the saved recovery manifest and every declared helper without assuming
the current checkout has the same helper version, then verify the complete
backup and derive its native unit/Node/npm identity. Invoke that saved
`linux-restore-entry.mjs` with its verified manifest digest and bounded JSON
input, never a checkout restore implementation, Git fetch, install or build.
Retain positive stage deadlines, secret-free JSON errors and the standard 3010
readiness contract. Keep the original saved entry/manifest format unchanged,
so this wrapper also works with previously created recovery engines.

Actual external-tools and in-place update scenarios must restore using this
public shell command after deleting live Git pack files, preserving their
existing source/artifact/chat restoration assertions. Missing acknowledgement
must fail before backup inspection or runtime changes.

Public restore implementation `3281e87` is running in Actions `36749424798`.
Causal `f17f07a` / `36749214388` completed with exactly the three expected
missing-shell failures in the acknowledgement, external-command and in-place
scenarios; the other 14 jobs passed.
The saved engine format and helper closure remain unchanged. Additional focused
native admission coverage uses a deliberately different saved helper inventory
without importing it, and rejects checksum, inventory, symlink, permission and
traversal failures plus foreign-project, partial-scope and Windows backups.
Admission must leave control-directory contents unchanged in all these cases.

Public restore checkpoint: `3281e87` / `36749424798` passed all 17 jobs.
Additional admission coverage `b639f6c` / `36751227818` passed all 17 jobs.

### Recovery engine generations across real controller upgrades

The next public command test changes the executing tools' recovery-helper bytes
before the second update. This exposes the existing refusal to save a different
controller over `control/recovery-engine`; same-controller revision tests did
not cover that transition.

- Keep the initial legacy directory intact. Explicit version-change publication
  saves differing helpers in `recovery-engine-<manifest-sha256>`, staged privately
  and atomically renamed only after full verification. Never replace a working
  engine directory or leave the retained backup without its old engine.
- Bind new native snapshots to their engine digest through snapshot version 2
  and a `recoveryEngine` SHA-256 field. Continue reading version 1 snapshots;
  older readers must reject version 2 rather than silently use the wrong engine.
- Public restore verifies the snapshot before choosing its digest-bound engine.
  Version 1 remains attached to the preserved legacy engine. The selected saved
  entry still verifies its own helper closure; current helper inventories cannot
  be imposed on older saved generations.
- Wire native capacity/snapshot capture and retained retirement invocation to
  these directories. Cover changed-controller publication, unchanged legacy
  bytes, repeat publication, digest mismatch refusal, and actual public
  update/restore with source and application-data continuity.
- Before completing this scope, bound obsolete generated-engine retention under
  operation authority while retaining the legacy engine and every engine needed
  by the current backup or active operation. Do not delete unknown staging
  evidence or infer that an unclassified controller has settled.

Generation causal `e07d1f6` / `36797546742` is running; both OS contract
jobs have confirmed the original `Recovery manifest changed` failure.
Implementation `6dc25d8` / `36797701490` is queued. It uses one-file-at-a-time
capture, immutable publication and version-2 snapshot binding; original
version-1 engines remain usable without current inventory assumptions.

Retention causal `2b7afe2` is committed locally, waiting for the pending
implementation to be admitted before push. Its seven focused native tests
require retaining the legacy/current backup engines, resumable unlink, and
refusal of workers, staging evidence, foreign files, symlinks and backup
corruption. The implementation runs only after accepted receipt publication
and service/worker retirement under the current lock. It verifies every
candidate before any rename; a root-private `retired-recovery-engine-<digest>`
directory is the durable deletion intent, its checked manifest is removed last,
and only individually verified flat helper files are unlinked. No recursive
deletion of an unknown helper directory is allowed. The actual command scenario
also creates an obsolete generation and requires native retirement to remove
it while the digest-bound backup generation still restores source and data.
The public target declaration advertises snapshot version 2; compatibility
inspection explicitly supports both version-1 and version-2 declarations.

Generation implementation `6dc25d8` / `36797701490` passed all 17 jobs.
Retention causal `2b7afe2` / `36798962857` is running; implementation
`6ae1da8` / `36800072826` is queued.

Retention acceptance: causal `2b7afe2` / `36798962857` completed with only
the expected missing-retention-module native job failure; 16 other jobs passed.
Implementation `6ae1da8` / `36800072826` passed all 17 jobs, including interrupted
publication/deletion and actual changed-controller update, obsolete engine
retirement, and saved source/data restoration.

### Native public Linux read-only preview

Wire `--dry-run` to the existing `previewUpdate` result contract before any
control creation, lock acquisition, controller capture or worker launch.
Use retained source metadata and bounded read-only Git builtins to inspect
HEAD, locally available explicit commits and local upstream refs. Never call
`git status`, fetch, checkout, filters, fsmonitor, credential helpers or target
code; sanitize Git environment and disable configured fsmonitor/pagers.
Missing local targets remain `null`/pending, and default upstream freshness
always remains pending. Do not represent this as admission or already-current.

Inspect the running installed service/configuration read-only, estimate source,
artifact, data and Git-object backup bytes plus metadata and build headroom,
and report planned steps. Database compatibility, dirty-source detection,
target admission, capacity recheck and readiness stay explicit pending checks.
Preserve existing state and receipts, even when previewing an interrupted
operation; never clear or initialize them. Errors remain errors, not previews.

The native regression invokes the public shell from `/` against a non-root
space-containing fixture with no control directory. It checks unchanged Git
index/config and parent inventory, unchanged service generation, no marker
from configured fsmonitor/credential hooks, current/no-pull and explicit local
targets, and unknown default/missing targets with pending checks.

Preview causal `d688103` / `36801369943` is running; implementation `305884b` /
`36802800135` is queued. Additional implementation coverage checks an existing
upstream with an unreachable authenticated fixture URL remains local-only,
never invokes credentials, never prints its token, preserves interrupted state,
omits dependency installation from `--no-install` planned steps, and renders
useful human-readable estimates and pending checks without `--json`.

Preview acceptance: `305884b` / `36802800135` passed all 17 jobs. Causal
`d688103` / `36801369943` had only the expected unsupported-preview failure.

### First-install native inspection boundary

Introduce a real absent-installation inspection, not an object impersonating
a running service. It binds a canonical non-root-owned fresh project, exact
NSS uid/gid/user/home, an absent systemd unit, the external Node-24 controller
and its sibling npm executable, and compatible source dotenv configuration.
Extract the existing NSS account checks from runtime inspection so fresh and
running installations retain the same supplementary-group restrictions.
Read-only missing-unit inspection accepts only a fully parsed not-found
systemd result; other command errors are not evidence of absence.

An existing service, populated control directory, or preexisting `.data`,
`.next` or `node_modules` requires existing-installation/recovery handling,
not a first-install path without a backup. This initial supported first-install
profile intentionally requires a clean non-root-owned source checkout; it does
not chown an existing tree, invent credentials, install tools or execute source
code during inspection. The returned recheck verifies ownership, executable
identity, NSS account, configuration and continued unit/runtime-path absence.
Source/target compatibility and native worker build/activation are subsequent
boundaries; this helper alone does not publish deployment acceptance.

Native Actions regressions cover mutation-free inspection, private-value
redaction, existing runtime/control/service refusal, and ownership/configuration
or runtime paths changing after inspection. Public `deploy.sh` remains legacy
until the absent-runtime build and owned activation paths are fully wired and
accepted; do not expose this helper as a completed deploy implementation.

**Inspection evidence:** causal `691b35d` / Actions `36805437720` completed
with the expected missing-module native-domain failure and sixteen successful
jobs. Implementation `3ecc60c` / `36805525881` passed all seventeen jobs,
including actual missing-unit inspection and existing live-service regression
coverage. The extracted NSS checks did not change accepted runtime behavior.

### First-install owned source/build boundary

Extract the shared source/npm stage implementation behind explicit read and
mutation authority callbacks. Keep the running-service adapter's stopped and
inhibited checks unchanged. A distinct first-install adapter binds the freshly
inspected project/account/toolchain to the current native lock and `deploy`
state with `priorRuntime: absent`; read stages require preflight, selection
requires source-selected, and npm stages require their corresponding phase and
exact target commit. Continued unit absence, account/toolchain/config identity
are rechecked without incorrectly requiring owned node_modules/.next to remain
absent after the first admitted mutation. Initial fresh runtime-path checks
still run before preparing any source command.

The real Actions build fixture clones actual source into a non-root-owned
space-containing directory, creates private auth configuration, validates the
target profile, selects source and runs npm ci/build in existing native owned
workers. It must remain without a systemd service, backup or acceptance receipt,
produce non-root-owned dependencies and BUILD_ID, reject selection in preflight,
and seal all settled workers while leaving the truthful building state. This is
a build boundary test, not a fabricated successful first deployment. Owned new
unit creation/activation, recovery and public deploy wiring remain next.

**Build evidence:** causal `a095b5c` / Actions `36806930830` finished with
seventeen successful jobs and the expected missing `linux-first-build.mjs`
failure in the new first-build job. Implementation
`7a37aa1` plus the absent-unit recheck regression `1c7c242` were pushed only
after causal admission; implementation run `36808073595` passed all eighteen
jobs. The genuine first-build job completed in 52 seconds, including non-root
source selection, dependencies/build and truthful no-service/no-backup state.

### First-install inhibited unit publication

Create the new root-owned unit only from the matching configuring-phase fresh
deployment and sealed worker evidence. Retain a private `service-install.ndjson`
journal before mutation. Exclusively reserve the unit name with an inert empty
fragment, then create the known startup inhibitor before filling that retained
fragment. This avoids inhibiting a foreign unit that wins a name race between
inspection and publication. Never replace an existing file or drop-in directory.
Keep root-source handles and exact bytes/identities.
After daemon reload, inspect actual systemd policy, numeric account,
WorkingDirectory, literal npm start, sole inhibitor, zero MainPID and absent
control group. Every recheck must retain project/account/toolchain/configuration,
lock/state, worker evidence and file identities. No startup, enablement or
deployment acceptance is part of this publication boundary.

Native tests exercise actual unit creation/inhibition and manual-start refusal,
changed source detection, configuring-phase admission and preservation of a
foreign fragment that appears after initial inspection. Interrupted publication
keeps inhibition and journal evidence rather than deleting unknown authority.
Activation/enablement, recovery and public deploy wiring remain subsequent
boundaries; do not present a configured inactive unit as a successful deploy.

**Publication execution:** causal `827c042` / Actions `36810713930` completed
with seventeen successful jobs and the three expected missing-module failures
in the native worker-domain job. Implementation `365433b` / `36810961365`
reached actual publication, but its first positive native test was refused by
the installed-service policy gate; the phase/foreign-fragment cases passed.
The initial error did not expose which policy field differed. The new unit now
explicitly declares `Slice=system.slice` and `Delegate=no`, and policy refusals
attach only the non-secret policy fields involved in that gate. This preserves
the strict gate and makes any remaining mismatch diagnosable; acceptance is
still pending rather than assuming the cause has been proven.

Correction `75cf5b2` / `36812487875` exposed `LoadState: bad-setting`,
not merely an uninitialized slice. The generated WorkingDirectory had reused
ExecStart-style quoting; existing accepted space-containing service fixtures
use the raw path with escaped systemd percent specifiers for that directive.
Publication now follows that form and retains the exact observed path check.
Native fixture cleanup also records a bounded unit journal excerpt on
bad-setting so a remaining parser failure cannot hide behind a generic gate.
The new first-unit tests now run alongside the actual first-build test in the
existing first-install job, rather than waiting for unrelated worker-domain
tests to finish before their logs become available. All tests and eighteen
jobs remain; the six existing lifecycle scenarios and their limits are unchanged.

The corrected `c92669b` / `36813690734` passed all eighteen jobs, including its
real build and all three unit-publication cases. Added cancellation coverage
aborts after durable reserved/created
receipts using the genuine inspection recheck, then verifies that the empty
reservation or inhibited configuration, journal and worker evidence survive,
manual startup remains refused and no acceptance receipt appears. Cancellation
observed after reservation must also prevent the subsequent inhibitor-file
write, not merely stop before filling the fragment. Authority rechecks must
observe cancellation both before and after asynchronous inspection.

Cancellation causal `921478f` / `36814709618` completed with seventeen
successful jobs and exactly the expected reserved-boundary failure: the old
implementation still wrote the inhibitor after cancellation. Correction
`cf5a6a2` / `36815720071` passed all eighteen jobs, including all six
first-install cases (real build, three publication cases and both cancellation
boundaries). No activation, enablement or public deploy acceptance
is implied by these publication-only gates.

### First-install persistent enablement ownership

Enable the generated first unit only through its retained publication handle
and the same configuring-phase lock/state. Persist `service-enablement.ndjson`
before exclusively creating the canonical multi-user.target.wants symlink;
never replace or silently adopt an existing link, even one with the same target.
Bind root directory identities, symlink inode/ownership/timestamps and its exact
target. A metadata-only recheck remains separate from the initial inhibited
configuration check so later activation can retain startup-link evidence.
Reload the manager and require actual `UnitFileState=enabled` while the existing
inhibitor still refuses startup. Keep all evidence after interruption.

Native tests require real persistent enablement without a main process or
acceptance receipt, the exact journal phases, same-target replacement detection
preservation of foreign startup links and retained inhibition/receipt on
cancellation after link publication. The live link uses an O_PATH/no-follow
descriptor so same-target unlink/recreate cannot recycle its retained inode.
First activation and retirement
must subsequently account for this journal; this helper alone is not deploy
acceptance and does not start the application.

Enablement causal `25e595f` / Actions `36819160595` completed with seventeen
successful jobs and exactly the two expected missing-module failures in the
first-install job. Implementation `2ad949a` / `36819553491` passed all eighteen
jobs, including all nine first-install cases. Native execution confirmed
O_PATH/no-follow symlink retention, genuine persistent enablement, same-target
replacement refusal and linked-cancellation evidence without starting a service.

### First-unit activation handoff authority

Preserve the strict configuring-phase `publication.check()` contract. Add
separate read-only `checkSources({ signal })` and `checkInhibition({ signal })`
methods for activation/cleanup: the former retains the original fragment,
configuration, account, executables, operation binding, directories and worker
evidence; the latter additionally requires the original inhibitor at its
canonical name with identical private bytes and retained inode. Moving that
inhibitor to the activation helper's held name must not invalidate the fragment
authority. Restoring its original name may legitimately change link timestamps,
but cannot substitute another inode or change its bytes.

Fresh inspection rechecks accept a call-specific signal, retaining the original
signal by default. Explicit `signal: null` permits ownership inspection during
cleanup after cancellation; it does not waive any identity/configuration check
or authorize service mutation. Read-only handoff checks accept later phases only
within the original operation/target binding. The future activation adapter must
still enforce the specific activation/retirement phase at every mutation.

Native causal cases in `tests/deployment-linux-first-unit.test.mjs` cover an
activating-phase recheck after abort, continued default cancellation refusal,
changed configuration refusal, original held/name round-trip and changed target
refusal. They create neither an activation journal nor acceptance evidence.
Run through the existing Actions first-install job, followed by the full
eighteen-job matrix; do not run these root/systemd fixtures locally.

Handoff causal `2082d51` / Actions `36820627760` reached the native first-install
job with exactly the two expected `publication.checkSources is not a function`
failures. The implementation preserves strict configuring checks and separates
read-only fragment/inhibitor inspection; full implementation acceptance remains
pending.

### Genuine first-unit activation and owned stop

Add `linux-first-activation.mjs` as an adapter from the original publication and
enablement handles to the shared activation/owned-stop engine. Inspect the
actual inactive systemd runtime account: zero main PID, empty invocation/domain,
and the original project/account/toolchain. Do not manufacture a previously
running generation or stop receipt. Preserve the original lock file/directory
identities, stable operation/target binding, installed fragment, configuration,
startup link and actual inhibited/uninhibited policies.

Only the matching fresh activating-phase operation may begin. Forward
cancellation checks occur before activation filesystem/systemd mutations;
ownership checks used to restore inhibition and stop the captured generation
must not inherit an already-aborted caller signal. Once a start request has
been submitted, settle its bounded activation observation before handling
cancellation through the captured generation's owned stop.

Extend the existing actual source-build test through publication, enablement,
activation and owned stop, preserving its pre-publication absence/build
assertions. Require a real non-root running generation, then stop it after
cancelling the original inspection signal and verify the four durable stop
receipts. A separate native case cancels after the staged inhibitor receipt and
requires intent/staged/reinhibited evidence with no startup or acceptance.
Both run only in Actions. Application readiness, acceptance receipts and the
fresh-install retirement/recovery inventory remain separate follow-on gates;
this initial boundary returns `active-unverified`; accepted retirement is
implemented in the separate boundary below.

Handoff implementation `8fc4368` / Actions `36822115316` passed all eighteen
jobs, including eleven native first-install cases. Activation causal `2e68f32` /
`36823356982` reached exactly the two expected missing
`linux-first-activation.mjs` failures after the actual build and existing
publication/handoff cases. The new adapter and shared forward cancellation
checks now await native and full-matrix implementation acceptance.

Activation causal `2e68f32` / `36823356982` finished with seventeen successful
jobs and only the two expected missing-module failures. Implementation
`be9d913` / `36824967343` reached native execution but refused the idle-job gate
before creating an activation journal. The check incorrectly expected textual
`Job=0`; systemd v255's `src/systemctl/systemctl-show.c` prints an absent job as
an empty property value (while positive IDs are printed numerically).
The correction requires an explicitly present empty Job value, not a missing
field or fallback, and adds non-secret enablement/job observations on refusal.
The original parser still rejects missing properties. Full acceptance remains
pending, including the added real application-readiness gate below.

### First-install application readiness evidence

Extend the actual first-build/activation case with the existing
`captureLinuxDeploymentAcceptance` helper, not an unowned HTTP probe or a
synthetic server. Reinspect the live service and require its full identity to
match the activation result. Verify the real `/api/auth/providers` endpoint
through retained native listener ownership and the originally admitted dotenv
configuration. Bind the selected commit, dependencies, build, configuration and
running generation, then repeat the accepted-identity check before owned stop.
This captures readiness evidence only: assert that no `deployment.json` receipt
exists, and leave accepted-state publication and retirement for their complete
transaction boundary. The additional gate runs in the same Actions job and
reuses its actual source build.

Use `inspectLinuxConfiguration` on that exact running service before capture,
as the existing deployment controller does. This checks actual systemd
environment policy and the main process's startup environment, not only the
original dotenv files. Require matching admitted providers and recheck the
original dotenv identity around acceptance as well.

### First-install accepted retirement and versioned recovery inventory

Add `active.retire({ acceptance })` only for the original live first activation,
matching accepted state and published deployment receipt. Check its captured
application acceptance before handing service authority to retirement. Preserve
the existing owned-stop case and add a separate actual source-build case that
publishes acceptance, retires service/worker evidence and releases the lock
while the same application remains ready and persistently enabled.

Extend the shared service retirement writer with an explicit version 4 first
installation inventory: held inhibitor, activation journal, installation
journal and enablement journal. Do not manufacture or rename a stop journal.
Version 4 binds the persistent startup-link identity as `startup` and requires
the genuine sealed worker inventory. It also retains a non-deletion
`deploymentFile` descriptor binding the original published receipt bytes and
inode across live/cold cleanup. Existing version 2/3 inventories and
restore-specific retirement proofs keep their current contracts.

Extract startup-link retention into `linux-startup-link.mjs`, shared by first
enablement, retirement and its readers. Retain its O_PATH/no-follow descriptor,
root-owned parent identity, exact target and original symlink metadata. The
startup link is a persistent prerequisite, never a deletion-inventory entry.
Verify it throughout service retirement, live unlock, cold service recovery
and final recovery completion; a replaced/missing link must block cleanup.

Wire version 4 through `linux-service-retirement.mjs`,
`linux-service-recovery.mjs`, `linux-live-retirement.mjs`,
`linux-recovery-completion.mjs` and `linux-worker-retirement-handoff.mjs`.
Include the new shared helper in `saved-recovery-engine.mjs` so a saved external
entry remains self-contained through its inherited `workerEngineFiles` list:
`saved-worker-engine.mjs` must include it because service/live retirement are
also worker-engine dependencies. The first activation's retiring authority must
retain the original lock and accepted receipt without re-reading journals
after their authorized deletion; the shared retirement inventory retains those
journals independently until deletion.

The Actions first-install gate requires an exact version 4 live handoff, its
four allowlisted files and startup identity, successful native worker retirement
and live unlock, retained deployment provenance, and continued same-generation
readiness. Add cold/replaced-link interruption coverage before treating the
new recovery path or public first deploy as accepted.

Cold fault fixtures use a real fresh non-root systemd/npm process with a small
synthetic provider endpoint on an ephemeral port; they are not a substitute
for the actual application build/readiness tests above. A child controller
pauses after the service intent, second service deletion, worker intent or live
lock-owner deletion. Kill that exact child, displace the source helper copy and
recover with the saved external entry. Require unchanged accepted state and
deployment receipt, the same enabled runtime generation, idempotent completion
and only the expected remaining control files. Same-target startup-link
replacement must refuse recovery without deleting evidence, both before
service deletion, during live unlock and at final recovery completion. Changed
deployment receipt bytes must refuse cleanup at those same boundaries.

Activation/readiness correction `b2c0655` / Actions `36826279155` and runtime
environment refinement `167b65a` / `36827782744` both passed all eighteen jobs.
Retirement causal `9cc5351` / `36829349378` reached the actual ready-application
case and failed only on the missing `active.retire` method; its other seventeen
jobs passed. Implementation `ddcb071` / `36831858995` passed twenty-two of
twenty-three native cases, including all ten cold recovery/refusal cases.
The remaining real-application retirement failed because Node streams reject
`signal: null`; `a6e0587` uses the acceptance API's existing signal-free recheck.
The saved-worker contract also needs the new startup helper in its exact
expected manifest, preserving the closed dependency-set assertion. Corrected
`b37f037` / `36832899983` passed all eighteen jobs and all twenty-three native
first-install cases. No public first deploy or real-host acceptance is implied
by these internal boundaries.

### Fresh Linux deployment controller

Compose the admitted first-install primitives in
`scripts/deployment/linux-first-deployment.mjs`; keep the running-installation
controller unchanged. Reuse `runDeployment` with genuine
`{ exists: false, running: false, owned: true }`, so no stop journal or backup
is manufactured. Require an empty transaction before recording preflight,
the original absent installation, explicit build-space budget, Git source
selection, admitted target/configuration profile and Node 24. Save recovery
before source mutation. Seal owned workers before publishing/enabling the unit.
Verify the actual activated service, runtime environment and captured
application acceptance before publishing the receipt, retiring service/worker
evidence and releasing the lock. Keep saved recovery provenance.

First add two causal native cases to
`tests/deployment-linux-first-build.test.mjs`, sharing the genuine non-root
clone fixture in `tests/deployment-linux-first-source-fixture.mjs`. Keep all
real application cases in the same test file so their fixed port 3010 is not
used concurrently. The successful call is:

```js
await runLinuxFirstDeployment({
  installation, control, lock, git: '/usr/bin/git',
  environment, port: 3010, deploymentBytes: 2 * 1024 ** 3,
  noPull: true, signal, onProgress,
});
```

Require accepted/no-backup output, all seven phases, non-root built artifacts,
matching deployment receipt/native generation, persistent enablement, real
readiness and only state/receipt/recovery-engine after unlock. The second case
cancels on the dependencies phase: require no runtime/artifacts/backup/receipt,
retained original lock and recovery-required state, cancellation code and an
explicit no-previous-backup diagnostic. Cleanup must use independent inspection
after cancellation; never claim a prior runtime was restored. Publication or
activation uncertainty retains its journals and lock. No-wait and skipped
first dependency installation remain rejected, not silently accepted.

Run the unchanged eighteen-job lifecycle workflow in Actions after pushing the
causal tests, then implement the controller after the missing-module failure.
Require the corrected full matrix before calling this internal controller
accepted. Public deploy/bootstrap and failed-first-install recovery commands
remain separate unfinished integrations, not implied by this controller gate.

Causal `702bc54` / `36833848806` passed the original twenty-three native cases
and failed only the two new controller cases with the missing controller module.
The implementation composes the existing transaction, real source workers,
first-unit lifecycle and version 4 retirement. Shared filesystem budget
accounting is extracted to `linux-deployment-capacity.mjs` for both controllers;
same-device requirements remain summed rather than independently admitted.
Invalid zero space/no-wait/skipped-install options must leave even preflight
state unwritten. First-deploy errors retain the original evidence and explicitly
report that no previous backup exists. Implementation `811c6d2` / `36835461914`
passed all eighteen jobs and all twenty-five native first-install cases.

### Public Linux deploy entry

Preserve the accepted update command behavior while sharing its control
admission and CLI presentation with deploy. Move common admission into
`linux-deployment-command.mjs` and leave named update/deploy wrappers in
`linux-update-command.mjs` and `linux-deploy-command.mjs`. A deploy with a
genuinely absent unit uses `inspectLinuxFirstInstall` before creating control
files, then the accepted `runLinuxFirstDeployment`; an existing running unit
uses `runLinuxLiveDeployment` with `operation: 'deploy'`. Never treat an inactive,
failed or conflicting existing unit as a fresh installation. Keep update's
already-current semantics exclusive to update.

Share entry rendering and sanitized diagnostics in `linux-command-entry.mjs`,
called by thin update/deploy entry modules. Extend controller capture with an
explicit allowlisted deploy/update command choice while preserving its default
update entry and complete source-inventory checks. Replace legacy `deploy.sh`
with the same Node-checked, environment-scrubbed shell boundary as `update.sh`.
Help/status remain read-only. Deferred verification/no-wait remain explicitly
unsupported; reject fresh skipped dependencies and unsupported deploy preview
before creating operation files. Do not bootstrap packages or infer permission
to alter accounts/configuration in this command layer.

Add a native public-command case to the existing first-build test file, after
the three sequential real builds. Require the deploy module before executing
the legacy script so the causal test cannot invoke an unsafe legacy deployment.
Use a fresh non-root source checkout, the public default unit, and a private
dotenv npm cache for the fixture's NSS account. Invoke the checkout's actual
`deploy.sh` from `/`, testing read-only help/status and invalid flags before
deployment. Require one JSON accepted/no-backup result, durable accepted state,
retired evidence, persistent enablement, actual owned application readiness,
matching receipt and idle public status. Cleanup binds the fixture unit and
the original or current validated lock owner; never remove unrelated units.

Push this causal test and require its missing-module failure in Actions before
implementing the public layer. Preserve all existing native and contract gates.
Public fresh-to-update/second-update/restore data continuity, remaining runtime
modes, prerequisite assistance and genuine Windows lifecycle acceptance remain
subsequent gates, not claims made by this initial public-command case.

Causal `765cfff` / `36838567962` passed the previous twenty-five native cases
and failed only the new public case at the missing deploy-command module.
The public implementation now uses a shared command/entry boundary, explicit
captured entry selection and the native shell wrapper. Preserve the update
entry's existing minimum-version behavior; deploy requires Node 24, matching
fresh inspection. The first public fixture uses an isolated real non-root NSS account and home,
with isolated npm cache supplied through private admitted dotenv, never by
inheriting the root controller environment. The internal fixtures retain
their existing uid/gid 65534 and explicit build-home overrides.
First-failure JSON preserves the no-previous-backup diagnostic without exposing
raw exception details.

Strengthen the existing `scenario=command` real lifecycle gate by entering its
initial running-service deployment through public `deploy.sh` instead of the
direct controller. Keep its subsequent update/already-current/restoration and
API/data assertions unchanged, and assert that the initial state operation is
`deploy`. Other scenarios continue exercising direct running-service admission.
Add capture tests for explicit deploy selection, missing entry and unsupported
operation rejection. No matrix cases or timeouts are removed or relaxed.
The corrected public implementation passed all eighteen jobs in
`f821039` / `36841936755`, including all twenty-six first-install cases and the
existing public running-service deployment/update/restoration/data gate.

Implementation `a6d12b5` / `36840741829` exposed the fixture's unsupported
supplementary groups when using GitHub's runner account. Preserve the existing
account policy. The first-install Actions job now creates and removes a
dedicated `agents-chat-test` account with its own primary group and real home;
the public fixture uses its inspected numeric uid/gid. This is CI setup only,
not permission for the production command to alter accounts.

### Continuous public first-install lifecycle gate

Add `tests/deployment-linux-first-lifecycle.test.mjs` and a separate native
`scenario=fresh` matrix cell so its three real source builds and snapshot/restore
operations do not compete for port 3010 or the existing first-build job's budget.
Keep all eighteen existing jobs and their timeouts; the additional cell uses
the same twenty-five-minute deadline. Provision and remove its isolated
primary-group-only account in Actions, with cleanup conditional on successful
creation.

Use a genuine fresh checkout and three distinct real Git commits with different
README fixture markers while preserving reviewed application bindings; create
the two child commits as the runtime uid/gid, without hooks or signing.
Invoke public `deploy.sh --no-pull`, verify actual owned readiness, write a chat
through the authenticated API, and require `update.sh --no-pull` to preserve the
same accepted generation without creating a backup. Then invoke public update
with each child revision, requiring real source builds and replacement of the
single retained backup. Rename the chat before and after the second update to
distinguish current data from retained snapshot data.

Displace the installed checkout's scripts and remove its Git object pack
directory before invoking public restore from independent tools with explicit
data-loss acknowledgement. Require the second revision, README bytes and original
build ID, pre-second-update chat name/message, unchanged retained backup/last deployment
receipt, restored state, clean control inventory and enabled owned service.
This verifies the same installation across the version-4 fresh handoff and
subsequent running-service updates/restoration, not just separate fixtures.
Reuse first-source setup/owned cleanup and extend the HTTP login fixture with
an optional password while preserving its existing default.

### Public first-install failure and missing-backup diagnostics

Add a separate `scenario=first-failure` native cell with its own isolated runtime
account, preserving every existing gate and deadline. Use an actual fresh source
checkout with private authentication configuration and an empty private npm
cache. Set `npm_config_offline=true` in its admitted dotenv to cause real
dependency installation to fail without package downloads or application
startup. Invoke the actual public deploy entry; require a failed JSON result
with no previous backup, no leaked fixture credentials, dependencies reached but
no build/activation, absent service/receipt/backup/data, retained recovery engine
and original operation lock, and `recovery-required` state.

Read public status and attempt a second deploy; require the interrupted status
and explicit recovery-required refusal without changing state, lock or control
inventory. Invoke public restore with acknowledgement and require
`DEPLOYMENT_BACKUP_MISSING`, `backupAvailable: false`, and a clear no-retained-backup
diagnostic without launching saved restoration or altering evidence.

Add native restore-admission coverage that distinguishes a missing backup
directory from an existing backup with a missing manifest. Only the former may
use the missing-backup code; corruption and access errors must remain failures,
not be reclassified as an innocent first install. The diagnostic describes
present availability, not an unsupported claim that an older backup never
existed. Push these causal tests before implementing the focused admission and
CLI rendering change; verify the exact failures in Actions.

Causal `a8610aa` / `36844611479` first-failure job `110316555154`
reached every deployment/status/replay assertion and failed at restore's raw
`ENOENT` instead of the required missing-backup code. Implement a separate
`lstat(backup)` admission check that translates only that lookup's `ENOENT`;
leave snapshot verification errors untouched. Render the stable refusal and
`backupAvailable: false` without running saved recovery.

The continuous gate `1d0029c` / `36844406939` reached accepted fresh deployment
and a verified no-op update, then failed the first explicit source update during
preflight with only a generic public error. Add bounded diagnostic locations to
the public deploy/update error boundary before changing admission. Report only
validated error codes and module basename/line/column from the original or
captured controller directory. Never print exception messages, absolute paths,
native stdout/stderr, or environment values. Bound cause/aggregate traversal to
eight distinct errors and three distinct locations per error; cover cycles,
redaction and lookalike paths in both contract jobs. Keep normal outcomes and
all admission/ownership checks unchanged.

`79ec9e8` / `36846315109` identifies `git-objects.mjs:30` from the first
explicit update's capacity admission: its object inventory rejects an entry.
Before another full build, exercise that same read-only inventory directly on
the prepared fresh Git checkout in the continuous test. Native test failure
will identify the Git-generated relative entry without relaxing production
admission or exposing raw command errors to users.

Characterization `7dcb456` / `36847862638` fails in under a second on
`info/commit-graphs`, generated by the actual Git checkout. Support the exact
Git commit-graph namespace: monolithic `info/commit-graph`, split graph directory,
`graph-<object-width hash>.graph` immutable files, and `commit-graph-chain`.
Continue rejecting alternate stores, promisors, unknown entries and writer locks.
Preserve graph bytes in the existing object snapshot rather than silently
excluding caches or changing the saved exclusion profile.

Restore immutable split graph files with existing append-only object publication.
Restore the two mutable graph pointers only after immutable payloads, with the
same stopped/inhibited authority, canonical parent and regular single-link file
checks used by existing restoration. Retain newer immutable graph/object files;
restore saved pointers (or remove only a pointer absent from the backup), so
single/split/absent layout changes do not leave a stale graph selected. Partial
pointer writes remain retryable from the verified snapshot before activation.
Package the focused graph-metadata helper in the saved recovery engine.

Add actual Git split-to-split, split-to-single, single-to-split, and initially
absent graph restoration tests. Require saved pointer bytes/absence, original
HEAD/content, preserved newer commit objects, `git commit-graph verify` and
`git fsck` in Actions. Unknown graph files and graph writer locks remain failures.
Keep the continuous public test's early read-only inventory check as regression
coverage, then require its entire deployment/update/restore/data sequence.

**Accepted:** `d68e139` / Actions `36848961317` passed all twenty jobs.
The continuous native case `110326034349` passed in 1,150,079 ms: fresh public
deployment, verified no-op, two README-content revisions, independent saved
restoration after checkout-script displacement/Git-pack removal, original
BUILD_ID/source/chat contents, preserved receipt/backup and enabled service.
The privileged Git graph layout/partial-write/hardlink cases, first-install
failure/no-backup/replay refusal, both platform contracts and all eighteen
pre-existing jobs passed. This is Linux continuous lifecycle acceptance, not
Windows installed-task or physical-host/voice acceptance.

### Initially inactive service foundation: retained unit sources

Before adding a distinct inactive/failed-service observation, extract the
existing root-owned unit/drop-in source capture from
`linux-service-inspection.mjs` into `linux-service-sources.mjs`. Running-service
inspection and the later inactive inspector must share the same canonical
parent, regular single-link file, metadata/hash and retained-descriptor checks;
do not duplicate or weaken them. Preserve the existing public
`inspectLinuxServiceSource` export and serialized service identity byte-for-byte.
The new helper owns only retained source handles, check and idempotent close;
it does not load, stop, start or modify a service.

Add native file-proof tests under a uniquely owned `/run` fixture directory:
valid capture, same-inode content change, named-file replacement, links and
writable ancestors, plus refusal after close. Run these before the existing
native worker suite. Confirm a causal missing-module failure in Actions,
then extract the implementation and add the helper to the saved worker
inventory and its exact manifest assertion; saved recovery inherits that list.
Require all existing native live/cold/first/continuous gates afterward.
Public inactive/failed commands remain refused until their distinct empty-domain
authority, source/runtime admission, snapshot/activation and cold recovery
surfaces have been implemented and accepted.

Causal `a5ca5c8` / `36851632603` native job `110334402057` failed on the
missing `linux-service-sources.mjs` import as intended. The extraction now keeps
the old metadata field ordering, source hashing, retained-FD checks and export,
with source handles closed by their own idempotent owner. Add the module to
`workerEngineFiles` and the exact saved-worker test inventory; saved recovery
inherits the dependency. No public inactive-service behavior is enabled yet.

### Read-only initially inactive/failed service observation

Add `inspectLinuxInactiveService({ unit, project, npm, node, signal })` in
`linux-inactive-service.mjs`. This internal boundary takes explicit executables;
public executable discovery and mutating deployment admission remain separate.
Require a loaded supported persistent policy, configured NSS/project identity,
zero main PID, inactive/dead or failed/failed state, no pending systemd job or
reported unit processes, no existing inhibition/conditions, unchanged external
executables and retained unit/drop-in sources. Bind the boot and original
runtime/configuration observations. A reported cgroup must be either absent or
retained and provably empty; an unreported but existing canonical unit cgroup
is not adoptable. Recheck sources, runtime/policy, empty domain and executables
before returning and on every check. Close all retained handles on failure.

Return a distinct `kind: 'inactive'` with frozen identity and check/close, never
a fabricated running-service generation. Observation must not start, stop,
reload, rewrite, create control state or change runtime account. Read-only
systemd property loading is allowed, as in existing inspection. Keep public
inactive/failed commands refused until mutation and cold-recovery authority
are implemented.

Extend the existing service fixture with `start = true`, preserving every
existing caller; new tests may request an installed never-started unit. Add
actual non-root inactive and failed service observations, running-service
refusal, later activation/source-change refusal and closed-handle checks.
The failed fixture runs a real exit-42 process with Restart disabled, not a
mocked systemd response. Run these in Actions before the native worker suite;
confirm the missing-module causal failure before implementation.

Retained source extraction `10dc4f0` / run `36851831279` passed all 20 jobs,
including fresh continuous recovery and rebuild. Observer characterization
`c983eb0` / run `36852962320`, native job `110341292269`, passed the seven
source-identity tests and failed precisely on missing `linux-inactive-service.mjs`.
The characterized failing run was cancelled after that evidence was retained,
not counted as full acceptance. Implemented the separate read-only observer
with repeated policy/account/boot/job/process checks and absent-or-retained-empty
cgroup authority. It has no public/controller imports yet, so no saved-engine
closure entry is necessary until a captured entry point consumes it.

Observer implementation `c161b89` / run `36853986228`, native job
`110342266388`, passed the real failed-service and running-service refusal
cases. Never-started cases exposed systemd garbage collection between bus
calls: Manager.GetUnitProcesses refuses an unloaded unit. Use the read-only
Service.GetProcesses object method after validated LoadUnit, matching the
existing policy lookup's lazy-loading semantics. Do not treat a failed query
as an empty process list. That known-failing run is superseded, not acceptance.

Correction `63affab` / run `36854273069`, native job `110343224482`, passed
the initially inactive/failed observation step; the full regression remains
running. Added native refusal coverage for an unreported real cgroup created
before or after capture, preexisting manual-start inhibition, an ExecStartPre
hook, and cancellation before capture or during retained observation. Cgroup
test cleanup checks its own directory identity and only removes that exact
empty fixture directory.

Observer baseline `63affab` / `36854273069` is now accepted: all 20 jobs
passed, including continuous fresh lifecycle job `110343224439`. Expanded
coverage `9982bd0` / `36854856441`, native job `110350857124`, passed its
10-case observation step; remaining regression steps are still running.

### Initially inactive inhibition-policy boundary

Before adding a mutating controller, extend the distinct observer with
`checkInhibited({ stopped: true })` and `checkPolicy({ inhibited, stopped })`.
Keep `check()` strict against the original uninhibited observation. The new
policy checks may recognize only the established owned inhibitor path and
exact expected systemd policy delta; the eventual maintenance owner must
independently retain and verify the inhibitor bytes, lock and journal. Do not
equate a matching policy alone with ownership of that file or transaction.
Stopped checks must retain empty-domain, no-job/no-process, original boot,
account, executable and source proofs. No running original identity may be
manufactured. Static policy-only checks do not authorize stopped work.

Add real inactive/failed inhibition and removal transitions first, including
manual start refusal, ordinary observation refusing the changed policy,
missing-inhibition refusal and original source mutation refusal. The inactive
fixture preserves default Restart=on-failure so the transition exercises its
temporary override as well as the failed fixture's Restart=no policy.
Do not enable public deployment admission or saved cold-recovery decoding
until the corresponding mutating ownership and durable evidence are complete.

The expanded coverage-only run `36854856441` was superseded after its native
observation step passed 10/10 with zero skips; it is cancelled, not a full
acceptance. Production baseline remains the accepted 20/20 `63affab`.
Causal transition `798699a` / run `36856831992`, native job `110351829785`,
passed the existing coverage and failed both added cases exactly on missing
`observed.checkPolicy`. Implemented the separate static-policy and stopped
inhibition checks without changing strict original observation or adding
public admission, maintenance mutation, or cold-recovery dispatch.

Implementation `9f83c8f` / `36857300060`, native job `110353224732`, passed
the original coverage and reached both expected inhibited-policy proofs.
Both new cases then exposed an incorrect test expectation: real systemctl
manual-start refusal exits 4, not 1, with the explicit configured-refusal
diagnostic. Assert both that exit code and diagnostic, not any generic failure.
Also check closed/cancelled/invalid-flag behavior for both new methods, and
verify that static policy checks after an actual activation return no stopped
authority while an explicit stopped check refuses the running service.

Corrected `537f273` / run `36857706177`, native job `110354363493`, passed
the 12-case observation/policy gate and the entire native worker job. Full
regression is still running (14 jobs complete, no failures at this checkpoint).

### Initially stopped maintenance ownership

Next add an internal maintenance boundary using durable `priorRuntime: stopped`,
not a caller flag or a fabricated running generation. The observer supplies a
`stopped:<sha256>` identifier of its complete immutable observation, distinct
from both an absent installation and a last failed process's InvocationID.
Require the maintenance state to bind that observation before creating any
inhibition evidence.

Preserve version-1 running-service receipts. Version 2 for an originally
stopped service records `intent`, `inhibited`, `stopped`, without pretending to
issue a stop command or changing an existing failed state. Reject prior-runtime
restart before consuming activation authority. Permit the new deployment to
use the existing owned activation and retirement path. Re-establish read-only
cold inspection of this explicit originally-inactive identity after closing
the original handles; retain all boot/source/account/executable/inhibitor and
empty-domain checks, without interpreting PID zero as a historical process.

Native tests first cover actual inactive and exit-42 failed services, durable
truthful receipts, no invented backup, forbidden prior restart, cold inspection,
and new-generation activation/retirement. The quiescent fixture is shared with
the existing observation tests and now asserts real ExecMainStatus=42, already
confirmed in prior native logs. These are service-maintenance tests, not full
source builds or dead-owner restore acceptance. Public inactive admission and
cold transaction/lease dispatch remain gated until their own integration is
complete. Add the inactive helper to the saved worker/recovery closure when
the maintenance module begins importing it.

Inhibition baseline `537f273` / `36857706177` passed all 20 jobs.
Maintenance characterization `0e9f3c2` / `36858987878`, native job
`110360283434`, passed the existing observation gate and failed all three
maintenance cases on the missing stopped observation identifier.

Implemented internal version-2 maintenance, its bound opaque observation ID,
prior-restart refusal before activation is consumed, and originally-inactive
cold inspection. The observation now also records the cgroup hierarchy's
device/inode. Cold inactive proof rechecks that hierarchy, rejects adoption of
an originally absent domain, verifies retained domain metadata when present,
and uses the same no-job/no-process query as live inactive observation. It does
not call processIdentity(0) and mistake null equality for a historical process.
The saved worker inventory and its exact test expectation explicitly include
the newly imported inactive helper; recovery inherits that closure. Added a
native mismatched-observation refusal before any inhibitor/journal creation.
Public command admission and cold transaction/lease decoders remain gated.

Implementation `35097a2` / `36860250623`, native job `110362606413`,
passed actual inactive maintenance/cold proof, failed-state maintenance/cold
proof, and new activation/retirement. Its one failure was the negative test
expecting an unwrapped message: the existing maintenance API correctly uses
`DEPLOYMENT_WORKER_UNSETTLED`, recoveryAllowed=false, with the observation
mismatch as its cause. Assert that complete contract and then verify no
inhibitor/journal was created. Also assert cold hierarchy mismatch and
fictional-process refusal, and that successful activation does not rewrite
the original stopped identity/history. No production error policy was relaxed.

Corrected maintenance `4c1b31d` / `36860809839`, native job `110364552008`,
passed all four maintenance cases and the full native worker job. The overall
20-job regression remains running; 12 jobs had completed without failures.

### Dead-controller recovery of originally stopped services

Extend cold transaction admission to the version-2, three-phase stopped
receipt, binding its full observation identifier to durable state. Preserve
version-1 running receipts and their existing checks. Cold activation from
an originally stopped identity needs a version-2 activation intent with
`priorRuntime: stopped` and the original opaque identifier; never substitute
an empty or old failed InvocationID or pretend the service was running.
Keep running activation intents at version 1. Reentry, readiness, retirement,
terminal state and repeated recovery must preserve this distinction.

Add native tests before implementation: create an actual retained backup,
begin maintenance while the service is inactive or has really exited 42,
pause the controller after durable stopped evidence and kill that controller.
Refuse recovery while its owner is alive. Then admit the dead-owner operation,
restore files, activate, check the versioned intent and finish/replay without
changing the backup or initial runtime history. A separate saved-entry test
displaces installed helpers and checks Git HEAD/index and data restoration.
These use the established lightweight HTTP/provider fixture, not a claim of
new public Next.js deployment acceptance. Preserve running fixture defaults
and share candidate/saved-entry helpers instead of duplicating them.

Implementation sequence for this existing approved recovery scope:

- [x] Push causal native coverage: `55ba1d1` / `36861965468`, queued behind
  the full maintenance regression. Production cold admission is unchanged.
- [ ] Observe its native stopped-service admission failure before changing
  production. Also exercise a killed restorer after durable readiness, reject
  downgraded intent versions/roles and foreign stopped identifiers, and
  reenter completion without replacing the newly activated generation.
- [ ] Share the versioned stop profile/complete-journal reader in
  `scripts/deployment/linux-service-stop-evidence.mjs`; use it in the stop
  owner and both cold decoders. Version 2 must bind
  `linuxInactiveObservationId(service)` to the original state's marker.
- [ ] Share cold activation state construction and exact intent decoding in
  `scripts/deployment/linux-cold-activation-state.mjs`. Use it in the lease
  publisher/reader and terminal proof parser. Version 1 retains a 32-hex
  InvocationID; version 2 retains the parent's exact stopped marker.
- [ ] Update `linux-cold-restore-admission.mjs` and
  `linux-cold-activation-recovery.mjs` to admit only running/stopped originals
  with their corresponding complete receipts. An originally stopped service
  cannot have a prior-runtime activation purpose. Existing previous-activation
  reactivation refusal remains unchanged.
- [ ] Add both new helpers to `saved-worker-engine.mjs` and the exact
  `tests/deployment-saved-worker.test.mjs` inventory. Recovery inherits that
  closure; terminal proof parsing is already a saved-worker dependency.
- [ ] Push implementation; require the native cold gate and all 20 workflow
  jobs to pass without extending deadlines or dropping existing cases.

Maintenance baseline `4c1b31d` / `36860809839` finished all 20 jobs
successfully. Cold causal `55ba1d1` / `36861965468`, native job
`110372329251`, passed observer/maintenance gates and failed all three new
cold scenarios. Both inline cases reached the actual running-only admission
guard after controller death; the saved entry refused recovery as expected.
That characterized run was cancelled, not counted as full acceptance.
Additional test-first `312e1e4` / `36863374044` was pushed only after the
preceding causal run started.

The implementation now shares stop receipt profiles and exact versioned cold
activation intent construction/decoding. Both dead-owner entry paths accept
the matching stopped history, while a fabricated four-phase version-1 receipt
cannot reinterpret a zero-PID observation as originally running. Terminal
proof parsing also validates the intent against its lease, including after
service journals have been retired. Both new helpers are included in the
saved worker inventory, which supplies the recovery inventory transitively.
Native tests additionally cover coherent intent-version downgrades in final
proofs, without relying on a stale checksum alone to reject the change.
Production acceptance remains pending Actions.

Additional causal `312e1e4` / `36863374044` confirmed the missing activation
state helper in Linux contracts (`110373394322`) and the same running-only
admission in all four native cases (`110373394436`), including the killed
restorer child. Cancel this known-failing run after capturing those results;
its cancellation is not a regression success.

Implementation `19c8ded` / `36863844868` passed both platform contracts and
all four native cold tests. Native worker job `110374457135` also completed
its legacy suite successfully; 13 of 20 jobs had completed without failures.
The full regression remains required.

### Configuration admission without a live process

Keep existing running and saved-restore configuration behavior unchanged.
Add an explicit inactive branch to `inspectLinuxConfiguration`, implemented
in `scripts/deployment/linux-inactive-configuration.mjs`, and reuse the typed
unit environment parser/policy from `linux-configuration.mjs`.

- [ ] Expose `startupEnvironment()` from `inspectConfigurationFiles`: a frozen
  copy after EnvironmentFiles but before Next dotenv. Keep it a method, not
  serializable credential data. Add a contract proving that dotenv-only PATH
  does not become startup PATH.
- [ ] Characterize real inactive/exit-42 configuration admission, file and
  global environment changes, unsupported policy and cancellation in
  `tests/deployment-linux-inactive-configuration.test.mjs`.
- [ ] Preserve a bounded supported manager policy: permit default PATH and
  locale names, but require every other global setting to be explicitly
  masked by retained unit/EnvironmentFile assignments. Global authentication
  may override dotenv; do not claim that dotenv masks it, or treat it as a
  backed-up per-service source. Keep PassEnvironment, UnsetEnvironment and PAM
  refusal unchanged.
- [ ] Retain and recheck the typed manager Environment and unit ExecSearchPath.
  Resolve `runtimePath()` from actual startup PATH, then ExecSearchPath, then
  manager PATH; refuse missing, relative or empty-component paths rather than
  borrowing the controller's environment.
- [ ] Preserve `checkFiles()` for post-inhibition work: recheck configuration
  sources/policy without claiming original runtime liveness. Full `check()`
  also rechecks the original inactive service. Add the new module to saved
  recovery closure because `inspectLinuxConfiguration` dispatches to it.
- [ ] Push causal tests, observe precise failures, implement and run the
  unchanged 20-job Actions matrix before accepting public integration.

The v255 source confirms manager-global settings are distinct from the
manager process's inherited environment: `src/core/dbus-manager.c:211-231`
uses `manager_get_effective_environment`; `src/core/manager.c:4138-4149`
merges transient/client environments. `man/systemd.exec.xml:3558-3596`
places DefaultEnvironment/set-environment before unit Environment and
EnvironmentFile. `src/core/exec-invoke.c:4486-4510` inserts ExecSearchPath
before explicit unit/file PATH. These are upstream `systemd/systemd` tag
`v255` references, not assumptions based on the controller shell.

Cold recovery `19c8ded` / `36863844868` completed all 20 jobs successfully.
Configuration causal `d5cbdd4` / `36865031458` failed the new startup method
contract on both platforms; Linux contract job `110381636449` reported
`result.startupEnvironment is not a function`. Native job `110381636163`
passed all preceding maintenance/cold gates, then reached `runtime-process`
refusal in both inactive/failed positives and the masked EnvironmentFile case.
Its global-default negative also failed on that earlier guard instead of the
requested specific policy refusal. Existing unsupported-policy/cancellation
coverage passed. Cancel the characterized causal run, not the accepted cold
regression.

The implementation adds the method without serializing its captured values,
exports the existing typed parser/policy without changing running behavior,
and dispatches only retained `kind: inactive` observations to the new helper.
Saved recovery explicitly includes `linux-inactive-configuration.mjs`.
The native configuration gate now has eleven cases, additionally exercising
owned inhibition, real ExecSearchPath/manager PATH fallback and rejected
relative/empty PATH components. Public inactive executable discovery and
deployment/restore history wiring remain subsequent work.

Configuration implementation `2d29ea8` / `36866688064` passed Linux
contracts, but native job `110384020392` refused normal cases at the new
global-environment boundary. The current logs intentionally contain no
environment values and do not identify the offending variable names.
Add a names-only diagnostic to the first native fixture before changing
that policy; do not guess which runner defaults are present or relax
authentication checks. Public inactive/failed lifecycle tests are being
prepared separately and are not part of this diagnostic submission.

### Public initially stopped lifecycle integration

Diagnostic `4814a5a` / `36867948288`, native job `110388287835`,
identified precisely `LANG`, `PATH`, `SGX_AESM_ADDR`. Keep the production
global-environment policy unchanged. Configuration/discovery/public lifecycle
fixtures explicitly mask `SGX_AESM_ADDR` in their retained unit assignments;
PATH fallback fixtures reapply that mask after resetting Environment.
Do not modify the host manager environment or exempt arbitrary global names.
The shared quiescent fixture accepts optional settings while preserving default
unit bytes. Public causal coverage `394a5b6` / `36868239162` is queued after
retiring the characterized diagnostic. Configuration acceptance remains pending.

Prepared tests preserve every existing matrix scenario and add two native
`linux-deployment` scenarios (`inactive`, `failed`), bringing this later
acceptance matrix to 22 jobs without changing deadlines. They exercise public
deploy/update from a genuinely stopped/crashed service, two running no-op
checks, another initially stopped update, and saved public restore while the
service is stopped. The inactive second update uses the same accepted commit
and must rebuild instead of reporting already-current; the failed second
update selects a different source commit. Both preserve real chat data and
check data restoration after removing Git packs. Failure is induced with
actual SIGKILL and Restart=no from initial unit creation, not by corrupting the
backup's healthy source.

Additional existing synthetic-gate tests require unsupported-target preflight
to release settled ownership without starting inactive/failed services.
Pre-source rotation failure must leave truthful stopped maintenance evidence,
not try a prior-runtime restart. The separate inactive discovery fixture
checks supported PATH discovery, higher-priority candidate appearance,
project-local candidate refusal, npm interpreter refusal and actual main
process executable identity.

Implementation surfaces after configuration is accepted:

Public causal `394a5b6` / `36868239162` reached the original running-only
discovery guard at `linux-service-inspection.mjs:97` in both actual public
entries: inactive job `110389896844` (`update.sh`) and failed job
`110389896868` (`deploy.sh`). Both failed before source replacement. The
configuration fixture correction `41f308d` / `36868715355` remains a separate
required run. Retire the characterized public causal run to admit that correction.

The implementation extracts retained inactive configuration-file inspection so
executable discovery can read startup PATH before creating a complete native
observation, without inventing a service object or PID. It then wraps every
observation authority with configuration and first-candidate rechecks. The saved
recovery closure includes the discovery helper; worker-only paths do not invoke
installed discovery. Running process-image binding was already implemented in
the observed code and is retained rather than duplicated. Public history uses
one validated helper, and saved live restore verifies discovered native fields
against its supplied snapshot-bound input. Read-only stopped preview and
history downgrade refusal gain coverage. Full 22-job acceptance remains pending.

Configuration correction `41f308d` / `36868715355`, native job
`110392090922`, passed all eleven configuration cases, including actual
manager authentication precedence, EnvironmentFile masking, PATH fallback,
owned inhibition and cancellation. Its next discovery gate failed four of six
cases at the characterized running-only guard; the running image-binding
negative passed. The npm-interpreter negative's earlier regex also matched that
guard, so tighten it to require the actual supported-interpreter refusal rather
than counting the earlier pass as interpreter-policy evidence. Retire this
characterized run to admit implementation `dc690ac` / `36869213575`.
The last fully accepted baseline remains `19c8ded` until the full regression
finishes; neither partial success nor cancelled runs replace that baseline.

Integration native job `110393980497` failed one old discovery assertion in
`tests/deployment-linux-service.test.mjs:81`: its unauthenticated stopped
fixture now correctly refuses `NEXTAUTH_SECRET`, not the removed running-only
guard. Update the assertion to that precise configuration refusal and prove
the terminal unit state is unchanged. Do not relax missing-authentication
admission. The real inactive/failed lifecycle jobs are still running; retain
them to collect their full public execution evidence before any cancellation.

**Full public stopped lifecycle acceptance:** `5eb4d81ba967f2cff6be4e0b13192d335a77d455`
/ Actions `36870898113` completed with **22/22 success**. The worker-domain
regression, real inactive and failed public lifecycles, and fresh installation
followed by two updates and saved restore all passed. This replaces `19c8ded`
as the latest fully accepted baseline. No local validation or live deployment
was used.

### Task 5A: Portable Windows task registration parameters

Continue inline under the existing execution approval. This bounded slice does
not claim task process-tree ownership or complete Windows transactional recovery.
Do not run the unsafe legacy deploy body or watchdog port cleanup as acceptance.

**Files:**
- Modify `scripts/install-scheduled-task.ps1`: default principal is the invoking
  Windows identity, explicit `-UserId` stays supported, optional `-NoTunnel`
  becomes a literal action argument; descriptions contain no fixed account.
- Modify `scripts/deploy.ps1`: declare and forward these options when calling
  the task installer. Resolve omitted account/logon/trigger/tunnel settings from
  the actual existing task before comparison; otherwise a newly introduced
  switch could be ignored or overwrite the installed default. Reject foreign
  actions, unsupported principal modes or ambiguous triggers before mutation.
- Modify `scripts/service-watchdog.ps1`: declare `-NoTunnel` and centralize
  child argument construction, preserving a quoted script path with spaces.
- Add `tests/deployment-windows-task-options.ps1`: actual isolated task
  registration with Interactive/logon and S4U/startup, the real deploy installer
  function, and a real inert child launched with the watchdog argument builder.
  AST extraction avoids executing unrelated legacy stop/build paths and is not
  reported as full deploy/watchdog runtime acceptance.
- Modify `.github/workflows/deployment-lifecycle.yml`: add one Windows
  PowerShell 5.1 job (23 total); retain all previous jobs and deadlines.

- [ ] Commit/push causal test and capture native failures for fixed principal,
  unsupported `-NoTunnel`, missing deploy forwarding and missing child builder.
  Run only in Actions:
  ```powershell
  ./tests/deployment-windows-task-options.ps1
  ```
- [ ] Replace the installer principal default and append the switch literally:
  ```powershell
  [string]$UserId = ([Security.Principal.WindowsIdentity]::GetCurrent().Name),
  [switch]$NoTunnel
  $ActionArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$WatchdogScript`""
  if ($NoTunnel) { $ActionArguments += ' -NoTunnel' }
  ```
- [ ] Forward the explicit/default identity and switch through deploy's existing
  installer function:
  ```powershell
  & $InstallScript -TaskName $TaskName -ProjectDir $ProjectDir -UserId $UserId `
      -LogonType $TaskLogonType -TriggerType $TaskTriggerType -NoTunnel:$NoTunnel
  ```
  `Resolve-AgentsChatTaskOptions` takes the native task, absolute watchdog/project
  paths and explicitly bound parameters. Start with current user, Interactive,
  AtLogOn and tunnel enabled for a fresh task. For an existing task, require one
  exact PowerShell watchdog action (with optional literal `-NoTunnel`), one
  AtStartup/AtLogOn trigger and Interactive/S4U principal, then copy all four
  settings before applying explicit overrides. The causal native test registers
  S4U/AtStartup/NoTunnel, proves omitted settings unchanged, proves explicit
  switch-false reenables tunnels and confirms resolution did not rewrite XML.
- [ ] Add and use the watchdog child-command builder:
  ```powershell
  function Get-StartScriptArguments {
      param([string]$StartScript, [switch]$NoTunnel)
      if (-not [IO.Path]::IsPathRooted($StartScript) -or $StartScript -match '["\r\n]') {
          throw 'An absolute literal startup script path is required.'
      }
      $command = "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`""
      if ($NoTunnel) { $command += ' -NoTunnel' }
      return $command
  }
  ```
- [ ] Push implementation, inspect the native job's actual task definitions and
  inert child results, then require all 23 gates. Document this as parameter
  portability, not as full Windows lifecycle acceptance.

Causal `7e2208b` / `36875986837`, native Windows task-options job
`110415425773`, failed all five initial cases as expected: the fixed principal
could not resolve, both explicit registrations silently lost the unknown
NoTunnel argument, deploy lacked UserId and watchdog lacked NoTunnel.
The implementation adds declared switches, literal quoted action/child
arguments, explicit forwarding and read-only existing-task mode resolution.
The native tests additionally exercise preserved modes and foreign action
refusal. The watchdog's current-account WinGet path replaces its fixed profile
path; its touched child-stop calls use TargetPid rather than read-only `$PID`.
Legacy port cleanup and full process containment are not accepted by these
parameter tests and remain part of Windows lifecycle work.

Implementation `7d15008` / `36876306151`, task-options job `110416921219`,
successfully registered the default account but failed exact task-path and
inert-child path comparisons. The read-only resolver also rejected the fixture
action. Capture actual/expected generated fixture paths before deciding whether
this is path spelling or product behavior; do not weaken action matching.
The extracted installer function additionally lost `$PSScriptRoot` when created
from an anonymous scriptblock. Materialize just that real function in a fixture
script under its scripts directory and dot-source it, retaining its real script
context without executing the legacy deploy body.

Diagnostic `7b75cd8` / `36876650020`, job `110418185042`, showed the exact
cause: runner TEMP uses a DOS short-name path, while PowerShell's
`$PSScriptRoot`/`$PSCommandPath` expand it to the long account-directory path.
NoTunnel is present in both registered task modes, and the real child receives
the correct switch. Canonicalize the generated fixture scripts directory using
Node's native realpath (already installed by this Actions job), then derive the
fixture project/root and retain all exact path assertions. Production literal
task matching stays unchanged. The extracted function context correction now
reaches real registration; its remaining mismatch is the same path spelling.

Parameter implementation `86cead5` / `36877088856` passed native Windows
task-options job `110419687837`: all six real registration/forwarding/child
cases and the existing deployment/startup regressions. Preserve the full
23-job run; it remains in progress.

### Task 5B: Read-only native Windows task-definition observation

Do not infer application process ownership or quiescence from Scheduled Task
Ready/Disabled/Running alone. This collector returns `runtimeAuthority: false`;
transaction stop, snapshot and activation still require a later native process
ownership adapter.

**Files:**
- Add `scripts/deployment/windows-task-policy.ps1`: move the accepted
  `Resolve-AgentsChatTaskOptions` function unchanged out of deploy so both the
  command and native inspector use one literal action/account/mode policy.
- Modify `scripts/deploy.ps1`: dot-source that helper after privilege admission.
- Add `scripts/deployment/windows-task-inspect.ps1`: read one root-folder task
  via the local scheduler and CIM. Capture exact XML/security descriptor,
  enabled/state/last-run-result, principal SID and current instance records;
  require stable repeated reads, never register/start/stop a task.
- Add `scripts/deployment/windows-task-inspection.mjs`: validate explicit task
  name/project/watchdog, invoke Windows PowerShell 5.1 with bounded output and
  deadline, freeze the captured evidence and compare fresh observations.
- Add `tests/deployment-windows-task-inspection.test.mjs`: actual Ready and
  Disabled registrations, definition mutation, foreign action, missing task,
  actual inert task startup and cancellation. Stop/unregister only the generated
  task before deleting its fixture directory.
- Modify the existing Windows task-options job to run this native Node test
  after the existing PowerShell 5.1 and script regression gates (still 23 jobs).

- [ ] Commit/push causal tests; expected native failure is missing
  `windows-task-inspection.mjs`, not a task-manager permission fallback.
  ```powershell
  node --test tests/deployment-windows-task-inspection.test.mjs
  ```
- [ ] Implement `inspectWindowsTaskDefinition({taskName, project, watchdog,
  signal})`. Root-task names must match
  `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/`; path arguments must be canonical and
  outside shell evaluation. Use explicit native PowerShell, no user profile.
  Return the exact observation result shape:
  ```javascript
  Object.freeze({
    status: 'definition-observed',
    runtimeAuthority: false,
    identity: frozenEvidence,
    async check({ signal: checkSignal } = {}) {
      // Re-read the same task through the same native collector.
      if (!same(await observe(checkSignal), frozenEvidence)) throw changed();
    },
  });
  ```
  Native admission failures use `DEPLOYMENT_WINDOWS_TASK_UNSUPPORTED`;
  failed rechecks use `DEPLOYMENT_WINDOWS_TASK_CHANGED`; an aborted signal
  retains its original reason. Neither absent tasks nor denied reads become
  successful empty/default observations.
- [ ] Push implementation, require the native cases and full regression.
  XML/ACL/config values must not be printed in ordinary diagnostics. This
  comparison binds a definition, not an immutable task registration identity;
  byte-identical task recreation cannot grant runtime ownership.

Native collector references:
- `https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-getinstances`
  requires flags zero and documents security-context filtering. Require an
  elevated administrator observer; an unprivileged empty list cannot stand in
  for an authoritative task-instance inventory.
- `https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-getsecuritydescriptor`
  supplies task SDDL; request owner/group/DACL (securityInformation 7), not SACL.
- `https://learn.microsoft.com/en-us/windows/win32/taskschd/runningtask`
  identifies EnginePID as the task **engine**, not necessarily the watchdog or
  all its descendants. Capture instance GUID/name/path/state for comparison;
  never use EnginePID alone as a process-kill or backup-safety capability.

**Full Task 5A acceptance:** `86cead5` / `36877088856` completed successfully
with all **23 jobs passed**, including native Windows task options, all original
Linux public lifecycle gates and actual builds on both operating systems.
This is the new fully accepted baseline. Task-definition causal tests
`20c2baf` / `36877649151` were queued without cancelling that regression and
are now admitted.

Task 5B causal job `110429429782` (`20c2baf` / `36877649151`) passed all
existing parameter/regression gates and failed precisely on missing
`windows-task-inspection.mjs`. Implement the shared unchanged task-options
policy, elevated local Scheduler/CIM collector and bounded Node observation.
Freeze nested options and instance records; compare fresh observations without
refreshing the retained baseline. Preserve abort reasons and expose only a
bounded native failure stage, never task XML/SDDL or arbitrary native stderr.
These definitions are read-only evidence, not process, file-content or
immutable-registration authority. Full native acceptance is pending.

Before the next fixture submission, correct description mutation to modify the
returned CIM object's `Description` and call `Set-ScheduledTask -InputObject`.
The documented cmdlet has no `-Description` parameter:
`https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/set-scheduledtask`.
The first implementation run can still characterize all other native cases;
do not replace its required pending slot with this fixture correction.

Implementation `ebb4ea3` / `36880555805`, native job `110431385023`,
passed Ready, Disabled, foreign/missing/invalid task and initial cancellation.
Description mutation hit the already-identified unsupported fixture parameter.
The actual running-instance assertions completed but teardown reached EBUSY:
`Stop-ScheduledTask` returns before the task process necessarily exits.
The inert fixture now writes its own PID/start-time; teardown retains that
specific process handle, validates the start-time identity, stops only the
generated task and waits for that process to exit before deleting the directory.
Do not guess the application PID from EnginePID or silently ignore cleanup.

The corrected `1292374` / `36881067273` native task job `110433256546`
passed all six parameter cases, existing deployment/startup regressions and all
six definition-observation cases. Full regression is retained in progress.

#### Task 5C: original Windows runtime-owner control transport

The existing worker Job owner is tied to a transient CLI and its 30-minute
watchdog; it is not a persistent application service. Keep that worker behavior.
For a service, the original task-side owner must retain the original Job handle,
while later controllers connect to that same owner rather than reopening a Job
by name. Begin with the transport seam, not an unsafe public lifecycle switch.

- [ ] Add native `deployment-windows-runtime-pipe.ps1` to the existing Windows
  task job. Register an isolated S4U task that creates a private first-instance
  pipe; inspect its protected SYSTEM/current-account DACL, reject duplicate
  servers, changed process start-times and a different live server PID, then
  exchange messages with the original task process and join its actual handle.
- [ ] Capture the Actions-only missing `WindowsRuntimePipe.cs` causal failure.
- [ ] Implement `Create(Guid)`, `SecurityDescriptor(PipeStream)` and
  `Connect(Guid, int, string, int)` in `WindowsRuntimePipe.cs`. Use a
  non-inherited, local-only first-instance pipe; identification-only client
  impersonation level; retain the expected process handle across connection and
  compare the native pipe server PID before returning the connected stream.
  Reject empty generations, invalid owners and timeouts outside 1..30000 ms.
- [ ] Require native task acceptance and preserve all 23 regression jobs.

This transport grants no application-runtime/quiescence authority by itself.
Its initial ACL intentionally supports the task account and SYSTEM only; it does
not claim arbitrary cross-account administrator deployment support. Subsequent
Job-owner, inhibition, configuration/ACL and transaction wiring must establish
those separate contracts before changing the public Windows deployment path.

Full `1292374` / `36881067273` regression completed successfully: **23/23**.
This replaces `86cead5` as the accepted baseline.

Task 5C causal `827dbcd` / `36883653509`, native job `110443492278`, passed
the existing parameter, startup and definition gates, then failed exactly at
the absent `WindowsRuntimePipe.cs` import. Implemented the bounded native
transport using `CreateNamedPipeW` first-instance/overlapped/local-only flags
and explicit non-inherited private security attributes. Client admission pins
the expected live process across the native server-PID check and never allows
more than identification-level impersonation. Extended the actual-task fixture
to inspect that token level and reject timeout values outside the supported bound.

Relevant API contracts (not paused research):
- https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid

Implementation `35e9810` / `36887827299`, native job `110455546759`,
passed parameter and definition gates, created the actual task-side pipe, then
failed in the DACL inspection expression. The fixture recorded only a PowerShell
wrapper exception, so retain the base exception type/message for this synthetic
fixture before changing production behavior. No application task was run.

Diagnostic `4a38d4b` / `36888280568`, native job `110457724701`, identified
`Runtime pipe DACL changed during query`: the size-only query and successful
copy returned different required-size values. Buffer-size equality is not a
security-descriptor identity check. Read this bounded descriptor in one native
call into the supported 4096-byte buffer, require success, then parse and return
the validated self-relative descriptor rather than inferring ACL mutation from
two size values. The actual task test still requires the exact protected
SYSTEM/current-account allow-list; that assertion is not weakened.

`82f5034` / `36888882975`, native job `110459647310`, passed the private
exclusive S4U pipe and stale/different-live-owner refusals, then timed out
reconnecting to the fixture server. The fixture created an auto-flushing writer
even for rejected peers that close without a command. Delay writer construction
until a real handshake; do not flush a deliberately closed rejected connection.
Also surface any task-side synthetic failure before cleanup, rather than losing
the diagnostic file when a controller-side operation fails.

Native `f2b5a22` / `36889496744`, job `110461697683`, passed all existing
task options/definition gates and the complete runtime pipe fixture: private
exclusive S4U server, stale/different-live-server refusal, reconnect and
identification-only exchange, bounded absent-server timeout. Full regression is
preserved in progress.

#### Task 5D: task-side retained runtime Job

- [ ] Add `deployment-windows-runtime-domain.ps1` to the same native job.
  Its real S4U task hosts the production domain and accepted pipe transport.
  A Node command exits after spawning a detached file writer. Independent
  controller connections observe the original Job; disconnect must not stop it.
  Explicit stop must join the original launcher and establish an empty original
  Job before retirement. Abrupt task-owner death must stop the detached writer
  through kill-on-close without catch/finally, port killing or PID-tree killing.
- [ ] Capture the missing `WindowsRuntimeDomain.cs` causal failure in Actions.
- [ ] Implement a focused disposable domain using existing `WindowsWorkerJob`,
  a gated launcher and original process handles. Add a persistent-runtime
  launcher mode that verifies its original live owner across joining the Job,
  without inheriting the deployment worker's 30-minute deadline. Leave the
  existing worker mode unchanged.
- [ ] Domain observations distinguish command-root exit from domain settlement
  and never claim application health. Stop closes command admission, terminates
  the retained Job, joins the launcher and confirms no remaining Job members.
  Retirement requires that explicit settled state.
- [ ] Require native actual-task acceptance and retain full platform regression.

This is the runtime containment primitive, not public task admission or
transaction wiring. The test host is deliberately not the legacy watchdog.
Configuration/ACL capture, identity publication, restart inhibition, installed
task binding and recovery must still be connected before enabling the public
Windows lifecycle.

Full transport regression `f2b5a22` / `36889496744` completed **23/23**;
it replaces `1292374` as the accepted baseline. Task 5D causal `f241a84` /
`36890274445`, job `110471258768`, passed all existing native task/pipe gates
then failed exactly at the missing `WindowsRuntimeDomain.cs` import.

Implemented the original-handle runtime domain and explicit persistent launcher
mode. Runtime admission validates bounded literal command fields, verifies gated
launcher identity and original Job membership before sending the sole command,
and distinguishes root exit from empty-Job settlement. Independent observers
cannot acquire or release the Job handle. Stop/observe/retire retain it until
confirmed empty; disposal and owner death use kill-on-close. Existing deployment
worker mode keeps its original finite owner watcher.

`d87d02a` / `36892813217`, native job `110472974310`, passed the complete
task/pipe gates and both real task-side runtime scenarios. Detached writers
survived their root and observer disconnection, remained in the original Job,
and stopped after both explicit retained-Job settlement and abrupt owner death.
The full regression is preserved. Added exact literal argv/environment,
pre-settlement retirement refusal and repeated-stop evidence checks to protect
the domain's additional serialization and state transitions.

#### Task 5E: bounded identity-scoped runtime control protocol

- [ ] Replace the actual-task fixture's unscoped line-command loop with
  `WindowsRuntimeControl`. Preserve both Task 5D scenarios and their literal,
  early-retirement and repeated-stop assertions.
- [ ] Require exact request version, generation, original owner PID/start-time,
  unique request ID and method. Send stale owner, different generation,
  pre-settlement retirement, duplicate fields, oversized frames and idle peers
  to the real S4U task. Each refusal must leave the retained Job running.
- [ ] Capture the missing control helper causal failure in Actions.
- [ ] Implement bounded UTF-8 newline frames (8192-byte requests, 131072-byte
  replies), a five-second per-connection request deadline, explicit refusal
  logging and safe disconnection. Unknown/malformed peer input must not dispose
  the service's retained Job. Actual settlement failures remain errors.
- [ ] Client exchanges use the accepted native server-identity check, an overall
  bounded deadline and exact response-envelope binding before returning results.
  The server admits only observe/stop/retire; no peer can submit a new executable
  or command grant.
- [ ] Require the actual-task native cases and preserve full regression.

The future installed-runtime host must additionally bind the verified private
configuration and Scheduled Task admission; protocol scope alone does not
authorize snapshotting, task mutation or declaring the application healthy.

Full domain runs `d87d02a` / `36892813217` and strengthened `4267c9d` /
`36893550797` both passed **23/23**. The latter is the accepted baseline.
Task 5E causal `f3ced0e` / `36895889911`, job `110491595995`, passed earlier
native gates and failed exactly at the missing `WindowsRuntimeControl.cs`.

Implemented the scoped control listener/client. Peer request parsing and
transport refusals are separated from actual domain operations: malformed,
oversized, disconnected and timed-out peers produce bounded diagnostic reasons
without closing the Job. Stop/retire operate only after exact scope admission.
Clients bind response IDs and strictly validate phase, exit code, members and
the explicit absence of application-health authority within an overall deadline.

`ef56a46` / `36898949657`, native job `110493522572`, passed prior task and
pipe cases, then the first scoped exchange received EOF. The server disconnected
immediately after writing; Windows explicitly discards unread data on
`DisconnectNamedPipe`. Keep the reply connection until the client closes after
reading, within the existing five-second deadline and bounded trailing-data
budget. Do not use unbounded `FlushFileBuffers`/`WaitForPipeDrain`. Add a
deliberately delayed reader to require reply retention, and keep internal
oversized-reply errors distinct from expected peer transport failures.
Reference: https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe

`678bf65` / `36899487674`, native job `110495229277`, stopped at C# compilation:
`InvalidDataException` is not an `IOException`, making the defensive catch
filter statically impossible. Remove that redundant filter; internal frame-size
errors already propagate separately from the expected transport exception type.
The bounded reply-retention behavior still requires native acceptance.

`aa7afa4` / `36899837236`, native job `110496482115`, passed all task, pipe
and original-domain cases including scoped malformed/idle refusals and delayed
reply retention. The full 23-job regression is preserved in progress.

#### Task 5F: retained private runtime configuration file

- [ ] Add native file cases in `deployment-windows-private-file.ps1`: exact
  bytes/digest, read-only retained handle preventing write/replacement, changed
  ACL detection, foreign-reader ACL refusal, hard/final-symbolic/ancestor-junction
  refusal, 1 MiB bound, strict UTF-8 and disposed-handle refusal.
- [ ] Capture missing `WindowsPrivateFile.cs` in Actions.
- [ ] Implement a focused native file capability: open the literal final file
  with reparse-point handling and read-only sharing; validate original-handle
  type/link count, canonical final path and private owner/DACL; hold the handle
  through checks and expose only validated exact content. Use the existing
  bounded single-read security-descriptor pattern, not size-query equality.
- [ ] Rechecks compare original handle metadata, resolved path and owner/group/
  DACL metadata. A changed permission policy is a refusal even while bytes remain
  locked. Require matching SHA-256 before returning the retained object.
- [ ] Run native permission/link cases and preserve full regression.

This prepares private managed startup configuration admission. It does not yet
claim arbitrary application-file ACL backup/restoration, immutable parent ACLs,
or a complete installed task/runtime configuration contract.

Full scoped-control regression `aa7afa4` / `36899837236` passed **23/23**.
Task 5F causal `9544619` / `36900623467`, job `110505189075`, passed prior
Windows gates and failed exactly at the missing `WindowsPrivateFile.cs`.

Implemented the retained file capability using read-only sharing, explicit
final-reparse handling, original-handle metadata/canonical-path checks and
bounded owner/group/DACL admission. Checks reread and hash original-handle bytes
as well as metadata/permissions; read sharing alone is not treated as proof
against every possible pre-existing mapped writer. Ordinary concurrent write
and replacement opens are denied. EFS, redirected paths, non-single-linked
files and foreign-read ACLs remain unsupported rather than silently accepted.

`cb63e4b` / `36903126842`, native job `110507417742`, passed existing
Windows gates then refused the positive fixture's permissions. The fixture set
the DACL but never assigned the declared runtime principal as owner. Set its
root and admitted files' owner explicitly to that principal and record the
initial synthetic owner SID to distinguish elevated-token default ownership
from a production policy defect. Do not allow the entire Administrators group
as a substitute for the declared private-file owner.

`50423d5` / `36903793075`, native job `110509665189`, passed all private
configuration cases. The initial synthetic owner was **S-1-5-32-544
(Administrators)**, confirming elevated-token default ownership rather than a
reason to relax production policy. The full regression remains in progress.

Before selecting the managed-host/task binding implementation, add an actual
native instance identity gate to both S4U runtime scenarios. Capture the one
running Scheduler instance and compare its engine PID to the independently
retained task-side owner process, recording the owner's parent PID for bounded
diagnosis. EnginePID is not assumed to be the application; this gate checks
whether the proposed **direct task-owner** binding is actually available on the
native runner. If it differs, retain the failure and design a supported binding
instead of adopting an arbitrary descendant or accepting a name-only match.

Full private-file run `50423d5` / `36903793075` completed **23/23**.
Native owner-binding gate `1307d76` / `36904398034`, job `110517588772`,
passed both scenarios: owner/engine were **7228/7228** and **5208/5208**,
with parent 1908 in both. Thus direct task-instance-to-original-owner binding is
available on this runner; parent PID alone would not distinguish the owners.
Preserve its full regression.

#### Task 5G: read-only retained task-owner binding

- [ ] Extend the same actual S4U scenarios to call
  `Get-AgentsChatTaskOwnerBinding` from `windows-task-owner-binding.ps1`.
  Bind exact retained task XML/SDDL to the one running instance, retained owner
  PID/start-time, actual process account/session and declared executable.
- [ ] Require stale identity, unrelated live process, changed expected XML/SDDL,
  actual task-definition mutation and exited-owner refusals. A stopped Job with
  its owner still alive must retain the same task instance binding.
- [ ] Capture the missing helper causal failure in Actions before implementation.
- [ ] Implement two stable read-only native observations while retaining the
  original process handle. Require elevation, exact root-folder task identity,
  one direct Exec action, supported S4U/Interactive principal, exactly one running
  instance, direct engine/owner PID equality and actual account/image agreement.
  Return explicit `runtimeAuthority:false`: this binding is not app health,
  whole-service quiescence or permission to modify the task.
- [ ] Preserve all native scenarios and the full platform regression.

Full direct-binding run `1307d76` / `36904398034` passed **23/23**.
Task 5G causal `3edc057` / `36906940343`, native job `110524249072`, failed
exactly when importing the missing `windows-task-owner-binding.ps1` after prior
task/pipe gates passed. Implemented the bounded-stage read-only helper with two
stable native observations, retained process handle, exact XML/SDDL, instance
GUID/direct engine PID, executable and actual process SID/session checks.
No task or process mutation is performed by the helper.

Implementation `d696ffd` / `36908786873`, native job `110526485454`,
passed all retained policy/owner checks and earlier Windows gates. The complete
23-job regression is preserved while preparing the next integration step.

#### Task 5H: installed private runtime host

**Files:** add `scripts/deployment/WindowsRuntimeHost.cs`,
`scripts/deployment/windows-runtime-host.ps1` and
`tests/deployment-windows-runtime-host.ps1`; update `WindowsRuntimeControl.cs`
and the existing native Windows task job.

The deployment-owned bootstrap bundle must already be trusted and protected
before its PowerShell/C# loader executes. A self-reported helper hash is not a
code-signing boundary. This step combines retained private configuration with
the accepted task-side Job and control protocol; task policy admission,
restart inhibition, application readiness and public transaction wiring remain
separate requirements.

- [ ] Commit the actual-task test and capture the missing
  `WindowsRuntimeHost.cs` copy failure in Actions. The fixture rejects wrong
  config hashes, duplicate JSON fields and changed helper digests without a
  target write or readiness record. Then it starts a real installed S4U host,
  binds the native instance, and exercises literal argv/environment, blocked
  config/helper/readiness writes, detached ownership, stop and retirement.
  ```powershell
  ./tests/deployment-windows-runtime-host.ps1
  ```
- [ ] Implement one strict private startup configuration:
  ```javascript
  {
    version: 1,
    helpers: {
      "WindowsWorkerJob.cs": sha256,
      "WindowsRuntimeDomain.cs": sha256,
      "WindowsRuntimePipe.cs": sha256,
      "WindowsRuntimeControl.cs": sha256,
      "WindowsPrivateFile.cs": sha256,
      "WindowsRuntimeHost.cs": sha256,
      "windows-worker-launcher.ps1": sha256,
      "windows-runtime-host.ps1": sha256
    },
    command: { file: absoluteExecutable, args: literalArguments,
      cwd: absoluteWorkingDirectory, environment: literalEnvironment }
  }
  ```
  Retain the configuration and all exact bundle files with `WindowsPrivateFile`.
  Derive the bundle root and current PowerShell image from the actual bootstrap,
  not untrusted JSON. Reject missing/extra/duplicate fields and case-colliding
  environment names. Reuse `WindowsRuntimeDomain.Start` for command bounds.
- [ ] Generate a fresh Job/pipe generation for each actual host start. Publish
  `runtime-<PID>-<UTC-start-ticks>.json` alongside the retained configuration,
  using a new private owner/SYSTEM file, flush-to-disk and non-overwriting rename.
  Retain the published file until owner retirement; never overwrite a prior
  instance's evidence. The record includes version, generation, original
  PID/start-time, session, config digest, Job name and launcher PID, not health.
- [ ] Add an optional native `Action` admission check to the control listener.
  The managed host checks retained configuration/helpers/readiness before and
  after each admitted request; existing domain callers remain unchanged.
  Actual admission failures propagate and dispose only the original owned Job.
  Startup logs contain only `Managed runtime startup refused: <stage>.`.
- [ ] Require native host acceptance and preserve the complete regression.
  Keep public Windows deploy/update/restore unchanged until their full authority
  and recovery composition is present.

Task-owner binding `d696ffd` / `36908786873` completed **23/23** and is the
new accepted baseline. Host causal `254ace0` / `36909630133`, native job
`110533977651`, passed all earlier Windows gates then failed exactly at copying
the missing `WindowsRuntimeHost.cs`. Implemented the strict configuration,
retained bundle, original-instance private readiness publication and native
control admission callback. Bootstrap trust and public task/inhibition authority
are not inferred from the configuration's helper hashes.

Private readiness creation uses the atomic-security overload, not create-then-
restrict permissions:
https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemaclextensions.create

`c7d6d62` / `36911686641`, native job `110536177007`, passed every host
assertion, including actual S4U readiness, private file sharing, native task
binding and explicit Job settlement. The step still exited 1 because the last
deliberately rejected native child left PowerShell's global `LASTEXITCODE` at 1.
Clear that code only after asserting the expected native refusal, following the
existing task-options fixture. Add exact refusal-stage checks, unknown fields,
case-colliding environment names and a second actual host scenario that changes
the retained configuration ACL: the next control request must fail, the owner
must exit nonzero and the original detached member must settle.

`9447c36` / `36912341006`, native job `110538391487`, passed all prior
Windows gates and both installed-host scenarios, including exact refusal stages,
case-colliding environment input and actual configuration-ACL mutation. Preserve
its full regression before promoting the accepted baseline.

#### Task 5I: native restart-inhibition premise

Before composing durable task inhibition, extend the real installed-host fixture
with `-Scenario task-inhibition`. Do not infer Scheduler behavior from a mock.

- [ ] While the original writer and owner are alive, set native task `Enabled`
  false. Parse the before/after XML and require that only
  `Task.Settings.Enabled` changed; require identical task SDDL.
- [ ] Capture actual registered-task and running-instance states. Rebind the
  same original PID/start-time and instance GUID using the retained disabled
  definition, not the old enabled XML.
- [ ] Stop and retire the original Job through its bound private control pipe.
  After the owner exits and native instance inventory becomes empty, attempt
  explicit native `Run(null)` and require HRESULT `80041326`
  (`SCHED_E_TASK_DISABLED`), rather than interpreting an arbitrary failure as
  inhibition. Keep task disabled and verify zero native instances.
- [ ] Record native evidence and preserve full regression. If the manager uses
  a distinct registered-task state for a still-running disabled instance,
  support only that observed combination while retaining all original process,
  instance, account and exact policy checks.

This is a premise test, not the complete durable inhibition authority. The
production stop adapter still must retain verified managed configuration and
task policy, durably journal intent before disabling, bind the scoped stop
reply, recheck inhibition before/after mutation and authorize any later release.
No public task is changed by these fixtures.
Reference: https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-error-and-success-constants

Full installed-host regression `9447c36` / `36912341006` passed **23/23**,
replacing `d696ffd` as the accepted baseline. Inhibition probe `963e63e` /
`36913183494`, native job `110547426391`, passed earlier gates but revealed
that native XML omits the default `Settings.Enabled=true` element. Require
effective native enabled state; permit an absent default or one explicit true
element before mutation. After disabling require one explicit false element,
remove only that exact namespaced setting from each comparison copy, and compare
all remaining XML plus exact SDDL. Do not inject an arbitrary element ordering
or interpret a missing default as unsupported task policy.

Corrected `413113a` / `36915717577`, native job `110549602153`, passed the
complete native suite. A disabled task with its original owner still running
reported registered state **4**, instance state **4**, enabled **false**, so the
existing exact owner-binding helper required no relaxation. Stop/retire settled
the original Job, and explicit restart after retirement failed with exactly
`SCHED_E_TASK_DISABLED`. Preserve the full 23-job regression.

The next production integration is durable managed-task stop authority, not a
public enablement flag. Reuse the verified host/configuration, original task
binding and scoped stop exchange. Persist exact original policy and operation
intent before disabling; confirm only the enabled setting changed; retain the
disabled policy and stop evidence while source/data work occurs. Re-enabling or
retiring that authority must be separately state-authorized. Generic Node
`requirePrivateMode` checks ownership/mode only on Linux, so Windows control
receipts additionally need native ACL/file admission; do not reuse that helper
as proof of Windows privacy. The existing installed host already creates its
readiness with atomic private security, flush and non-overwriting publication.

#### Task 5J: shared immutable native private receipt publication

Use immutable per-phase receipts for Windows task maintenance rather than
letting a Node writer append to a file retained read-only by native authority.
First extract the installed host's already-tested publication mechanism into
`WindowsPrivateFile.Publish(file, text)` and strengthen its parent admission.
This also keeps readiness and later stop-intent receipts on one mechanism.

- [ ] Add native `deployment-windows-private-file.ps1` cases and capture the
  absent `Publish` method in Actions. Require exact bytes/hash and a retained
  read-only capability; an existing receipt must never be replaced.
  Oversized or invalid UTF-16 input must create no artifact. Foreign-access
  and junction parents must be refused before writing any file into them.
- [ ] Reuse the existing canonical-path, native handle metadata, final-path
  and private owner/DACL helpers. Retain the original parent directory handle
  without delete sharing across publication. Require a local canonical,
  non-reparse private directory before creating the new file, and recheck
  parent identity/path/security after publication. Directory last-write time
  changes caused by adding the receipt are not identity changes.
- [ ] Create a new randomized sibling with an explicit owner/SYSTEM protected
  DACL at creation, write bounded strict UTF-8, flush to disk, then perform a
  non-overwriting rename. Return the ordinary retained `WindowsPrivateFile`
  after checking its expected digest and parent binding. Do not remove a
  pre-existing target or silently discard failed-publication evidence.
- [ ] Replace only the host's duplicate publication body with this shared API:
  ```csharp
  retained.Add(WindowsPrivateFile.Publish(file, JsonSerializer.Serialize(record)));
  ```
  Keep the same per-original-process readiness filename and exact record fields.
- [ ] Require native file/publication and all installed-host scenarios, then
  preserve full regression before composing durable task-stop phase receipts.

Full inhibition run `413113a` / `36915717577` completed **23/23** and is
the accepted baseline. Publication causal `2988c8c` / `36916848677`, native
job `110558839913`, passed the earlier task/domain gates then failed precisely
on the missing `WindowsPrivateFile.Publish` method. Implemented shared
publication with strict bounded encoding, original private non-reparse parent
handle/identity/security checks, atomic private creation and flush, non-replacing
rename and retained final-file capability. The host now reuses this method
without changing readiness fields or per-original-process filenames.

`9c2c8eb` / `36918992259`, native job `110560511130`, passed the new
publication cases and every installed-host scenario. Preserve its full
regression. Before relying on publication for pre-mutation durable intent,
replace ordinary `File.Move` with native `MoveFileExW` using only
`MOVEFILE_WRITE_THROUGH` (8): flush the data first and require the move itself
to complete on disk, without replace/copy/reboot flags. Require native existing-
file refusal both while the receipt is retained and after its handle closes,
so overwrite protection cannot pass merely because of a sharing violation.
Reference: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw

Both publication runs `9c2c8eb` / `36918992259` and `b1bffbe` /
`36919591641` passed **23/23**. The latter is the accepted baseline.

#### Task 5K: retained native managed-task stop context

**Files:** add `scripts/deployment/windows-task-maintenance.ps1` and
`tests/deployment-windows-task-maintenance-cases.ps1`; extend the installed-host
fixture with `durable-stop` and add its native job step.

- [ ] Capture a native missing-module causal failure before implementation.
- [ ] Implement `Stop-AgentsChatManagedTask -Admission <private-json> -Sha256
  <digest>`. Strict admission fields are version, operationId, controllerPid,
  controllerIdentity, taskName, definition, securityDescriptor, configuration,
  configurationSha256, readySha256, ownerPid, ownerIdentity, generation and
  instanceGuid. Retain the admission, actual config/readiness and original
  controller/owner process handles. Bind the exact managed bootstrap action
  and working directory as well as the native task-owner policy.
- [ ] Refuse stale controller, wrong configuration/generation and changed
  definition before writing any stop receipt or changing the task. Prove the
  original private control endpoint with an observation before inhibition.
- [ ] Publish `task-stop-intent.json`, then disable only the admitted task;
  require the same native instance/SDDL and only an enabled-setting XML change.
  Publish `task-stop-inhibited.json` and `task-stop-stop-requested.json` before
  scoped stop. Require the empty stopped original domain and unchanged disabled
  policy, then publish `task-stop-stopped.json`.
  Each immutable private receipt contains version, phase, operationId,
  admissionSha256, previousSha256, instanceGuid and the applicable task
  definition/security descriptor. The first previous hash is the admission
  digest; later records chain the preceding retained receipt.
- [ ] Return a retained native context. `Assert-AgentsChatTaskStopped -Context`
  rechecks original files, controller/owner, exact disabled policy and original
  scoped empty domain; return `{ stopped=true; inhibited=true }` only after all
  checks. Policy or evidence change poisons the context rather than refreshing
  its baseline. `Close-AgentsChatTaskMaintenance -Context` releases its handles
  but never enables/starts/retires the task or removes receipts.
- [ ] Require native positive/negative cases and retain full regression.

This context establishes native task/domain stop evidence, not the complete
public transaction state machine. The Node adapter still must bind deployment
lock/state and native control-file ACLs, and recovery/activation must separately
authorize any later task definition change or inhibition release.

Task 5K causal `eec2fe7` / `36924121652`, native job `110577099152`,
passed all preceding native cases, then failed exactly while importing the
missing `windows-task-maintenance.ps1`. Implemented the retained context with
strict admission/readiness fields, original process/file handles, exact literal
managed action, native binding and scoped pre-inhibition observation. Stop
publishes four chained immutable receipts around enabled-only policy mutation
and original-domain settlement. Rechecks poison on change; close retains task
inhibition, the task-side owner and on-disk evidence. Native acceptance pending.

`d973e20` / `36924898739`, native job `110580256508`, passed the complete
native suite including pre-mutation maintenance refusals, chained receipts,
original-domain settlement, changed-policy refusal and inhibition after close.
The full regression passed **23/23** and is the accepted baseline.

#### Task 5L: actual Windows application under managed runtime ownership

Before further public integration, exercise the real built application through
the new host and native stop context, rather than relying only on inert writers.
Reuse the existing Windows owned-application build job and its artifacts; do not
perform another install/build or add a longer deadline. Linux behavior stays
unchanged.

**Files:** extend the Windows branch of the actual source build case in
`tests/deployment-native-operation.test.mjs`; add
`tests/deployment-windows-managed-application.ps1` and
`tests/deployment-windows-application-api.mjs`.

- [x] After owned build and operation sealing, invoke the new PowerShell
  fixture with explicit Project, Control and Node paths; capture the absent
  script causal failure in the existing Windows application-build job.
- [ ] Create a private installed bundle, exact helper hashes and host config
  for literal `node <project>/node_modules/next/dist/bin/next start --hostname
  127.0.0.1 --port 3010`. Use synthetic local-admin credentials and a filtered
  runtime environment. Refuse an existing listener; never kill it.
- [ ] Register only uniquely named fixture S4U tasks. Bind actual native task
  owner and private readiness. Wait for a TCP listener whose PID is a member of
  the observed original Job before probing the real authentication provider.
  Recheck native ownership around API operations.
- [ ] First startup: log in through the shared HTTP fixture and create a chat.
  Stop through `Stop-AgentsChatManagedTask`, check original empty domain and
  inhibition, and copy the stopped `.data` into a fixture backup. Retire only
  the generated original owner after closing its maintenance context.
- [ ] Second startup from the same built artifacts: verify the chat survived
  restart, mutate its name through the API, stop/settle and restore the copied
  stopped data. Third startup: require the original chat name/content again.
  All three starts use prebuilt `next start`, no npm/network install/build.
- [ ] After final settlement, require the original full build/dependency
  artifact identity to remain unchanged. Every generated task is stopped,
  original process handles joined, and task registration removed before the
  outer fixture directory cleanup.

This proves actual Windows managed runtime/API/data continuity and prebuilt
restart. It is not claimed as the still-unwired public Windows deploy/update/
restore lifecycle or a production configuration/ACL snapshot implementation.

The causal `9d567ba` / `36926708500` completed with exactly one failing job:
Windows actual application `110588751658`, after its successful install/build,
failed on the absent `deployment-windows-managed-application.ps1`. All other
22 jobs passed. The new fixture implements the three native S4U starts and
stopped data copy/restore sequence above; native acceptance is pending.

`8a9de5f` / `36943041386`, Windows application job `110638737414`, passed:
actual authentication and chat creation, a second prebuilt start and API rename,
stopped-data restoration, a third prebuilt start with the original chat,
original-Job TCP ownership around every API phase, durable stopped maintenance,
and final unchanged build/dependency artifact identity. The job completed in
298 seconds including the one existing source install/build. The full regression
passed **23/23**; this is the accepted baseline.

#### Task 5M: Node-controlled native task maintenance lifetime

Connect the existing admitted stop context to its actual Node controller before
adding public transaction authority. Preserve the exact original-controller
PID/start-time admission; never substitute the short-lived PowerShell bridge.
This is transport/lifetime integration only, not generic lock/state/ACL admission.

**Files:** add `scripts/deployment/windows-task-controller.mjs` and
`scripts/deployment/windows-task-controller.ps1`; use the existing bounded
`workerWire`, process identity and native owner watch. Include both entrypoints
and all native runtime/maintenance dependencies in `saved-worker-engine.mjs`.
Add `tests/deployment-windows-task-controller.mjs` and
`tests/deployment-windows-task-node-cases.ps1`; extend only the existing native
host fixture and native Windows task job.

- [x] Run the causal `node-close` host fixture in Actions: the real Node child
  must fail on the absent controller module before native task mutation.
- [ ] Implement `stopWindowsTask({ pwsh, admission, sha256, signal })` returning
  frozen native bridge identity and `check()` / idempotent `close()`. Require
  native bridge readiness to match actual child identity and admission digest.
  Serialize bounded requests; reject concurrent calls rather than race them.
- [ ] Native bridge retains the original private admission, verifies that its
  controller is the actual parent Node process, then opens the accepted stop
  context. Strict requests are `{ id, method }` with monotonic integer IDs and
  only `check` or `close`. Check original stop authority before acknowledgements.
- [ ] Use original-controller watch and bounded input. EOF, malformed input,
  controller death, timeout or cancellation closes the bridge and retained
  capabilities, never the independent task-side owner, never inhibition and
  never durable records. Failure surfaces as uncertain stopped authority.
- [ ] Actual Node fixture checks successful stop, rejected duplicate stop,
  repeated close and refused check after close. A second real task uses abrupt
  Node `process.exit()` without close. In both cases join the bridge's original
  process handle, require the original task owner still alive and inhibited,
  inspect original stopped/empty Job, and require all four durable receipts.
- [ ] Preserve the full ongoing actual-application regression, then run the
  causal and implementation through Actions without local validation.

The Node causal `bdb649b` / `36943394041`, native job `110643545083`, passed
all preceding native cases then failed exactly on the absent
`windows-task-controller.mjs` import before mutation. Implementation `32bb6da`
adds the bounded native bridge and original
Node identity checks, includes the complete native dependency closure in the
saved worker engine, and retains its independent expected manifest test.
Native acceptance remains pending; generic Windows control-file ACL creation
and lock/state transaction authority are still not provided by this API.

`8b2b2f3` / `36944817058`, native job `110644646715`, passed the full native
suite including normal Node close, abrupt original-controller exit, retained
task owner/inhibition/evidence, duplicate-stop and concurrent-request refusals.
The full regression passed **23/23** and is the accepted baseline.

#### Task 5N: native lock/state authorization for Node task maintenance

The next adapter admits only an already private, original Node transaction.
It must not silently repair production ACLs or treat Node mode bits as native
privacy. Native creation of production control files remains a separate
bootstrap prerequisite; fixtures explicitly prepare their isolated ACLs.

**Files:** add `scripts/deployment/windows-task-transaction.mjs` and
`scripts/deployment/windows-task-transaction.ps1`; extend the existing bridge
with optional pinned transaction references, and the native stop context with
an authority recheck invoked before/after every native observation/mutation.
Include new files in the saved helper closure and independent expected list.
Extend `state.mjs` to block generic lock/recovery operations when
`task-maintenance` evidence exists. Add the focused actual Node transaction
fixture and its private-control fixture helper; extend existing host scenarios.

- [x] Capture native missing-transaction-module failure and the contract test
  showing that an existing task-maintenance directory must block unlock/new
  admission/automatic recovery.
- [ ] Implement `stopWindowsTaskTransaction({ control, lock, pwsh, admission,
  sha256, signal })`. Require canonical external control, current original
  Node lock, admission exactly under `task-maintenance/admission.json`, and
  the matching stopped/restoring state before delegating. Pin original lock
  and initial state bytes by digest for native admission.
- [ ] Native admission retains private lock and configuration capabilities.
  Strict lock fields bind original Node PID/start time, operation and project;
  configuration command working directory must be that project. Strict state
  fields bind operation, project, original runtime generation, running prior
  role and original start time. Refuse wrong phase, foreign ACL, replaced lock
  and changed transaction identity before publishing a stop intent.
- [ ] After original task admission, publish an immutable `transaction.json`
  binding original lock/initial-state digests to admission, operation, project,
  controller and runtime generation. Transactional stop receipts are version 2
  and each references that binding digest. Existing nontransactional version 1
  native receipts remain unchanged.
- [ ] Every stop-context check reopens current private state, permits only
  supported forward maintenance phase transitions, and rechecks original lock
  and configuration. Native admission also checks exact initial state digest.
  Close releases capabilities, never inhibition/evidence or the lock.
- [ ] Actual Node fixture acquires the real lock, writes preflight/stopped
  state, rejects exposed state ACL and a wrong token, then stops the native
  task. Require retained lock write refusal, accepted copying-state advance,
  blocked generic unlock/recovery, normal close and abrupt controller exit.
  A third actual task changes state operation ID and must lose authority while
  retaining original task owner, inhibition and all durable receipts.
- [ ] A fourth actual task exercises original restore admission and its
  `restoring -> restore-activating` maintenance transition without claiming
  application restoration or activation.
- [ ] Run all validation in Actions and preserve the preceding full baseline.
  This still does not claim activation, cold recovery or public Windows
  deploy/update/restore transaction completion.

The causal `cb5bc6b` / `36945367568`, native `110650681417`, passed preceding
native cases and failed on the missing `windows-task-transaction.mjs`.
Linux contracts `110650681159` and Windows contracts `110650681425` both failed
exactly on the missing unlock refusal with task-maintenance evidence.
Implementation `8fa39b0` retains native lock/config
capabilities, checks private state before/after original-domain observations,
records exact initial state text plus its digest in the immutable binding, and
uses version-2 transactional stop receipts. Restore-phase coverage is included
in the follow-up test commit; native acceptance remains pending.

`375ccb7` / `36947168841` passed both contract jobs (`110651862396` Linux,
`110651862278` Windows), including the new generic maintenance guard. Native
`110651862505` passed preceding suites and successfully opened transactional
stop, checked immutable binding/v2 receipts and refused a lock-file write, but
failed its first check after state advancement and fixture ACL preparation.
Add bounded native substage diagnostics and check immediately before/after the
denied lock write to distinguish that from state/ACL advancement; do not relax
private-file or state checks without identifying the actual cause.

Diagnostic `87bf53a` / `36947641592`, native `110653525255`, proved that
checks both before and after the denied lock write succeed. The subsequent
failure is specifically `check/evidence`, not transaction state or lock.
The fixture's recursive ACL preparation rewrote retained immutable native
evidence after advancing the state. Limit that later fixture preparation to
the newly replaced `state.json` only; preserve all original evidence ACLs and
all production checks. This is a fixture correction, not relaxed admission.

`8a90d84` / `36948065624`, native `110654883963`, passed every native case,
including transactional close, abrupt controller exit, changed-state refusal
and restore-phase authority. The full regression completed successfully
**23/23** and is the accepted baseline.

#### Task 5O: isolated default-owner premise for private Node control files

Do not ship the fixture's recursive permission repair as production behavior.
Per-file native publication remains an option, but requires coordinating all
mutable state/journal paths. A narrower candidate is an isolated controller
primary token whose default owner is its existing user SID; ordinary Node
creation beneath a private parent could then be private at creation. First
prove that native premise without modifying any production entrypoint or the
calling process's token.

**Files:** add only `tests/WindowsControllerTokenProbe.cs`,
`tests/deployment-windows-controller-token.ps1`, and its focused child fixture;
append one step to the existing Windows native job.

- [ ] Duplicate the actual caller primary token, alter only the copy's
  `TokenOwner` to its existing user SID, and require unchanged user, privilege
  list, elevation, integrity and session. Use explicit `CreateProcessWithTokenW`
  with no profile/network-logon options and a filtered Unicode environment.
- [ ] Inspect the actual created process token while suspended before running
  the fixture. Require its desired default owner and unchanged permission
  signature. Keep original process/thread handles and finite startup/exit bounds.
- [ ] Child PowerShell must check the original parent lifetime and join the
  existing private kill-on-close Job before starting Node. Node and a genuine
  Node descendant create separate files; no ownership or ACL repair occurs
  after those creations. Require both files to pass `WindowsPrivateFile.Open`
  and the original Job to be empty before fixture cleanup.
- [ ] Confirm the original caller token's default owner and permission
  signature remain unchanged. Reject unsupported privileges/API behavior
  explicitly; do not add credentials, grant privileges or change user policy.
- [ ] Run this characterization only in Actions after preserving the current
  full regression. A passing probe is not yet production control creation,
  bootstrap integration, cross-account support or public lifecycle acceptance.

Native API references used for this bounded premise:
- `https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_owner`
- `https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-settokeninformation`
- `https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithtokenw`

Test-only `f92ca3c` / `36949355622`, native `110660746815`, passed all
preceding native cases but failed the copied-token probe with
`Invalid token information size.` The premise is unverified. Add bounded
information-class/length/native-error diagnostics, not relaxed validation.
The characterized failed run was cancelled so the queued directory causal
`6d15fdc` / `36950325029` can proceed. No production token bootstrap exists.

#### Task 5P: create and retain a private Windows control directory

This implements the approved private external-control requirement independently
of the copied-token premise. Reuse `WindowsPrivateFile`'s existing native
directory identity/security gate rather than copying that logic into a launcher.
Creation must use a protected owner/SYSTEM inheritable DACL in the original
`CreateDirectoryW` call; never create broadly and repair later. Existing paths
are refused by creation and admitted only through a separate read-only open.

**Files:** `scripts/deployment/WindowsPrivateFile.cs` and existing native
`tests/deployment-windows-private-file.ps1`. The saved engine already contains
this source, so no new dependency path is needed.

- [ ] Add native causal coverage using
  `[Deployment.WindowsPrivateFile]::CreateDirectory($createdDirectory)` beneath
  an explicitly nonprivate fixture parent. Assert protected current-user
  ownership, unchanged parent SDDL, exact existing-directory refusal,
  original-handle replacement refusal and successful private publication.
- [ ] Require `[Deployment.WindowsPrivateFile]::OpenDirectory($createdDirectory)`
  to retain an already private directory without changing it. Reject public
  directories/junctions, detect changed ACLs and reject checks after disposal.
- [ ] Push this test first and capture the missing `CreateDirectory` failure
  in the existing Actions native Windows task job, preserving the current
  copied-token run until its premise is observed.
- [ ] Implement a small `DirectoryLease` exposing only `Check()` and
  `Dispose()`, backed by the existing native publication-directory gate.
  `CreateDirectory` pins the explicit `DirectorySecurity` binary descriptor
  in `SECURITY_ATTRIBUTES`, calls non-recursive `CreateDirectoryW`, then
  reopens/rechecks the exact canonical directory. Any collision or failed
  admission throws; never delete a path whose ownership was not retained.
- [ ] Run native acceptance and full Actions regression. Neither this helper
  nor the copied-token probe alone is a production bootstrap or public
  Windows deployment acceptance.

The local implementation also retains/rechecks the canonical existing parent
before creating a child, refusing junction redirection before any creation.
The parent need not be private; the new child always receives its explicit
protected DACL. Token fixture setup will use this native root creation instead
of its permission-repair helper, retaining the root across the child lifetime.

Causal `6d15fdc` / `36950325029`, native `110662059027`, failed exactly on
missing `WindowsPrivateFile.CreateDirectory` after preceding native cases.
The implementation is ready for Actions, including canonical parent retention,
explicit creation-time security, separate directory opening, collision/refusal
coverage and token-probe setup without fixture ACL repair. Token sizing still
requires actual diagnostic evidence; no caller privileges or privacy checks
have been relaxed.

Implementation `40f68ed` / `36950710044`, native `110662852178`, reached the
directory movement assertion after passing creation/privacy/parent/collision
checks. The assertion recognized only file-sharing error 32, whereas directory
movement may report access denied (5). Require an explicit denial (5 or 32),
unchanged original path/no destination and original retained identity; also
require the same move to succeed after disposing the leases. This strengthens
the behavioral observation without changing native access/share policy.
The token diagnostic step was not reached in this run.

`58e148f` / `36951126319`, native `110664145382`, resolved that ambiguity:
the actual directory move succeeded (`moveCode=0`), so this is not an alternate
denial code. The existing directory gate requested metadata/security rights
only. Request `FILE_LIST_DIRECTORY` as well so the retained handle participates
in read/share-delete exclusion; keep no-delete-sharing and every path/security
check intact. Do not weaken the movement assertion or claim directory lifetime
acceptance before the native denial and post-disposal positive control pass.

`35675b5` / `36951592828`, native `110665565637`, passed the entire private
directory/file step and all subsequent runtime/transaction cases. The final
token diagnostic now identifies `class=20, bytes=4, error=24, returned=False`:
`TokenElevation` reports `ERROR_BAD_LENGTH` for a zero-length sizing request.
Read the fixed DWORD-sized elevation/session classes directly with a four-byte
buffer; retain bounded sizing for variable-length classes and validate returned
length before reading any buffer. Do not ignore a failed actual read or change
identity/privilege comparisons. Full regression still awaits a passing probe.
Reference: `https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation`.

Fixed-field commit `be37516` changed only a `tests/Windows*.cs` helper and
documentation, revealing that the workflow path filters covered only
`tests/deployment-*`. Include native C# fixtures in both push and pull-request
filters so isolated helper corrections cannot silently miss Actions.

`25b6033` / `36952267043`, native `110667569892`, passed the directory,
runtime and transaction cases again. Fixed token reads, duplication and the
pre-launch identity/permission comparisons succeeded; failure advanced to
`Create suspended private-owner fixture`. Include the native error number
in the bounded exception message (the previous custom Win32Exception message
hid that number in PowerShell's displayed exception). Do not infer missing
privileges or alter caller policy without the actual native result.
Run this self-contained probe immediately after Node setup, before the
unchanged native task cases, to expose its failure promptly. No case, platform
or deadline is removed; a successful job still requires every existing step.

`d75e07e` / `36952817328`, native `110669295125`, identified creation failure
as Win32 5 (access denied), not a missing-privilege error. Add two bounded,
never-resumed controls only on failure: an unchanged-owner duplicate with the
same private working directory, and the modified-owner token with the known
PowerShell executable directory as working directory. A successful control is
terminated/joined through its original process handle without executing payload;
both native codes accompany the original failure. These diagnostics do not
turn an unsupported premise into success, broaden ACLs or grant privileges.

`a264058` / `36953165393`, native `110670356208`, returned Win32 5 for
both controls as well. Stop pursuing `CreateProcessWithTokenW` for this
bootstrap premise; unchanged-owner and executable-directory controls did
not establish a supported launch path. No production code adopted that API.

#### Task 5Q: distinct suspended child token with spawn-time Job assignment

Keep the approved isolated-owner objective but use ordinary `CreateProcessW`.
Pass the original private Job in `PROC_THREAD_ATTRIBUTE_JOB_LIST`, with
`CREATE_SUSPENDED`, `CREATE_UNICODE_ENVIRONMENT` and
`EXTENDED_STARTUPINFO_PRESENT`. No primary thread runs before the Job and
actual token are checked. This also removes the earlier probe's suspended
process gap before child-side Job attachment.

**Files:** replace the unsupported path in
`tests/WindowsControllerTokenProbe.cs`; remove self-attachment from
`tests/deployment-windows-controller-token-child.ps1`, since creation must
already establish original Job membership. Retain native private root setup
and both real Node file writers.

- [ ] Open the original token query-only and save its token-object ID,
  complete statistics, default owner and permission signature.
- [ ] Create the suspended child with a non-inherited original private Job
  handle in the startup attribute list. Verify original Job membership
  through the retained process handle before inspecting/changing its token.
- [ ] Open only the actual child's token with query/default-adjust rights.
  Require a different `TOKEN_STATISTICS.TokenId`, primary token type and
  unchanged initial owner/user/privilege/elevation/integrity/session values.
  If the token object is shared with the parent, refuse before modification.
- [ ] Set only that child's default owner to its already-existing user SID,
  then recheck its identity/permissions and the unchanged original token
  statistics/owner/permissions before resuming the original primary thread.
- [ ] Run the existing real Node/descendant private-file assertions without
  ACL repair. Original Job assignment is mandatory, not a best-effort fallback;
  process/attribute/token handles and waits remain bounded.
- [ ] Require native success and the complete unchanged Actions regression
  before adopting any production bootstrap.

References: `TOKEN_STATISTICS.TokenId` identifies a token object; the Job-list
startup attribute assigns the supplied Job handles at process creation and is
supported on Windows 10 / Windows Server 2016 and later:
- `https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_statistics`
- `https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute`

`4e8e5cc` / `36953793698`, native `110672262846`, passed the first
distinct-child-token probe: actual child token modification, spawn-time Job,
unchanged original token and both Node writers' native private-file admission.
Native job `110672262846` completed successfully, including every existing
case after the new probe. The full regression completed **23/23** successfully;
`4e8e5cc` / `36953793698` is the new accepted baseline.

#### Task 5R: actual Node control-file creation under the admitted child token

**Files:** extend the existing
`tests/deployment-windows-controller-token.ps1` writer/acceptance and the
child fixture's explicitly filtered Windows PowerShell discovery path.

- [ ] First require actual `control/lock/owner.json`, replaced `state.json`,
  a worker intent journal and the complete saved worker engine. Bind their
  operation ID and original writer PID; require all control directories and
  files to pass native retained privacy checks without permission repair.
- [ ] Capture the missing actual-transaction-files failure in Actions after
  preserving the complete current regression.
- [ ] Have the real Node writer call the existing `acquireLock`, `writeState`
  (`preflight -> stopped -> copying`), `createWorkerJournal` and
  `saveWorkerEngine`/`verifyWorkerEngine` APIs. Use a generated private fixture
  configuration to identify the existing source directory, not synthetic API
  stubs or copied implementations.
- [ ] Provide only the explicit system Windows PowerShell directory on the
  writer's PATH, since `processIdentity` invokes `powershell.exe`. Keep
  SystemRoot/TEMP/TMP filtering and original Job/token checks.
- [ ] Run the native assertions and full regression. This establishes actual
  private persistence creation, not yet a public production controller,
  transaction activation, cold recovery or Windows lifecycle acceptance.

Causal `1ceb564` / `36954162713`, native `110676233230`, is now running after
the preserved full regression completed successfully.
The local writer implementation uses the existing production APIs and an
explicit system PowerShell PATH. On Node failure, its bounded stderr is
retained in a private fixture file and surfaced before rethrowing the native
failure, rather than losing the underlying cause behind the child exit code.

The causal native job failed exactly with
`Missing actual private Node transaction files` after the original simple
file-ownership checks. Implementation `ecd5636` is ready to push with the
accepted baseline documentation; the actual control-file assertions remain
unchanged.

Pushed with documentation at `ddb33dd` / `36955332382`, native
`110677115820`: the first probe step passed, including actual Node-created
lock/state/journal/complete-engine native privacy assertions. The remaining
native cases and full regression completed **23/23** successfully.
`ddb33dd` / `36955332382` is the new accepted baseline. Production controller
bootstrap/entrypoint integration remains the next responsibility.

#### Task 5S: production private controller process with native stdio

Promote the verified token preparation into
`scripts/deployment/WindowsControllerToken.cs` and implement
`scripts/deployment/WindowsControllerProcess.cs`. The process owns a fresh
private kill-on-close Job, retains its private working directory, and creates
the suspended Node process with both JOB_LIST and a strict HANDLE_LIST for
anonymous stdin/stdout/stderr pipes. Do not inherit the Job handle, arbitrary
caller handles or caller environment. Use literal Windows argument encoding,
not a shell or the probe's restricted fixture-only quoting.

The token component is internal to the native helper assembly. It verifies
the caller's unchanged token and prepares only the separately identified
child token before resume. Process creation/containment remains the process
component's responsibility, not a capability of the token component.

**Files:** the two native helpers above;
`tests/deployment-windows-controller-process.ps1`;
`.github/workflows/deployment-lifecycle.yml`;
`scripts/deployment/saved-worker-engine.mjs` and its independent expected list
in `tests/deployment-saved-worker.test.mjs`.

- [ ] Add native causal coverage for the production process API: literal
  arguments and bidirectional JSON frames; current-user private file creation;
  root exit with a still-writing detached descendant; original Job stop/join;
  unchanged marker after termination and native private-directory retention.
- [ ] Capture the missing helper failure in Actions before implementation.
- [ ] Expose bounded lifecycle operations (`WaitForExit`, `Kill`, `Dispose`)
  and actual `Id`/`ExitCode`/`HasExited`, plus stream readers/writer compatible
  with the existing bounded `ReadFrameAsync` helper. Pipe EOF is never Job
  settlement. Stop only the original Job and join it before cleanup succeeds.
- [ ] Validate canonical executable/private cwd, literal arguments and a
  bounded explicit environment before creating a process. Retain native
  handles throughout setup; unsuccessful startup settles the original Job.
- [ ] Include both new helper sources in the saved engine and independently
  specified expected manifest, so restored code does not depend on the checkout.
- [ ] Run native controller acceptance and all existing Actions gates. Then
  wire the real task transaction controller fixtures through this production
  launcher, removing positive-path ACL repair rather than copying it into
  public deploy/update/restore.

Causal `ca20571` / `36957738054` completed with the expected missing-helper
failure: native `110684370436` could not load `WindowsControllerToken.cs`;
Linux contracts `110684370351` reported the same missing saved-engine source.
The implementation now supplies both native helpers, validates the retained
executable and actual process image, encodes literal arguments, restricts
inherited handles to the three stdio ends, and settles only its original Job.
The fixture also proves an independent writer survives controller stop.
Native compilation and behavioral acceptance are pending.

#### Task 5T: native controller integration without positive ACL repair

- First require the actual task transaction's freshly created lock to pass
  native privacy and original-controller PID admission before any fixture
  ACL changes. Capture the ordinary-launcher failure in Actions.
- Launch both Node close/exit and transactional update/restore cases through
  `WindowsControllerProcess`, with explicit system PowerShell discovery and
  creation-time private controller/control roots. The factory retains its own
  process handle; remove the old `Process.Handle` pinning.
- Create the maintenance directory natively. Remove positive-path recursive
  and state-only ACL repair. Keep the negative state-ACL test by saving its
  exact original descriptor, adding the deliberate public-read grant, and
  restoring only that descriptor after the expected refusal.
- Preserve actual bridge identity, original S4U task owner, inhibition,
  transaction receipts, changed-state refusal and cleanup/settlement gates.
  This remains controller integration, not public activation/cold recovery.

Production factory `44016e6` / `36958322571` passed its new native step in
task-options job `110686185122`; full regression is still running.
Causal `a33f461` / `36958473499` is pending behind that preserved regression.
The local integration now replaces the fixture launcher and positive ACL
repairs. It also asserts cwd retention after all controller/foreign writers
have settled, before disposal, so a live child's own cwd cannot satisfy the
factory's directory-retention assertion accidentally. Do not push this
implementation over the pending causal run before capturing its outcome.

After interruption, `44016e6` / `36958322571` is confirmed complete **23/23**.
Causal `a33f461` / `36958473499` failed exactly in native task-options
`110690402568`: opening the fresh transaction lock returned
`Private configuration permissions are unsupported.` Implementation
`30963d7` has now been pushed; integration run `36984627141` is pending.

Integration native `110766719409` passed production controller close/exit
and fresh transaction-lock privacy, then failed the fixture's exact SDDL
restoration assertion. Keep the original Node-created state file untouched:
temporarily rename it aside, create a same-content replacement, grant only
that replacement public read access, and require native refusal. Finally
remove the exposed replacement and restore the original file by rename,
checking its original volume/file identity. No ACL setter touches the file
used by the successful transaction or its subsequent production replacements.

#### Task 5U: production publication of an installed private runtime bundle

Continue inline under the approved Windows bootstrap design. Replace the
runtime-host fixture's ordinary copies and owner repairs with production
creation-time publication. This does not introduce a new account policy or
claim public deployment activation.

**Files:** `WindowsPrivateFile.cs` owns bounded exact UTF-8 source copying;
`WindowsRuntimeDomain.cs` exposes its existing command encoding/validation;
`WindowsRuntimeHost.cs` exposes a copied helper-name list;
new `windows-runtime-bundle.ps1` assembles the immutable installed bundle.
The independent saved-engine list and native fixture must include the new
script. `tests/deployment-windows-runtime-bundle.ps1` covers creation and
refusal before the existing runtime-host cases.

- [ ] Add causal native coverage invoking the production publication function:
  ```powershell
  $bundle = New-AgentsChatRuntimeBundle -Source $source -Directory $directory `
      -File $node -Arguments @('literal %n $HOME " space') `
      -WorkingDirectory $project -Environment $environment
  $private = [Deployment.WindowsPrivateFile]::Open($bundle.Configuration, $bundle.Sha256)
  try { $configuration = $private.ReadText() | ConvertFrom-Json }
  finally { $private.Dispose() }
  ```
  Require current-SID/SYSTEM native privacy for every helper and the config,
  identical source/copy hashes, literal command fields, unchanged source ACLs,
  refusal of existing destinations and invalid command input. Capture the
  missing-script failure in Actions after preserving the current full run.
- [ ] Add `CopyTrustedSource(source, expectedSha256, destination)` to native
  private publication. Refactor current `Open` into a private `OpenFile` with
  one internal `requirePrivate` parameter; public `Open` always passes true.
  Only the new copy method passes false for its temporary source reader.
  All source canonical-path, links/type/size, original-handle, content/digest
  and unchanged-security checks remain. Do not expose the nonprivate reader.
  Publish the decoded strict UTF-8 bytes through the existing private API;
  recheck source and destination digests and dispose both on failure.
- [ ] Extract the pre-mutation command encoding from native domain `Start`:
  ```csharp
  public static string CommandFrame(string file, string[] args, string cwd,
      Dictionary<string, string> environment)
  ```
  Keep the exact existing validation and wire format. `Start` calls this
  method; the publisher uses its `command` JSON, not a second encoder.
  Expose `WindowsRuntimeHost.HelperFiles` as a cloned string array.
- [ ] Publish only to a newly created native private directory. The PowerShell
  function takes explicit executable/argv/cwd/environment, validates the
  command before creation, hashes the fixed trusted source list, copies each
  through `CopyTrustedSource`, rechecks source hashes, and publishes
  `configuration.json` last. Return `Directory`, `Configuration`, `Sha256`.
  Retain the directory during publication; dispose handles on all paths.
  A post-creation failure leaves an explicitly reported incomplete bundle,
  never deletes/adopts existing directories or repairs ACLs.
- [ ] Wire the actual installed-runtime fixture to this publisher, retaining
  its independent helper list/configuration assertions and all native task,
  inhibition, close/exit, transaction and changed-configuration cases.
  Run `./tests/deployment-windows-runtime-bundle.ps1` and the existing native
  cases only in Actions; require the full regression before acceptance.

`2397c4c` / `36984988082` passed all native Windows task-controller cases, but
Linux public-command job `110767973311` failed during saved live restore with
only `stage=restore` / `code=UNKNOWN`. It is not a new full accepted baseline.
There are no diagnostic artifacts. Reuse `deploymentDiagnostics` in the saved
entry, include that module explicitly in its saved closure, and require
bounded owned module/line/column output in the real saved-entry rejection
test. Do not emit private filesystem paths, raw error messages or command
output, and do not weaken restore admission or claim a transient failure
without evidence. Diagnose the next actual public-command result before
considering the Linux regression resolved.

Task 5U causal `3ae9260` / `36985307563` failed on the absent production
publisher in native `110774758443`; Linux contracts `110774758397` also
captured the saved-source `ENOENT`. Implementation `55cccf7` and saved
diagnostics `c7e4ccd` are pushed. Run `36987509720` has passed its production
bundle publication step in native `110775795029`, including exact UTF-8
copies, private destinations, unchanged source ACLs, literal arguments and
refusals. Both synthetic installed-host and real application fixtures now
use this production publisher; their full regression and the previously
failing Linux public-command restore still need final outcomes.

The real Windows application job `110775794937` and all native task-options
cases `110775795029` passed. The previously failing Linux command also passed
at `110775795144`; no root cause for the earlier single `UNKNOWN` failure is
established. Keep the new diagnostic coverage and require this case in later
full regressions rather than claiming a speculative repair.

#### Task 5V: durable retirement of the original stopped task owner

The next prerequisite for changing an installed task's action is settling its
original host, while retaining restart inhibition and transaction evidence.
Do not yet register, enable or start a replacement task.

**Files:** new `scripts/deployment/windows-task-retirement.ps1`;
existing maintenance context, native/Node task controller bridge and explicit
saved-worker manifests; existing task-transaction/native host fixtures and
workflow.

- [x] Add actual S4U task cases `transaction-retire` and
  `transaction-retire-refused`. The latter calls retirement while copying
  and requires refusal with no retirement intent, leaving the stopped
  original owner alive. The positive case advances the real state/check
  sequence to `activating`, then exercises:
  ```js
  await context.retire();
  await context.retire();
  await context.check();
  await context.close();
  ```
  Require original owner and member handles signaled, task still disabled
  with zero Scheduler instances, exactly one request/completion pair, and
  the unchanged four stopped-phase receipts. Capture the missing-method
  failure in Actions; existing cases remain unchanged.
- [x] Add `Retire-AgentsChatTaskOwner -Context` and
  `Assert-AgentsChatTaskRetired -Context` in the focused native module.
  Require a live unpoisoned stopped context and its original transaction at
  `activating` or `restore-activating` before publishing any intent.
  Persist `task-retire-requested.json`, chained to the stopped receipt;
  recheck authority; request `retire` through the existing original
  generation/PID/start-bound control; join the retained original process.
  Require exit code zero, unchanged disabled task XML/security and zero
  instances before publishing `task-retire-complete.json`.
- [x] Add explicit `Retired` context state. Stopped checks must not certify a
  retired host. Retired checks retain original controller identity, transaction
  lock/state/configuration, all immutable receipts, the signaled original
  owner handle, and unchanged disabled task policy/no instances.
  Failures poison the context and retain all evidence/inhibition. Repeat
  retirement rechecks completed authority without creating another receipt.
- [x] Extend the bounded native request protocol with `retire`, dispatching
  later `check`/`close` to the correct stopped or retired gate. Export Node's
  `retire()` via the existing single-flight request path; preserve explicit
  abandonment on uncertain failure. Include the native script in the saved
  engine and independent expected manifest.
- [x] Validate native cases and full regression in Actions. This establishes
  original-owner retirement only; replacement registration, activation,
  release, cold recovery and public transactional commands remain separate
  unfinished work.

**Accepted runtime/controller baseline:** `c7e4ccd` / `36987509720` completed
**23/23 success**, including the real Windows application using the production
bundle publisher and the Linux public restore previously observed failing.
This replaces `44016e6` as the full accepted baseline; retain the documented
uncertainty about the earlier isolated failure's root cause.

Task 5V causal `3d71f9e` / `36989723092` failed exactly because
`context.retire` was absent; the characterized run was then cancelled.
Implementation `c5d5b6d` and exact-state binding `284e32f` are pushed.
Native task-options `110784933138` in run `36990262413` passed early-phase
refusal, update retirement and restore retirement. Full run `36990262413`
completed **23/23 success**, making `284e32f` the new full accepted baseline.
Retirement
requests allow 60 seconds for the two bounded native joins plus rechecks;
ordinary check/close request deadlines remain unchanged.

Retirement also captures the exact natively opened activation-state SHA-256
in both receipts, not only its phase name. Every subsequent retirement check
requires that digest unchanged, alongside the original lock/configuration.
The positive update and restore tests independently verify this state digest.

#### Task 5W: publish a disabled replacement task after original retirement

Continue the approved activation design without enabling a task or claiming
application health. Reject replacement before retirement, wrong candidate
digests, changed transaction state and unrelated task policy changes.

**Files:** `WindowsRuntimeHost.cs` (shared read-only installed configuration
admission), new `windows-task-replacement.ps1` (retained candidate and exact
disabled task publication), existing maintenance/retirement/controller modules
and saved-worker manifest, native runtime bundle and transaction fixtures.

- [ ] Add native tests using the production bundle publisher and actual
  Scheduled Tasks. Drive update and restore to their activation phases, retire
  the original owner, and execute:
  ```js
  await context.replace({ configuration, sha256 });
  await context.replace({ configuration, sha256 });
  await context.check();
  await context.close();
  ```
  Require exactly two private `task-replace` receipts chained from completed
  retirement, unchanged original retirement receipts, disabled/no-instance
  task, exact candidate action and unchanged XML outside Command, Arguments
  and WorkingDirectory. Wrong digest and pre-retirement calls must publish
  no replacement intent or task mutation.
- [ ] Share the installed host's existing strict configuration/helper/command
  parsing through `WindowsRuntimeHost.Open(configuration, sha256, helpers)`.
  It returns an IDisposable retained candidate with `Check()` and does not
  create a Job, runtime process, control pipe or readiness file. `Run` uses
  the same admission before starting the domain. Test write denial while
  retained and absence of runtime readiness.
- [ ] Implement `Publish-AgentsChatTaskReplacement -Context -Configuration
  -Sha256`. Recheck completed retirement and exact activation-state digest;
  retain the candidate; copy the admitted disabled task definition and
  replace only its three literal action fields. Publish requested evidence
  before `RegisterTask` with UPDATE, DONT_ADD_PRINCIPAL_ACE and
  IGNORE_REGISTRATION_TRIGGERS. Preserve original principal/logon type and
  exact security descriptor. Compare native returned XML, disabled state
  and zero instances before completed evidence. Fail closed and retain
  evidence rather than silently rolling back or enabling.
- [ ] Keep original disabled XML immutable for retirement evidence; retain a
  distinct replacement definition for subsequent policy checks. Repeated
  identical replacement checks authority, not another registration.
  Add bounded `replace` native/Node request payload and explicit saved
  dependency. Existing stop/check/retire/close paths remain unchanged.
- [ ] Push causal tests, capture missing shared admission or replace method in
  Actions, then push implementation and require native/full regression.
  Starting and binding the new generation, health verification, release,
  cold recovery and public Windows transactions are still unfinished.

Task 5W causal `e0a821f` / `36991379979`, native task-options
`110790274379`, failed exactly at bundle-test line 40 because
`WindowsRuntimeHost` has no `Open` method. The characterized run is cancelled
before implementation validation. `d0104bb` implements shared read-only
candidate admission, disabled registration and durable replacement context;
native replacement and full regression are not yet accepted.

Implementation `500716f` / `36992268112`, native `110791253701`, passed
shared read-only candidate admission and replacement-before-retirement refusal.
Positive replacement failed at `replace/replacement-definition`, before
registration. Add bounded stage/HRESULT/source-line diagnostics and compare
only fixed task-policy section names when reporting an XML mismatch; do not
emit configuration/XML contents or relax policy comparison. Move that
independent positive scenario immediately after bundle admission to shorten
feedback; preserve every existing scenario.

Diagnostics `88e84a2` / `36993134478`, native `110793975499`, isolated the
failure to `replacement-policy-settings` before registration: exporting the
COM definition after editing only the action changes the Settings XML.
Do not guess which Scheduler default caused this or relax comparison.
Construct the request by editing the three action nodes in retained original
XML, and submit that XML directly through `RegisterTask` with the same flags.
Keep the exact independent post-registration comparison. Reject `%` environment
substitutions and `$(...)` Scheduler argument substitutions in replacement
paths, with separate real native negative cases before replacement intent.

`7e67985` / `36993546554` reached registration but failed its postcondition.
Further diagnostics `f655e0b` / `36993893212`, native `110796492403`, confirmed
that inhibition and exact native task security passed; Settings no longer
differed. The remaining mismatch is RegistrationInfo after registration.
Do not exempt that section. Submit UPDATE without the optional SDDL (this
operation changes the action, not permissions), retaining
DONT_ADD_PRINCIPAL_ACE and exact security/XML checks. Add a restore fixture
with deliberately nondefault task permissions to prove existing ACLs are not
reset to defaults. This candidate correction still requires native acceptance.

`95f4e06` / `36994391371`, native `110798069319`, passed every replacement
case: update, restore with a nondefault ACL, pre-retirement refusal, wrong
digest, environment-variable path and Scheduler-argument path refusals.
Omitting the unnecessary SDDL update preserves RegistrationInfo as well as
the exact native security descriptor. Full run `36994391371` completed
**23/23 success**; `95f4e06` is the new full accepted baseline.

#### Task 5X: bind unverified runtime lifetime to its original controller

Before task activation, provide a runtime-side original-process lease that
can be explicitly released by that controller only. A disabled task cannot
be used as a demand-start workaround: Microsoft documents RunEx returning
S_OK without running it; existing native Run coverage also observes
SCHED_E_TASK_DISABLED. Do not add an unprotected enable/run window.

**Files:** new `scripts/deployment/WindowsRuntimeLease.cs`; installed runtime
host, control pipe/control protocol and bootstrap; explicit helper closures;
new native lease client/fixture tests and guarded scenarios in the existing
actual Scheduled Task host fixture. A separate native activation-lease job
keeps the existing task-options deadline unchanged.

- [ ] Add native causal tests for retained owner identity, wrong-peer release,
  repeated authorized release, controller exit and a measured one-second
  deadline. Use production private controller processes, not PID/name kills.
  Add actual S4U host cases: wrong caller cannot release; controller exit
  before release exits the host and settles its original detached Job member;
  after authorized release the same host/member survive controller exit and
  remain available for ordinary scoped stop/retire.
- [ ] Implement `WindowsRuntimeLease.Start(pid, identity, timeoutMilliseconds)`
  with a retained original Process handle, bounded lifetime up to 30 minutes,
  a synchronized timer, `Check()`, `TryRelease(actualPeerPid)` and Dispose.
  A missing/exited/changed owner or deadline before release exits only the
  current guarded host. Serialize release with timer callbacks so a queued
  callback cannot terminate an already released host. Reject a reused PID
  through the retained original handle, never by killing a looked-up process.
- [ ] Add an optional explicit ControllerPid/ControllerIdentity bootstrap pair
  and a guarded Run overload. Acquire the lease after read-only bundle
  admission but before any runtime Job/start; include it in host checks.
  Preserve the original unguarded Run and readiness schema.
- [ ] Add `release` to scoped runtime control with an optional release
  callback. Obtain the actual connected client PID from the native pipe,
  not the JSON payload. Only the retained original controller may disarm
  the lease. Refuse release on an unguarded/stopped host; successful reply is
  exactly `released`, not an application-health or transaction-success claim.
- [ ] Include the new native dependency in bootstrap, every installed helper
  inventory and saved-worker closure, including independent tests. Push causal
  cases and capture missing capability in Actions, then implement and require
  the new native job plus full regression. Task enable/start, new-generation
  transaction binding, health-gated release and cold recovery remain the next
  integration work; this lease alone does not complete public activation.

Task 5X causal `57135cf` / `36996350112`, native activation-lease
`110804418372`, failed exactly on missing `WindowsRuntimeLease.cs` at the
fixture's Add-Type. The workflow now has 24 jobs. Implementation adds the
retained/synchronized original-controller lease and native peer-authenticated
`release`, guarded bootstrap, the ninth installed helper and saved closure.
It also checks mismatched controller identity before any startup/readiness
and refuses release on unguarded hosts. Native and full acceptance are pending.

Task 5X implementation `52b5a39` / `36996890010` completed **24/24 success**.
Native activation-lease `110805967919` passed primitive identity/peer/release,
real one-second deadline, actual S4U controller-loss original-Job settlement
and released original-runtime survival. Existing task-options `110805967771`,
real Windows application and all Linux lifecycle jobs also passed.
`52b5a39` is the latest full accepted baseline.

#### Task 5Y: activate a guarded replacement while retaining task inhibition

**Files:** new `windows-task-activation.ps1`; native maintenance/retirement
context and Node/native controller protocol; explicit saved-worker closure;
new focused activation fixture driver and existing transaction/host fixtures.

- [x] Add actual update/restore activation, controller-abandonment and premature
  activation refusal cases. Use `await context.activate()` after retirement and
  replacement, recheck idempotence, retain actual new owner/member handles,
  and require their settlement when the unreleased bridge closes or loses its
  original Node controller. This tests activation mechanics, not application
  health or source/build completion.
- [x] Before startup, record and register a disabled staging definition:
  same admitted candidate/account/security, literal bridge PID/start identity
  in bootstrap arguments, no triggers and no restart-on-failure. Retain the
  original replacement definition for eventual policy restoration. Require
  supported demand-start and ignore-new instance policy before any mutation.
- [x] Publish start intent before enabling; demand-start only that exact staged
  task, retain the returned native instance/original owner, then disable it
  again. Bound startup/readiness waits and refuse task/instance/configuration
  changes. Controller loss during the enabled interval cannot admit an
  unguarded runtime or automatic restart: staged startup requires its original
  bridge lease, triggers are absent and restart-on-failure is suppressed.
- [x] Bind private readiness to the new owner PID/start, configuration digest,
  session, generation and Scheduler instance; verify original control endpoint
  and Job membership. Keep all old retirement and replacement evidence,
  append private requested/prepared/start-requested/running receipts, and
  return a bounded native runtime identity through `activate`.
- [x] Dispatch active checks separately from retired/zero-instance checks.
  Ordinary close must not release the runtime lease or enable restart policy;
  bridge exit settles the unverified generation. Preserve all evidence and
  inhibition on uncertainty. No health or final-success claim is introduced.
- [x] Capture the missing activation method in Actions, implement, and require
  native plus full regression. Health-gated permanent policy/lease release,
  reopening/cold recovery and public Windows transaction composition remain
  subsequent work.

Task 5Y causal `b87d528` / `36999083642`, native `110812379397`, failed
exactly at `context.activate is not a function` after real transactional
retirement and replacement. The failure was captured before implementation.
The implementation adds separately retained active-owner context and guarded
startup, without relaxing the exact activating-state digest or adding a
release/health/success path. Native and full regression remain pending.

Implementation `057963b` / `36999361621`, native `110813564607`, refused
before demand-start at the registered-profile equality gate. Emptying a
previously populated `Triggers` element with `InnerXml=''` leaves an explicit
non-self-closing DOM form; use `IsEmpty=true` to construct the intended empty
element. Retain exact registered XML/security checks and add bounded substage
diagnostics. Whether this accounts for the native mismatch remains subject
to the next Actions run.

`ad311cf` / `36999643657`, native `110814478038`, passed actual update and
restore/custom-ACL activation, original-controller exit, pre-retirement
activation refusal and the existing guarded-host/release cases. Constructing
self-closing empty triggers passed exact registered XML equality; no policy
or ACL comparison was relaxed. Full regression remains running.

The follow-up retains the exact returned `IRunningTask` alongside the original
owner handle and checks it on every active observation. It also requires
`activate-state-change` to fail specifically at `check/retirement-phase` when
only the valid state's timestamp changes after activation; the refused
bridge must exit and settle that same guarded host/member. This prevents
passing by testing only a malformed state or a generic timeout.

`ad311cf` / `36999643657` completed **24/24 success** at 11:30 UTC.
This is the new full accepted baseline. Follow-up `99a985e` / `37000065119`
is running; its native activation job is `110819509658`.

#### Task 5Z: retained native Windows listener identity before health release

**Files:** new `scripts/deployment/WindowsRuntimeListener.cs` and
`tests/deployment-windows-runtime-listener-cases.ps1`; actual installed-host
fixture, actual prebuilt application fixture, native activation job and saved
helper inventory.

- [x] Require `WindowsRuntimeListener.Retain(generation, ownerPid,
  ownerIdentity, launcherPid, port)` and `Check()` on actual S4U-owned IPv4 and
  dual-stack listeners. Retain the original host and listener process handles,
  their creation identities, original Job membership and kernel TCP binding
  timestamp; releasing the observation must not stop the application.
- [x] Use `GetExtendedTcpTable` with `TCP_TABLE_OWNER_MODULE_LISTENER` for
  both address families. Bound allocations, row counts and table-growth
  retries; validate struct alignment and lengths. Require one
  loopback-accessible record or the exact two-family wildcard pair with
  shared PID/nonzero bind timestamp. Only absent listener is retryable, never wrong ownership,
  ambiguous port, changed PID/bind time or invalid native observations.
- [x] Exercise unrelated listener refusal, cross-family ambiguity, wrong host
  identity, same-process close/rebind and stopped original Job. Use the
  actual Node listener rather than a mocked table and verify that refusals
  do not stop unrelated work.
- [x] Wire this observation around the existing real application/API fixture
  and retain its complete saved helper closure. Capture the missing-helper
  causal failure in Actions, then require native and full acceptance.
- [ ] Subsequent health composition must reuse the existing bounded HTTP and
  admitted-provider checks from `linux-readiness.mjs`, not duplicate them.
  Native listener ownership by itself does not permit lease release or mark
  the deployment successful.

Microsoft documents `liCreateTimestamp` as the FILETIME of the context bind,
not the process creation time:
`https://learn.microsoft.com/en-us/windows/win32/api/tcpmib/ns-tcpmib-mib_tcprow_owner_module`
and `.../ns-tcpmib-mib_tcp6row_owner_module`. The table API is documented at
`https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable`.

Task 5Y follow-up `99a985e` native `110819509658` passed, including the
specific valid-state digest mutation refusal and original guarded generation
settlement. Its full regression is still running.

Task 5Z causal `49f073d` / `37001596831` is queued behind that full run.
The local implementation uses bounded OWNER_MODULE tables with aligned
IPv4/IPv6 row layouts and retained original owner/listener handles. It exports
the 64-bit bind timestamp as a decimal string to preserve exact transport
identity, checks original control/Job membership before and after observation,
and is wired around the actual application API fixture. Implementation
publication waits for the missing-helper causal result; no listener acceptance
is claimed yet.

`99a985e` / `37000065119` completed **24/24 success** at 11:47 UTC:
Task 5Y, including retained original Scheduler instance and exact active-state
digest refusal, is fully accepted. This replaces `ad311cf` as the latest full
accepted baseline.

Task 5Z causal `49f073d` / `37001596831`, native `110824355280`, failed
exactly at the missing `WindowsRuntimeListener.cs` Add-Type input before
creating a task. The result was captured before publishing the implementation.
Local commits `bf1171b` and `ec8e008` implement the observer and fixture
corrections; native plus full listener acceptance remain pending.

`dd2a09e` / `37003015827`, native `110825158407`, passed actual IPv4 native
ownership/bind-time retention, same-process rebind, foreign/ambiguous listener
refusal and original Job settlement. The dual-stack case refused at the
multiple-record gate. Add bounded count/wildcard/same-owner/same-bind flags
to identify the actual two-family native representation before changing the
admission policy; do not assume two records are the same socket.

`e2523d1` / `37003341990`, native `110826005037`, confirmed the dual-stack
listener produces exactly two wildcard records (`0.0.0.0` and `::`) with
the **same owner PID and same nonzero kernel bind timestamp**. The deliberate
cross-family ambiguity case has neither wildcard-pair shape and stays refused.
Admit only this exact paired representation in addition to a single record;
retain the paired/single shape in the binding identity and compare it on every
check. Do not admit arbitrary same-PID pairs.

Add a separate actual same-process IPv6-only/IPv4 wildcard pair created 100 ms
apart. It must remain rejected even though both endpoints respond and have the
same original Job owner. The listener fixture is extracted into a focused CJS
helper instead of further growing the installed-host fixture. Full acceptance
of the paired representation and its counterexample is pending.

`19e577f` / `37003698264`, native `110827360402`, passed IPv4, dual-stack,
the independent same-process wildcard-pair counterexample, and all existing
activation/lease cases. The real Windows application job `110827360458` also
passed create/mutate/stopped restore with the new retained native listener
checks around authenticated API operations. Full regression remains running.

#### Task 5AA: bind Windows HTTP readiness to retained native activation

**Files:** new `windows-task-listener.ps1`, `windows-readiness.mjs` and shared
`http-readiness.mjs`; Node/native task protocol and maintenance context;
`linux-readiness.mjs` shared-probe extraction; explicit saved helper inventory;
new `deployment-windows-readiness-cases.mjs` and existing actual activation
fixture/Node driver.

- [x] After exact active-context checks, expose bounded `context.listener({
  port, signal })`: retain the original native listener in the existing
  checkable/disposable authority context. Return explicit `not-ready` only
  for the native absent-listener exception. A retained listener must never
  be silently replaced or switched to a different port.
- [x] Add `verifyWindowsReadiness` and `waitWindowsReadiness`. Validate admitted
  providers before touching the runtime; obtain native listener authority
  before HTTP and recheck it afterward. Return only endpoint readiness and
  actual generation, not deployment success or a released runtime lease.
- [x] Extract existing bounded HTTP/UTF-8/provider matching without changing
  Linux behavior: three-second request bound, 8 KiB headers, 64 KiB body,
  uncompressed 200 JSON, exact advertised provider IDs and valid URLs.
  Retry only absent listener/HTTP503, not malformed responses or lost owner.
- [x] Native activation fixture exercises successful HTTP, exactly three
  startup attempts, one-attempt provider mismatch, hanging-response deadline,
  and subsequent retained-runtime check. Original task remains disabled,
  activation-state digest unchanged, and ordinary unreleased close still
  settles the same host/member.
- [x] Preserve the complete saved-worker/recovery import closure and actual
  Linux readiness regression. Capture the missing Windows readiness module
  before implementation publication, then require native and full acceptance.
- [x] Leave permanent task-policy restoration, terminal-state transition and
  health-gated lease release to the next transaction completion step.

The implementation retains the native listener in `Context.Files`, so all
subsequent active checks include its original socket identity. The new
`listener` reply is strictly captured and generation/port-bound by Node.
`http-readiness.mjs` contains the unchanged HTTP/provider rules and shared
retry deadline, with thin Linux and Windows wrappers.

Platform-independent contract tests additionally prove zero HTTP requests
after native refusal, input rejection before ownership work, explicit
absent-listener retries and rejection after healthy HTTP if ownership changes.
The real Windows application API fixture now invokes the same provider probe
between its original native listener checks.

The actual native hanging-response test uses the internal three-second HTTP
deadline and checks elapsed time/continued context authority. A one-second
overall deadline could instead interrupt a native ownership request, whose
existing contract correctly abandons uncertain authority; it must not be
misrepresented as HTTP-only cancellation. The shared overall-stage deadline
is covered by the isolated Node contract and existing native Linux tests.

Task 5Z `19e577f` / `37003698264` completed **24/24 success** at 12:20 UTC,
including actual application data continuity and all public Linux lifecycle
gates. This is the latest full accepted baseline.
Task 5AA causal `49d334a` / `37004758607` native `110834527500` failed at
12:22:43 UTC with `ERR_MODULE_NOT_FOUND` for `windows-readiness.mjs`,
imported by `deployment-windows-readiness-cases.mjs` after actual guarded
activation and independent receipt checks. The earlier listener and guarded
activation cases passed. Captured this causal failure before cancelling the
run and publishing implementation `469a38c`; implementation acceptance is
pending Actions.

Task 5AA implementation `839ac62` / `37006419246` native `110835994597`
passed all activation/listener/readiness cases. Full regression completed
**24/24 success**, observed at 12:47 UTC. Actual Windows application job
`110835994211` passed authenticated create/mutate/stopped-data restoration
with the shared HTTP/provider probe; all saved Linux and public lifecycle
gates passed. This is the latest fully accepted baseline.

#### Task 5AB: health-gated native task completion

Continue the approved live-transaction design, not a new deployment model.
Inspection of `state.mjs` established that no `verifying` state exists:
use `activating -> accepted` and `restore-activating -> restored`, without
changing Linux transitions. A terminal state alone cannot release a lease.

**Files:** new `windows-task-completion.ps1` and
`windows-task-completion.mjs`; existing native/Node controller protocol,
transaction and active-context guards, saved-worker inventory; actual
activation fixture and new completion scenarios in the native workflow.

- [x] Add causal native completion after actual guarded activation and
  independent twelve-receipt checks. Dynamically import the new helper so
  the missing module is the failure, not a pre-activation fixture defect:
  ```js
  const { completeWindowsTaskActivation } =
    await import('../scripts/deployment/windows-task-completion.mjs');
  await completeWindowsTaskActivation({
    context, port, providers: ['admin-login'],
    recordAcceptance: async () => {
      state = { ...state, previousPhase: state.phase,
        phase: operation === 'restore' ? 'restored' : 'accepted',
        updatedAt: new Date().toISOString() };
      await writeState(control, state);
      return hash(await readFile(stateFile));
    },
  });
  ```
- [x] The Node helper performs bounded native-bound HTTP readiness, then
  `context.prepareCompletion({ port, providers })`. Native code retains the
  exact original activating state and writes a readiness-bound completion
  intent. No task policy, state or lease changes during preparation.
- [x] Only `context.complete({ stateSha256 })` may admit the exact expected
  terminal state. Compare every prior field except phase/previousPhase and
  monotonic updatedAt; bind the explicit digest and keep checking it afterward.
  Ordinary checks must still reject unannounced state changes.
- [x] Publish disabled staged XML without the temporary guard arguments,
  still suppressing triggers/restart and retaining account/security. Journal
  intent before registration; recheck original running instance/owner/Job/
  listener and exact registered policy after registration.
- [x] Persist release intent while still disabled, require authenticated
  original-peer `released` acknowledgement, then restore the full original
  triggers/restart policy while disabled and finally the prior enabled
  setting. Never assume disabling alone suppresses every restart mechanism.
  Check all retained identities around each step and persist
  completion. Controller loss before release still settles the guarded Job;
  after release, the same original runtime must survive. Do not enable
  automatic restart before release or treat a release acknowledgement as
  source/build/application acceptance.
- [x] Native update and restore cases independently check the terminal
  state, receipt chain, permanent action, triggers/restart/security, original
  generation survival after controller close, and explicit final Job cleanup.
  Add changed-state rejection after preparation. Run the existing Actions
  workflow only; require native success and preserve full regression.
- [ ] Reopening/cold completion, cross-account permissions and complete
  source/artifact acceptance remain separately required before public wiring.

Task 5AB causal `a6a1636` / `37007154332`, native `110843214497`, failed
at 12:50:37 UTC with `ERR_MODULE_NOT_FOUND` for `windows-task-completion.mjs`
after genuine guarded activation and independent receipt checks. Captured
this result before cancellation and publication of implementation `3fb918b`.
Implementation acceptance remains pending. Its nine immutable completion receipts retain the activating state,
terminal digest, original runtime and listener, staged no-automation action,
original permanent task definition and enabled/security policy. Automation
stays suppressed until the authenticated lease release has completed.
Native scenarios include update, restore with custom security, preservation
of an originally disabled running task, and changed target-commit refusal
after preparation. Contract tests cover HTTP/preparation/state/release ordering
and preserving both publication and cleanup errors; these do not substitute
for native acceptance.

Task 5AB implementation `10ab002` / `37009269970`, native `110845169410`,
passed the existing listener/activation/HTTP cases and reached authenticated
release plus full disabled-policy restoration. It then refused at
`complete/completion-enablement`; the broad stage does not establish whether
template construction, the COM setter or exact policy comparison failed.
Add bounded substages without weakening comparisons. The fixture also needs
to stop/retire its retained original runtime on partial post-release failure
before deleting fixture directories. Captured and cancelled this failed run.

Diagnostic `b376d84` / `37010237447`, native `110847953714`, established
`complete/completion-enable-definition` with **enabledNodes=0** after the
native enabled-value check passed. Task Scheduler omits the default true
Enabled node. Reuse existing `Confirm-AgentsChatTaskInhibition` in reverse:
require the native desired enabled value and compare every other XML node
exactly; retain the actual native definition afterward. Disabled policy still
requires exact unchanged XML. The independent native fixture separately
checks absent/explicit true versus required explicit false, then compares
all other policy and security. Partial post-release fixture cleanup now
settles the original runtime without the previous directory-lock failure.
Captured this diagnostic before cancellation and correction publication.

Task 5AB corrected `f7c5e19` / `37010551771`, native `110849112501`,
passed update, restore/custom security, originally disabled policy and changed
terminal-state refusal, then all earlier activation/listener/lease scenarios.
The same original runtime survived controller close in every positive
completion case. Full regression completed **24/24 success**, observed at
13:26 UTC. This is the latest fully accepted baseline.

#### Task 5AC: read-only original activation lease observation

Cold completion must not infer lease release merely because a process survives
controller loss. Add an explicit, generation-bound native observation before
implementing cold policy/receipt reopening. This is neither new release
authority nor application-health evidence.

**Files:** `WindowsRuntimeLease.cs`, `WindowsRuntimeControl.cs`,
`WindowsRuntimeHost.cs`; existing actual runtime-host and activation fixtures.
The installed helper inventory remains nine files.

- [ ] Causal actual installed guarded host test:
  ```powershell
  Assert ([Deployment.WindowsRuntimeControl]::Exchange(
      [guid]$ready.generation, $ready.pid, $ready.identity, 'lease', 15000) -ceq 'guarded') `
      'Read-only observation lost the original activation lease'
  ```
  Require the existing client to fail specifically with unsupported method,
  after native host readiness/binding; do not describe it as server acceptance.
- [ ] Add `WindowsRuntimeLease.Observe()` under the same release/timer gate:
  disposed throws; unreleased checks the original owner/lifetime and returns
  `guarded`; released returns `released` without requiring a still-live
  former controller.
- [ ] Extend control with an optional `Func<string>` observer, preserving
  existing constructor overloads. A missing observer refuses explicitly.
  Production host supplies `unguarded` only when it genuinely has no lease.
  Strict `lease` replies accept exactly `unguarded`, `guarded`, or `released`
  within the existing owner/generation/request-ID-bound frame. Do not change
  domain observation fields, health flags or release-peer authorization.
- [ ] Actual second-process observation must not release guarded work:
  check before and after a rejected foreign-peer release, after legitimate
  original-peer release, after controller exit, and after ordinary Job stop.
  Also observe `unguarded` production hosts and the released original
  transaction runtime from its independent post-close fixture controller.
- [ ] Run only Actions. Preserve full Task 5AB regression, capture causal
  failure, publish implementation, and require native plus full regression.
  Cold policy mutation and evidence retirement still need their own original
  task/instance/receipt/lock admission; lease status alone never authorizes them.

Task 5AC causal `2748d88` / `37011600468`, native `110856969218`, failed at
13:27:07 UTC with **Unsupported runtime control method** after real guarded
host readiness and native binding. This is the old client's missing method,
not a successful server request. Captured before cancellation and publication
of implementation `033ed82`. The implementation adds only read-only lease
observation and strict string reply capture, preserving all existing control
constructors and domain-observation fields. The native domain fixture with
no observer explicitly refuses the query instead of reporting `unguarded`.
Implementation `033ed82`, published through `8f3063b`, passed native activation
job `110857820365` and task-options job `110857820807`. Full run `37013169103`
passed **24/24**, including saved Linux restore, public Linux lifecycle and
real Windows application/data continuity. This is the latest fully accepted
baseline; no public Windows cold mutation or evidence retirement is implied.

#### Task 5AD: reopen completed task evidence without mutation

**Files:** new `scripts/deployment/windows-task-completion-proof.ps1`,
new `scripts/deployment/windows-task-completion-records.ps1`,
new `tests/deployment-windows-task-completion-proof.ps1`; existing transaction
state parser, completion fixture/driver, saved-worker inventory and a separate
bounded native proof job in the lifecycle workflow.

Scope this first reopening step to a fully completed nine-receipt handoff,
not interrupted prefixes or evidence deletion. A fresh native process receives
only the external control directory, never the old in-memory context.

- [ ] After actual completion and original Node/bridge exit, invoke:
  ```powershell
  $proof = Open-AgentsChatTaskCompletionProof -Control $Control
  try { Assert-AgentsChatTaskCompletionProof -Context $proof }
  finally { Close-AgentsChatTaskCompletionProof -Context $proof }
  ```
  Capture the missing production proof helper in Actions before publication.
- [ ] Retain the private control directory, original lock/state and exact
  23-file maintenance inventory: admission, transaction, twelve task
  stop/retire/replace/activate records and nine completion records. Reject
  another recovery lock, unsupported inventory, duplicate/unexpected fields
  or changed permissions/content. Verify every previous/admission/transaction
  hash and original operation/controller/task/configuration reference.
- [ ] Require the original Node and native bridge identities to be absent;
  PID reuse alone is not liveness and must never authorize termination.
  Validate original transaction admission, activating-state snapshot and
  exact accepted/restored state using shared strict state parsing. Reuse
  existing validation instead of writing a second permissive state parser.
- [ ] Retain the original completed runtime process, native Scheduler
  instance, private configuration/helper bundle and readiness file. Compare
  native enabled policy and exact other XML/security against the completed
  replacement, handling only the established default-true omission.
- [ ] Require actual native lease observation `released`, original nonempty
  Job membership and exact original listener PID/identity/address/bind-time/
  pair shape. Retaining a newly observed listener is insufficient unless it
  matches the completed receipt. Check all retained evidence/native
  identities again before returning:
  ```powershell
  [pscustomobject]@{
      status='observed'; mutationAuthority=$false
      operationId=$context.OperationId; taskName=$context.TaskName
      stateSha256=$context.StateSha256; completionSha256=$context.CompletionSha256
      runtime=$context.Runtime; port=$context.Port; providers=$context.Providers
      lease='released'
  }
  ```
- [ ] Native tests independently compare returned identity and unchanged
  receipt hashes/task policy, refuse a still-live original controller,
  changed terminal bytes and changed task policy, and refuse same-process
  listener rebinding. Clean up only the fixture's original runtime.
- [ ] This proof never stops, releases, enables, deletes, repairs ACLs,
  releases operation locks or reports deployment success. A later exclusive
  recovery admission and atomic retirement mechanism are still necessary.

Task 5AD causal `6def158` / `37015583694`, dedicated native job
`110866209874`, failed at 13:52:23 UTC on the missing production
`windows-task-completion-proof.ps1`, after genuine completed handoff and
original Node/bridge exit. Captured the exact failure before cancellation.
The production implementation separates strict retained receipt replay from
read-only native runtime observation, reuses the existing 14-field state
converter, and is included in the saved-worker/recovery helper closure.
Implementation `2c1aafc` / `37017035126` passed the dedicated positive native
proof job `110870333836` at 14:02:56 UTC. Preserve its full 25-job regression.
The expanded fixture adds fresh-process refusal of still-live controllers,
changed terminal bytes, broken receipt links, duplicate/unexpected receipt
fields, extra maintenance inventory, existing recovery authority, changed
task enablement and a same-process/same-port rebind. Every refusal preserves
the original runtime, task policy and private receipts/lock/state. The
dedicated job also exercises restore with nondefault task permissions and
an originally disabled task. Full `2c1aafc` run `37017035126` passed **25/25**.
Expanded `c7de917` run `37017549550`, native job `110877950045`, passed all
three scenarios and their refusal cases at 14:25:10 UTC. Its full regression
completed successfully with **25/25** jobs, observed at 14:38:26 UTC.
This does not imply public Windows recovery acceptance.
The embedded activating snapshot is validated as state and linked to every
recorded activating digest; it is not a claim to reconstruct the former
state file's exact serialized bytes.

#### Task 5AE: standard native Windows admission primitive

Approved design: `Shared native admission for deployment and recovery` in
the existing specification, commit `6c77eb6`; written design approved by the
user. Execute inline in the existing worktree. Do not reopen the approach
selection or create another worktree.

**Files:**
- Modify `scripts/deployment/WindowsPrivateFile.cs`: declare the class
  partial and extract its existing private file-security creation and
  opened-handle capture into private shared methods, preserving validation.
- Create `scripts/deployment/WindowsPrivateFile.Admission.cs`: only the
  retained admission lease and exclusive-open operation. The partial class
  shares private validation without exposing raw handles or duplicating
  native metadata/ACL parsing. Existing installed hosts can still compile
  the base file alone; their nine-helper inventory does not change.
- Create `tests/deployment-windows-private-admission.ps1`: actual independent
  process contention, close/exit, privacy, namespace and non-inheritance cases.
- Extend `.github/workflows/deployment-lifecycle.yml`: run the native
  admission fixture before the existing completed-task proof cases.
- Extend `scripts/deployment/saved-worker-engine.mjs` and
  `tests/deployment-saved-worker.test.mjs` with the new partial source.

- [x] **Step 1: publish the native failing fixture before implementation.**
  Compile the existing base file and, when present, the admission partial
  file. First create and retain an actual private control directory using
  `WindowsPrivateFile.CreateDirectory`; then call the new API:
  ```powershell
  $lease = [Deployment.WindowsPrivateFile]::AcquireAdmission($control)
  try {
      $lease.Check()
      $other = & $pwsh -NoProfile -NonInteractive -File $PSCommandPath -Case busy -Control $control
      if ($LASTEXITCODE -ne 0 -or $other -cne 'busy') { throw 'Independent admission was not excluded.' }
      $lease.Check()
  } finally { $lease.Dispose() }
  ```
  The `busy` process must observe Win32 error 32, not treat every exception
  as contention. The suite must additionally acquire another private
  control directory while the first is held, reacquire the same persistent
  file after close, and terminate an exact retained fixture owner process
  before reacquiring. Inspect the native handle's inheritance flag in the
  fixture rather than inferring non-inheritance from a restricted child
  launcher. Wrong permissions, nonempty content and extra hard links must
  refuse without rewriting the file/ACL. Verify the original operation
  evidence remains unchanged. Fixture cleanup targets only its own named
  temporary directories and retained child process.

- [x] **Step 2: capture the causal failure in Actions.**
  Add this step to `windows-completion-proof`, after Node setup:
  ```yaml
      - name: Require exclusive native Windows admission and crash release
        shell: pwsh
        run: ./tests/deployment-windows-private-admission.ps1
  ```
  Push the fixture/workflow commit with the required co-author trailer.
  Query the workflow using its exact head SHA; inspect completed native job
  logs. Require the missing `AcquireAdmission` API after real private-root
  creation, not an unrelated fixture failure. Capture before cancelling the
  characterized causal run. Never compile or execute locally.

- [x] **Step 3: implement retained exclusive opening.**
  Extract the existing `FileSecurity` construction from `Publish` into
  `PrivateFileSecurity()`, and the existing metadata/path/ACL/content/hash
  capture from `OpenFile` into
  `CaptureOpenedFile(FileAccess access, bool requirePrivate, string expectedSha256)`.
  `OpenFile` calls the capture method with `FileAccess.Read`; admission
  uses `ReadWrite` and the SHA-256 of an empty byte array. Keep the existing
  regular-file, single-link, size, canonical final-path and private-ACL
  checks unchanged. Do not add the admission source to the installed host
  helper inventory, because the base partial has no dependency on it.

  The admission partial supplies this complete lease/opening implementation:
  ```csharp
  using System;
  using System.Collections.Generic;
  using System.ComponentModel;
  using System.IO;
  using System.Runtime.InteropServices;
  using Microsoft.Win32.SafeHandles;

  namespace Deployment
  {
      public sealed partial class WindowsPrivateFile
      {
          [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
          static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
              ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);

          public sealed class AdmissionLease : IDisposable
          {
              readonly WindowsPrivateFile parent, gate;
              bool closed;
              internal AdmissionLease(WindowsPrivateFile parent, WindowsPrivateFile gate)
              { this.parent = parent; this.gate = gate; }
              public void Check()
              {
                  if (closed) throw new ObjectDisposedException("Windows admission");
                  parent.CheckPublicationDirectory();
                  gate.Check();
                  parent.CheckPublicationDirectory();
              }
              public void Dispose()
              {
                  if (closed) return;
                  closed = true;
                  var failures = new List<Exception>();
                  try { gate.Dispose(); } catch (Exception error) { failures.Add(error); }
                  try { parent.Dispose(); } catch (Exception error) { failures.Add(error); }
                  if (failures.Count != 0)
                      throw new AggregateException("Windows admission close failed.", failures);
              }
          }

          public static AdmissionLease AcquireAdmission(string control)
          {
              RequirePath(control);
              WindowsPrivateFile parent = null, gate = null;
              try
              {
                  parent = PublicationDirectory(control);
                  gate = new WindowsPrivateFile { file = Path.Combine(control, "windows-admission.lock") };
                  GCHandle descriptor = GCHandle.Alloc(
                      PrivateFileSecurity().GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
                  try
                  {
                      parent.CheckPublicationDirectory();
                      var attributes = new SecurityAttributes {
                          Length = Marshal.SizeOf<SecurityAttributes>(),
                          Descriptor = descriptor.AddrOfPinnedObject(), Inherit = 0
                      };
                      const uint readWriteControl = 0xC0020000, openAlways = 4, openReparsePoint = 0x200000;
                      gate.handle = CreateFileW(gate.file, readWriteControl, 0,
                          ref attributes, openAlways, openReparsePoint, IntPtr.Zero);
                      if (gate.handle.IsInvalid)
                          throw new Win32Exception(Marshal.GetLastWin32Error(), "Acquire exclusive Windows admission");
                  }
                  finally { descriptor.Free(); }
                  gate.CaptureOpenedFile(FileAccess.ReadWrite, true, Digest(Array.Empty<byte>()));
                  var lease = new AdmissionLease(parent, gate);
                  lease.Check();
                  return lease;
              }
              catch (Exception failure)
              {
                  var failures = new List<Exception> { failure };
                  try { if (gate != null) gate.Dispose(); } catch (Exception error) { failures.Add(error); }
                  try { if (parent != null) parent.Dispose(); } catch (Exception error) { failures.Add(error); }
                  if (failures.Count != 1)
                      throw new AggregateException("Windows admission acquisition and cleanup failed.", failures);
                  throw;
              }
          }
      }
  }
  ```
  Add `WindowsPrivateFile.Admission.cs` beside `WindowsPrivateFile.cs` in
  both saved-worker source lists. The inventory test independently asserts
  its presence; generic saved recovery capture then includes the same source.

- [x] **Step 4: publish and require native plus full acceptance.**
  Commit only the planned production, inventory and directly related
  documentation changes; push and locate Actions by exact SHA. Require the
  native fixture to pass all independent-process and refusal cases, plus
  update/restore/custom-ACL/disabled completion proof cases. Preserve the
  complete 25-job regression after native success. Diagnose only observed
  failures, push precise fixes, and repeat remotely.

**Connected next step:** integrate this retained primitive through the
original-controller-bound Node/PowerShell boundary and all relevant Windows
ownership entrypoints (`state.mjs` acquisition/release and native recovery).
The integration task remains explicit in session tracking. A primitive-only
pass does not complete the approved shared-entrypoint requirement or public
Windows recovery, and must not unblock generic lock removal.

Task 5AE causal `e495cb4` / `37029435961`, native job `110912252982`,
created the actual private control directories, then failed exactly on the
missing `AcquireAdmission` method at 15:48:01 UTC. Captured before cancelling
the characterized run. The implementation follows the approved partial-class
plan and retains the existing installed nine-helper host contract.
Implementation `234bef9` / `37029680450`, native `110913330877`, passed the
actual admission fixture at 15:50:33 UTC and all three completed-task proof
scenarios at 15:52:56 UTC. Logs confirm independent contention, separate
installations, retained namespace/non-inherited handles, abrupt owner exit,
unsafe content/ACL/hard-link refusal, and unchanged operation evidence.
The full regression passed all 25 jobs, observed at 16:07:51 UTC.

### Task 5AF: original-controller-bound shared Windows admission bridge

Continue the approved design inline. This closes the Node/native boundary;
it does not yet authorize cold recovery or claim that public Windows
deploy/update/restore uses the gate. Subsequent ownership integration must
cover `state.mjs` acquire/release and `retirement-recovery.mjs`, without
private-root fixture bypasses. Existing private operation evidence survives
both graceful close and abrupt original-controller loss.

**Files and boundaries:**
- `tests/deployment-windows-admission-bridge.ps1`: create genuine private
  controls using `WindowsPrivateFile.CreateDirectory`, publish original
  evidence, invoke Node and compare evidence/gate after exit.
- `tests/deployment-windows-admission-bridge.mjs`: independent native bridge
  contention, distinct roots, retained context identity, explicit close and
  original Node controller termination.
- `scripts/deployment/windows-controller-transport.mjs`: extract the
  existing task controller's bounded stderr, `workerWire`, process-exit wait
  and failure cleanup; both clients use the same mechanism.
- `scripts/deployment/windows-admission.mjs`: explicit absolute `pwsh` and
  control, original PID/creation identity, native readiness and check/close,
  module-private WeakMap binding of each actual context to its control.
- `scripts/deployment/windows-admission.ps1`: compile the existing standalone
  `WindowsWorkerJob.cs` with both `WindowsPrivateFile` sources; reuse strict
  `Read-AgentsChatMaintenanceFields` and `ReadFrameAsync`. Hold the real
  admission lease, not an existence marker or Boolean.
- `scripts/deployment/WindowsWorkerJob.cs`: preserve existing bounded
  `WatchOwner` behavior and add `WatchOwnerUntilExit` using the same original
  PID/creation check without a lifetime deadline. An admission cannot expire
  merely because its legitimate owner has worked for thirty minutes.
- `scripts/deployment/windows-task-controller.mjs`: consume the extracted
  transport without changing maintenance requests, readiness or completion.
- Both saved-worker inventories: include the three new production helpers;
  leave the nine installed runtime helpers unchanged.
- `.github/workflows/deployment-lifecycle.yml`: add the native fixture to the
  existing completed-task proof job before its three proof scenarios.

- [x] **Step 1: publish the native failing boundary contract.**
  The PowerShell fixture creates private controls before loading the new
  module. The Node contract is:
  ```js
  const { acquireWindowsAdmission, assertWindowsAdmission } =
    await import('../scripts/deployment/windows-admission.mjs');
  const lease = await acquireWindowsAdmission({ control, pwsh });
  try {
    await assertWindowsAdmission(control, lease);
    await assert.rejects(acquireWindowsAdmission({ control, pwsh }),
      error => error.code === 'DEPLOYMENT_WINDOWS_ADMISSION_REFUSED'
        && /acquire\/busy/.test(error.diagnostic));
    await assert.rejects(assertWindowsAdmission(other, lease),
      /retained Windows admission/);
    await assert.rejects(assertWindowsAdmission(control, {
      check() { assert.fail('Forged context callback must not execute'); },
    }), /retained Windows admission/);
  } finally { await lease.close(); }
  ```
  The complete executable fixture also checks independent installation
  admission and closed-context refusal. Fork a new Node fixture controller,
  obtain its actual bridge PID/creation identity via IPC, terminate that
  exact controller, require its original bridge to exit within fifteen
  seconds and reacquire. Do not accept arbitrary acquisition failures as
  contention: require the explicit native `acquire/busy` diagnostic.

- [x] **Step 2: capture the exact causal Actions failure.**
  ```bash
  git add tests/deployment-windows-admission-bridge.ps1 tests/deployment-windows-admission-bridge.mjs .github/workflows/deployment-lifecycle.yml README.md docs/superpowers/plans/2026-09-27-cross-platform-deployment-backup.md
  git commit -m "test: require controller-bound Windows admission" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  git push origin feat/deployment-backup
  ```
  Preserve `234bef9`'s full regression. Inspect the new exact native job
  after completion; expect missing `windows-admission.mjs` only after the
  private directory/evidence PASS line. Capture before cancelling only the
  characterized causal run.

- [x] **Step 3: implement the boundary with existing transport semantics.**
  The exported validator uses an actual module-private registry:
  ```js
  const admissions = new WeakMap();
  export async function assertWindowsAdmission(control, admission, options) {
    if (!admissions.has(admission) || admissions.get(admission) !== control) {
      throw new Error('Original retained Windows admission does not match control.');
    }
    await admission.check(options);
  }
  ```
  `acquireWindowsAdmission({ control, pwsh, signal })` validates canonical
  absolute inputs, captures the current Node creation identity and starts
  the bridge with `-Control`, `-ControllerPid`, `-ControllerIdentity`.
  Validate exact ready fields `type,pid,processIdentity,control,controllerIdentity`
  against the spawned child and original controller. Freeze and register
  `{ identity, check, close }` only after this acknowledgement. Check/close
  use strictly increasing integer IDs and exact `id,type,value` replies;
  reject concurrent requests, changed process identities, lost transport
  and closed contexts. Close waits for successful native process exit and
  is idempotent only after successful closure. Failure cleanup retains both
  primary and cleanup errors and bounded stderr; use error code
  `DEPLOYMENT_WINDOWS_ADMISSION_REFUSED`, never a success-shaped fallback.

  Extract the existing task controller transport into
  `windowsControllerTransport({ pwsh, args, refused, label })`, returning
  `{ child, wire, waitForExit, abandon }`. Keep `shell:false`, sanitized
  `NODE_OPTIONS`/`NODE_PATH`, 4096-byte stderr and fifteen-second exit bound.
  The task caller continues maintaining its own closed/busy/failure state.
  Do not alter task completion behavior during this extraction.

  Native startup order is original-owner watch, `AcquireAdmission(Control)`,
  `Check`, then readiness. Use the new no-deadline watch for this bridge
  only. Check original owner identity and lease before each request.
  `ReadFrameAsync` retains its 4096-byte request limit but does not impose
  an idle/lifetime deadline while the original owner remains alive.
  Only `check` and `close` are supported; duplicate, extra, missing, skipped-ID
  or unsupported-method requests terminate with failure. Dispose the lease
  before close acknowledgement; EOF/failure also disposes it without
  touching any operation/recovery evidence. Report native sharing error32
  specifically as `Windows admission refused: acquire/busy.`; propagate
  other refusals as their actual stage, without retry or permission repair.

- [x] **Step 4: require native and full regression acceptance.**
  Publish implementation with both saved-helper inventories updated.
  Require the new native fixture and all three completed-task proof
  scenarios, then preserve the entire 25-job regression. No local
  compilation, test, installation or server. Update accepted SHA/run in
  README, this plan and the continuity artifact only from actual results.
  Then implement shared ownership entrypoint admission, including valid
  creation-time Windows fixture privacy and explicit runtime selection;
  never treat this bridge-only acceptance as public recovery completion.

Task 5AF causal `090fcd5` / `37031531441`, native `110920024799`,
failed on missing `windows-admission.mjs` at 16:08:13 UTC after the private
control/evidence PASS line. Captured before cancelling only that causal run.
Implementation preserves existing task transport and bounded watch semantics,
adds the no-deadline admission watch, and includes raw native refusals for
duplicate/extra fields, skipped IDs, unsupported mutation and oversized
frames. Implementation `c1f90f1` / `37032247968`, native `110921705338`,
passed the bridge fixture at 16:12:50 UTC and all three completed-task proof
scenarios at 16:15:08 UTC. Completed logs were captured by
`admission-bridge-implementation-watch`; the full regression passed all
25 jobs, observed at 16:34:32 UTC.

### Task 5AG: shared Windows admission at real ownership entrypoints

Continue the approved design without a new approval prompt. The accepted
bridge is necessary but insufficient: normal lock acquisition/release and
saved cold worker retirement must actually use it. Linux behavior and
read-only inspection remain unchanged.

**Files and API boundaries:**
- Add `tests/deployment-windows-admission-state.ps1` and `.mjs`, using the
  existing production private controller/token and native-created roots.
- Extend `scripts/deployment/windows-admission.mjs` with
  `withWindowsAdmission(control, { pwsh, admission }, action)`. A supplied
  context is validated by the actual WeakMap; otherwise acquire using
  explicit `pwsh`. Check before and after the action, close only an internally
  acquired context, and preserve action plus close errors.
- `scripts/deployment/state.mjs`: `acquireLock(root, options)` accepts
  `pwsh`/`admission`; `releaseLock(root, owner, options = {})` accepts the same.
  Windows must always use the native critical section, not only when the
  caller happened to supply a runtime. Preserve existing Linux paths.
- `scripts/deployment/retirement-recovery.mjs`: accept `pwsh`/`admission`,
  acquire before reading/claiming recovery authority and retain through
  final evidence/lock retirement. Recheck retained admission at mutation
  authority boundaries. The existing durable checks remain mandatory.
- `scripts/deployment/saved-recovery-engine.mjs` and
  `scripts/deployment/retirement-recovery-entry.mjs`: carry explicit Windows
  PowerShell selection across the actual saved invocation, preserving
  Linux argument shapes. Do not look up an arbitrary production runtime
  from PATH or a test-only environment variable.
- `tests/deployment-fixture.mjs`: explicitly supply the Actions-selected
  runtime in test acquire/release/recovery adapters. Adapt Windows-relevant
  state, receipt, worker-operation/retirement and retirement-recovery tests;
  child fixtures must carry the runtime too.
- Windows native-operation and task-transaction-controller fixtures must
  pass their already-selected runtime. Use the existing private controller
  and private TEMP/TMP setup for Windows suites that previously relied on
  ordinary elevated-process default ownership. Do not bypass native checks
  or add production permission repair.
- `.github/workflows/deployment-lifecycle.yml`: include the causal native
  ownership fixture in the existing proof job, then run affected Windows
  contracts/native-operation suites under valid private creation-time
  ownership. Keep Linux execution unchanged.

- [x] **Step 1: publish a genuine native entrypoint failure.**
  Create private roots and start Node through `WindowsControllerProcess`.
  The first mutation assertion uses an actual retained native lease:
  ```js
  const admission = await acquireWindowsAdmission({ control, pwsh });
  try {
    await assert.rejects(acquireLock(control, {
      project, operationId: randomUUID(), pwsh,
    }), error => error.code === 'DEPLOYMENT_WINDOWS_ADMISSION_REFUSED'
      && /acquire\/busy/.test(error.diagnostic));
  } finally { await admission.close(); }
  ```
  Before this assertion, prove read-only reconciliation creates no gate.
  Additional executable cases cover cold recovery refusal, blocked release
  preserving exact owner bytes, reuse of a real context without recursive
  acquisition, and foreign/forged context and omitted-runtime refusals.
  Expect the current implementation to fail with missing expected rejection,
  after actual private controller/root creation, not with fixture ACL errors.

- [x] **Step 2: capture causal Actions, then implement shared admission.**
  Push fixtures/plan with the required coauthor trailer. Inspect the exact
  native job and capture the missing-rejection assertion before cancelling
  only the causal run. Keep `c1f90f1` / `37032247968` as the full accepted
  25/25 baseline. Implement the Windows wrapper and entrypoints, without
  changing `reconcileInterruptedOperation` or adding automatic lock removal.
  The wrapper's error/ownership contract is:
  ```js
  export async function withWindowsAdmission(control, options, action) {
    const supplied = options.admission !== undefined;
    const admission = supplied ? options.admission
      : await acquireWindowsAdmission({ control, pwsh: options.pwsh });
    let primary;
    try {
      await assertWindowsAdmission(control, admission);
      const result = await action(admission);
      await assertWindowsAdmission(control, admission);
      return result;
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      if (!supplied) {
        try { await admission.close(); }
        catch (error) {
          throw new AggregateError([...(primary ? [primary] : []), error],
            'Windows admission action and cleanup failed.');
        }
      }
    }
  }
  ```
  Wire Windows acquire and release through this wrapper while keeping their
  admitted bodies and durable ownership guards. Recovery retains the same
  context through mutation and final unlock; a kernel lease does not replace
  original owner absence, exact evidence identity or inventory checks.

- [x] **Step 3: migrate actual callers and creation-time test ownership.**
  Carry `pwsh` through saved invocation/entry and independent fixture
  processes; no silently admitted call path remains. Reuse
  `WindowsControllerProcess.Start`, private root/TEMP/TMP, and literal
  absolute test paths. Preserve bounded process/Job and stream cleanup.
  Existing native fixtures already demonstrate Node-created private files
  under this token; do not normalize arbitrary pre-existing ACLs.
  Keep omitted runtime and fake context cases using direct production APIs
  so adapters cannot conceal an unsupported caller.

- [ ] **Step 4: require native and full acceptance, then continue recovery.**
  Publish the implementation and require the actual ownership fixture plus
  all existing bridge/proof cases. Inspect all 25 jobs; diagnose observed
  failures remotely and publish precise fixes. Update README/plan and
  continuity only from actual acceptance. This shared admission does not
  complete partial Windows task recovery, public lifecycle integration,
  cross-account configuration policy or live deployment/voice acceptance.

Task 5AG causal `4092d66` / `37035726800`, native `110933333489`,
failed at 16:44:23 UTC with the missing expected busy rejection: normal
Windows lock acquisition bypassed held native admission. The original
private Node controller and private directories were established first.
Captured before cancelling only that causal run.

The implementation uses the planned shared wrapper and explicit saved
Windows invocation arguments. Existing test adapters pass a selected runtime;
the Windows contract/native-build suites use the existing production private
controller with private TEMP/TMP. Old post-creation fixture ACL repairs are
removed. Exact control inventories now include the persistent empty gate
only where lock acquisition occurred. Linux execution and argument shapes
remain unchanged.

Recovery checks admission at its repeated authority/mutation boundaries.
To avoid spawning external PowerShell processes at every file boundary,
native check/close replies now include the bridge's actual process-creation
identity, validated against initial independently checked readiness over the
original child transport. The native side still checks the original Node
identity on every request; the client rejects original-child exit. This
preserves identity binding without two extra process launches per check.
Task-maintenance transport/reply schemas are unchanged. Native and full
Task 5AG acceptance remain pending Actions.

Implementation `e9b440d` / `37036786060` passed native ownership admission
at 16:53:35 UTC and all three completed-task proof scenarios by 16:56:12 UTC
in job `110936879725`; native Windows Job ownership also passed.
Full regression exposed two fixture migration omissions: embedded Node in
`deployment-windows-controller-token.ps1` lacked explicit `pwsh`, and the
new private test runner omitted normal Windows executable-environment
variables, causing the managed-application fixture's native invocation to
leave `LASTEXITCODE` unset. Pass the selected runtime through fixture JSON,
include the persistent gate in its exact private inventory, and preserve
`PATHEXT`, `WINDIR` and `SystemDrive` in the runner. These fixes still require
Actions acceptance; preserve the running implementation regression.

That implementation regression finished 23/25. Fix `276fe0d` /
`37037539645` passed the native completed-task proof again, but its actual
Windows build (`110944941174`, 17:18:54 UTC) now fails later, inside
runtime bundle publication. The PowerShell wrapper obscures the original
exception; the cause is not yet established. Keep this regression running.

- [x] Include the base exception's type/message in the publication failure
  while preserving its inner exception and incomplete directory.
- [x] Add a focused native runtime-bundle case with a 220-character bundle
  directory: its final helper paths remain below MAX_PATH while generated
  `.pending-<uuid>` paths exceed it. Use the existing production publisher,
  candidate checks and exact inventory, not an application rebuild.
- [x] Run the native case in Actions and compare its actual error with the
  actual-build failure before changing native path handling. Do not shorten
  the private controller namespace or relax owner/ACL/path/hash admission.
- [x] After the root-cause fix, accept all 25 jobs, including actual Windows
  startup and stopped-database restoration; the latest fully accepted
  baseline remains `c1f90f1` / `37032247968`.

The preserved `276fe0d` regression completed 24/25 at 17:36:56 UTC:
only actual Windows bundle publication failed. Diagnostic `5665d59` /
`37040382252` reproduced `Win32Exception: Publish original private evidence`
both in the short native case (`110953584821`, 17:37:12 UTC) and in the
actual application fixture (`110953584629`, 17:41:01 UTC). Native creation
of the pending file succeeds, but its generated suffix exceeds MAX_PATH
at the following `MoveFileExW`.

Use Microsoft's documented extended-length source prefix at that native
rename boundary: `MoveFileExW(@"\\?\" + pending, file, writeThrough)`.
The [MoveFileExW reference](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
documents the default source limit and explicit prefix. Keep the public
destination's existing path semantics and all retained directory, ACL,
digest and file checks; preserve same-directory, no-overwrite publication
and `MOVEFILE_WRITE_THROUGH`. Do not shorten private roots, change machine
policy, enable replacement or claim general long public-path support.
The focused case and complete actual application regression must now pass.

Fix `b08a6fe` / `37042579313` passed the focused native publication at
17:45:41 UTC, actual Windows application job `110956549448` at 17:49:26 UTC
and all native completion/admission cases in `110956549631`. The application
performed three prebuilt Scheduled Task starts with authenticated create,
mutation and restored data, original listener settlement before data access,
and stopped SQLite restoration. Task-options job `110956549685` also passed,
including the private token fixture without owner/ACL repair. Full regression
completed **25/25 success**, observed 18:07:18 UTC. Task 5AG is accepted;
`b08a6fe` is the new fully accepted baseline. This is not public Windows
recovery, task-evidence retirement or complete deployment delivery.

### Task 5AH: retained completed-task proof inside shared recovery admission

Continue the approved shared-admission design and the already selected inline
execution. Do not reopen approach/execution-mode approval. The next cleanup
intent must be based on a retained original native proof, not a one-shot JSON
report whose handles have already closed. This task joins the two existing
mechanisms; it does not introduce another lock, recovery state machine or
permission bypass. Keep standalone read-only inspection unchanged.

**Files and boundaries:**
- Create `scripts/deployment/windows-task-completion-proof.mjs`: strict
  immutable observation capture and original-child proof client. Opening
  requires an actual same-control admission context; the client never owns
  or closes its caller's admission.
- Create `scripts/deployment/windows-task-completion-controller.ps1`: bounded
  check/close transport around the existing native proof, tied to the original
  requesting Node process. It acquires no second admission handle and grants
  no task mutation or lock-release authority.
- Modify `scripts/deployment/windows-task-controller.mjs`: export its existing
  strict `captureActivatedRuntime` helper instead of duplicating that schema.
- Create `tests/deployment-windows-completion-session.mjs`: genuine retained
  proof, admission contention, forged/foreign/closed context and original
  controller-loss cases, using the existing completed native runtime.
- Modify `tests/deployment-windows-task-completion-proof-cases.ps1`: invoke
  the new test only after the existing independent native proof succeeds,
  before its deliberate state/receipt/policy/listener changes.
- Modify `scripts/deployment/saved-worker-engine.mjs` and
  `tests/deployment-saved-worker.test.mjs`: add both new production files to
  the exact saved dependency closure. Installed runtime helpers stay nine.

- [x] **Step 1: publish the real failing invocation before implementation.**

  The native driver invokes the following file after its first `Observe`.
  Use the selected `node` and current `$pwsh`; propagate a nonzero exit.

  ```powershell
  & (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-completion-session.mjs') $Control $pwsh
  Assert ($LASTEXITCODE -eq 0) 'Admitted completed-task proof session failed'
  ```

  Initial test file:

  ```javascript
  import assert from 'node:assert/strict';
  import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
  import { acquireLock } from '../scripts/deployment/state.mjs';
  import {
    openWindowsTaskCompletionProof, assertWindowsTaskCompletionProof,
  } from '../scripts/deployment/windows-task-completion-proof.mjs';
  const [control, pwsh] = process.argv.slice(2);
  await withWindowsAdmission(control, { pwsh }, async admission => {
    await assert.rejects(openWindowsTaskCompletionProof({
      control, pwsh, admission: Object.freeze({ check: async () => {} }),
    }), /Original retained Windows admission/);
    const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
    try {
      assert.equal(proof.observation.status, 'observed');
      assert.equal(proof.observation.mutationAuthority, false);
      assert.equal(proof.observation.lease, 'released');
      assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.observation)
        && Object.isFrozen(proof.observation.runtime) && Object.isFrozen(proof.observation.providers));
      assert.deepEqual(await assertWindowsTaskCompletionProof(control, proof, admission), proof.observation);
      await assert.rejects(assertWindowsTaskCompletionProof(control, { ...proof }, admission),
        /Original retained completed-task proof/);
      await assert.rejects(assertWindowsTaskCompletionProof(`${control}-foreign`, proof, admission),
        /Original retained completed-task proof/);
      await assert.rejects(acquireLock(control, { pwsh }),
        error => /acquire\/busy/.test(error.diagnostic ?? ''));
    } finally { await proof.close(); }
    await assert.rejects(proof.check(), /Completed-task proof unavailable/);
    await proof.close();
    await admission.check();
  });
  console.log('PASS: completed-task proof retains native evidence inside original shared admission without mutation');
  ```

- [x] **Step 2: capture the causal Actions failure.**

  Push the test/driver/plan commit to `feat/deployment-backup`. In the existing
  `Native Windows completed task proof` job, require the already working
  completion and fresh native observation to finish, then capture the missing
  `windows-task-completion-proof.mjs` import. Only cancel this characterized
  causal run; the accepted `b08a6fe` run is already complete.

- [x] **Step 3: implement the strict observation boundary.**

  Export the existing `captureActivatedRuntime` function. In the new client,
  use this capture without changing its accepted runtime fields:

  ```javascript
  export function captureWindowsTaskCompletionProof(value) {
    const result = captureWorkerFields(value, [
      'status', 'mutationAuthority', 'operationId', 'taskName', 'stateSha256',
      'completionSha256', 'runtime', 'port', 'providers', 'lease',
    ], 'completed task proof');
    if (result.status !== 'observed' || result.mutationAuthority !== false
      || result.lease !== 'released'
      || typeof result.operationId !== 'string'
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.operationId)
      || result.operationId === '00000000-0000-0000-0000-000000000000'
      || typeof result.taskName !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(result.taskName)
      || ![result.stateSha256, result.completionSha256].every(hash =>
        typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      || !Number.isSafeInteger(result.port) || result.port < 1 || result.port > 65535) {
      throw new Error('Invalid completed-task proof observation.');
    }
    validateReadinessProviders(result.providers);
    return Object.freeze({ ...result, runtime: captureActivatedRuntime(result.runtime),
      providers: Object.freeze([...result.providers]) });
  }
  ```

  Client imports `path`, `fileURLToPath`, `isDeepStrictEqual`, the existing
  `processIdentity`, `captureWorkerFields`, `windowsControllerTransport`,
  `validateReadinessProviders`, `captureActivatedRuntime` and
  `assertWindowsAdmission`. Keep a module-private WeakMap of actual returned
  proof objects to `{ control, admission }`. The public retained assertion is:

  ```javascript
  export async function assertWindowsTaskCompletionProof(control, proof, admission, options) {
    const binding = proofs.get(proof);
    if (!binding || binding.control !== control || binding.admission !== admission) {
      throw new Error('Original retained completed-task proof does not match admission.');
    }
    return proof.check(options);
  }
  ```

  `openWindowsTaskCompletionProof({ control, pwsh, admission, signal })`
  first checks abort, Windows platform, explicit canonical absolute paths
  (maximum 4096 characters, no NUL/CR/LF), and actual admission. Capture the
  original Node identity, then use `windowsControllerTransport` with:

  ```javascript
  args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
    '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity]
  ```

  The ready frame has exactly
  `type,pid,processIdentity,control,controllerIdentity,value`. Verify native
  PID against the original child, creation identity independently through
  `processIdentity(child.pid)`, control and original Node identity. Capture
  `value` using the function above, freeze native identity and check the
  caller's admission again before returning.

  Each request uses strictly increasing IDs and only `check` or `close`.
  For check, verify admission before and after the original native reply,
  capture its observation and require `isDeepStrictEqual` with the initial
  observation. Require exact reply fields `id,type,value,processIdentity`,
  the original native identity and a still-live original child. Close expects
  the literal value `close` and a successful bounded child exit. Close must
  work even if admission/proof checks have failed; do not require a new
  health observation to dispose retained resources.

  Use the transport's existing abandon/diagnostic/exit handling and the
  established busy/closed/failure states. Readiness waits at most 60 seconds,
  requests at most 30 seconds, exit uses the existing 15-second bound.
  Request failures poison the proof and abandon only its original child.
  Refusals use `DEPLOYMENT_WINDOWS_COMPLETION_PROOF_REFUSED`,
  `recoveryAllowed:false` and the message `Completed-task proof unavailable;
  retain operation and recovery evidence.` Return and register only:

  ```javascript
  Object.freeze({
    identity, observation,
    check: ({ signal: checkSignal } = {}) => request('check', checkSignal),
    async close() {
      if (busy) throw refused(new Error('Cannot close an active completed-task proof request.'));
      if (failure) throw failure;
      if (!closed) await request('close');
    },
  })
  ```

- [x] **Step 4: retain the native proof on the original controller transport.**

  The native entry takes only mandatory `Control`, `ControllerPid` and
  `ControllerIdentity`. Compile the existing eight sources used by
  `tests/deployment-windows-task-completion-proof.ps1`; dot-source the
  production proof. No admission partial or second lock acquisition is
  needed: the requesting Node already owns the actual shared admission.

  ```powershell
  $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
  $proof = Open-AgentsChatTaskCompletionProof -Control $Control
  $observed = Assert-AgentsChatTaskCompletionProof -Context $proof
  [Console]::Out.WriteLine((@{
      type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
      control=$Control; controllerIdentity=$ControllerIdentity; value=$observed
  } | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
  $sequence = 0
  while ($true) {
      $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
      $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
      $id = $request.id.GetInt32()
      $method = $request.method.GetString()
      if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close')) {
          throw 'Invalid completed-task proof request.'
      }
      $sequence = $id
      if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
          throw 'Original completed-task proof controller changed.'
      }
      if ($method -ceq 'close') {
          Close-AgentsChatTaskCompletionProof -Context $proof
          $proof = $null
          $value = 'close'
      } else { $value = Assert-AgentsChatTaskCompletionProof -Context $proof }
      [Console]::Out.WriteLine((@{
          id=$id; type='reply'; value=$value
          processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
      } | ConvertTo-Json -Depth 8 -Compress))
      [Console]::Out.Flush()
      if ($method -ceq 'close') { break }
  }
  ```

  Wrap bootstrap/open/request/close in the same explicit staged refusal and
  aggregated cleanup pattern as `windows-admission.ps1`. Initialize proof
  and watch to null; always close a remaining proof and dispose the watch.
  Surface the failed stage and base exception message to stderr; exit 1 on
  primary or cleanup failure. Never delete evidence or stop the runtime.

- [x] **Step 5: exercise original-controller loss and refusal boundaries.**

  Extend the native Node fixture with an IPC child mode. The child obtains
  admission, opens proof, sends both original native identities to its parent
  and remains alive. The parent terminates only that original Node child,
  waits for its exit, then polls `processIdentity` for both captured native
  identities with a 20-second bound. Require both to be absent/replaced
  without terminating a reused PID. Reacquire admission and open a new
  original proof. The surrounding PowerShell fixture verifies unchanged
  evidence hashes, task policy and original runtime/listener survival.

  Also assert a foreign control cannot use the real admission; a forged
  proof cannot use its real methods to pass the WeakMap check; and closed
  proof is unavailable while the caller's admission remains usable.
  Use actual IPC/stdio, not an injected success callback or fake native
  admission. Keep existing malformed-frame and original native proof
  refusal coverage intact.

- [x] **Step 6: complete saved closure and Actions acceptance.**

  Add `windows-task-completion-proof.mjs` and
  `windows-task-completion-controller.ps1` beside the existing proof entries
  in both saved-helper inventories. Push implementation with the standard
  co-author trailer; inspect the native proof job and preserve its full
  25-job regression. No local execution. Mark only this integration accepted
  after all jobs pass; durable intent publication, receipt retirement and
  interrupted-prefix recovery are still explicit subsequent work.

Task 5AH causal `94bb0b1` / `37046756926`, native `110970038129`,
failed at 18:22:07 UTC on the missing
`windows-task-completion-proof.mjs`, after real completion and the driver's
successful independent `Observe`. Captured before cancelling only that
causal run. The implementation reuses the original shared transport and
runtime capture, checks actual caller admission around every native check,
and retains immutable original observations with a private context binding.
The native fixture adds malformed/oversized request refusal and independent
Node-controller loss followed by disappearance of both original helper
identities and fresh acquisition. Source inventory, original runtime and
task policy must remain unchanged. Actions acceptance is pending.

Implementation `119b17e` / `37047636516` passed native proof job
`110973085205`: update at 18:30:18 UTC, restore at 18:31:18 UTC and
originally disabled policy at 18:32:22 UTC, followed by all original native
refusals in each scenario. Actual Windows application job `110973085362`
again passed authenticated create/mutate/restored data and three prebuilt
starts at 18:34:47 UTC. Full regression completed **25/25 success**, observed
18:49:38 UTC. Task 5AH is accepted and `119b17e` is the new full baseline.
No receipt retirement, operation unlock or public Windows recovery is implied.

### Task 5AI: native durable completed-task retirement intent

Continue the approved write-ahead retirement pattern. Publish one private
`task-retirement.json` while actual shared admission and the original native
completion proof are retained. This is a prepared cleanup intent, not a
deployment-success receipt or permission to release the operation lock.
Do not delete maintenance files in this task; keep all 23 original files
available for complete native replay when reopening the intent.

**Files:**
- Modify `scripts/deployment/WindowsPrivateFile.cs`: expose immutable native
  volume/file identity and retained byte length, checked through the existing
  file/directory leases. No new handle access, ACL policy or runtime helper.
- Create `scripts/deployment/windows-task-retirement-intent.ps1`: capture
  the original proof/lock/state/23-file inventory and atomically publish or
  strictly reopen the intent with `WindowsPrivateFile.Publish/Open`.
- Create `scripts/deployment/windows-task-completion-record.mjs`: extract
  existing strict completion-observation capture for shared protocol use.
  Preserve its re-export from the proof client.
- Create `scripts/deployment/windows-task-retirement-record.mjs`: strict,
  immutable intent/result capture with the same allowlisted 23-file layout.
- Modify `scripts/deployment/windows-task-completion-controller.ps1` and
  `.mjs`: add only the explicit `prepare-retirement` request; bind it to the
  existing actual proof/admission, with ordinary check/close unchanged.
- Create `tests/deployment-windows-task-retirement-intent.mjs`, invoked from
  `tests/deployment-windows-task-completion-proof-cases.ps1` after successful
  retained-session acceptance and before deliberate evidence mutation.
- Update both saved-helper inventories for the three new helper files.

- [x] **Step 1: publish the native missing-entry causal test.**

  After the existing session test, run the new Node fixture with `$Control`
  and current `$pwsh`; require success. The initial fixture imports the
  intentionally missing `prepareWindowsTaskRetirement` export:

  ```javascript
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  import { readFile, stat } from 'node:fs/promises';
  import path from 'node:path';
  import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
  import {
    openWindowsTaskCompletionProof, prepareWindowsTaskRetirement,
  } from '../scripts/deployment/windows-task-completion-proof.mjs';
  const [control, pwsh] = process.argv.slice(2);
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
    try {
      await assert.rejects(prepareWindowsTaskRetirement(control, { ...proof }, admission),
        /Original retained completed-task proof/);
      const prepared = await prepareWindowsTaskRetirement(control, proof, admission);
      assert.equal(prepared.status, 'prepared');
      assert.equal(prepared.descriptor.path, 'task-retirement.json');
      assert.deepEqual(prepared.intent.completion, proof.observation);
      const bytes = await readFile(path.join(control, prepared.descriptor.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), prepared.descriptor.sha256);
      assert.deepEqual(JSON.parse(bytes), prepared.intent);
      for (const entry of [prepared.intent.lockFile, prepared.intent.state, ...prepared.intent.files]) {
        const info = await stat(path.join(control, entry.path), { bigint: true });
        assert.equal(String(info.dev), entry.dev);
        assert.equal(String(info.ino), entry.ino);
        assert.equal(Number(info.size), entry.bytes);
      }
      assert.deepEqual(await prepareWindowsTaskRetirement(control, proof, admission), prepared);
      await proof.check();
    } finally { await proof.close(); }
  });
  console.log('PASS: native task retirement intent binds original private evidence without deletion or unlock');
  ```

  Capture the missing named export only after real completion, independent
  native observation and the existing retained-session cases pass in Actions.
  No local execution and no cancellation of the accepted full baseline.

- [x] **Step 2: add checked native identity capture.**

  Add an immutable `EvidenceIdentity` with string `Dev` and `Ino`, constructed
  from the existing native `FileInformation`:

  ```csharp
  public sealed class EvidenceIdentity
  {
      public string Dev { get; }
      public string Ino { get; }
      internal EvidenceIdentity(uint volume, uint high, uint low)
      {
          Dev = volume.ToString(System.Globalization.CultureInfo.InvariantCulture);
          Ino = (((ulong)high << 32) | low).ToString(System.Globalization.CultureInfo.InvariantCulture);
      }
  }
  EvidenceIdentity OriginalIdentity()
  {
      FileInformation information = Information();
      return new EvidenceIdentity(information.Volume, information.IndexHigh, information.IndexLow);
  }
  public EvidenceIdentity CaptureIdentity()
  {
      Check();
      EvidenceIdentity result = OriginalIdentity();
      Check();
      return result;
  }
  public int ByteLength { get { Check(); return content.Length; } }
  ```

  `DirectoryLease.CaptureIdentity()` similarly calls its existing `Check()`,
  captures `directory.OriginalIdentity()`, checks again and returns it.
  Keep the standalone base class and installed nine-helper compilation valid.

- [x] **Step 3: persist the fully bound version-1 intent.**

  The exact root fields are:

  ```text
  version, control, project, lock, lockFile, state,
  controlIdentity, lockIdentity, maintenanceIdentity,
  completion, files, creator
  ```

  Version is 1. `control` is the actual admitted canonical control; `project`
  and `lock` come from the original retained lock. File descriptors have
  exactly `path,dev,ino,bytes,sha256`; identities have exactly `dev,ino`.
  State/lock paths are exactly `state.json` and `lock\owner.json`.
  `completion` is the existing strict original native observation. Require
  its operation ID, state digest and completion digest to match lock/state
  and the final completion receipt. File entries, in order, are
  `task-maintenance\admission.json`, `task-maintenance\transaction.json`,
  followed by the 21 `task-<RecordNames>.json` entries in the established
  native replay order. Do not accept arbitrary relative paths.

  `creator` has exactly:

  ```powershell
  [ordered]@{
      pid=$ControllerPid; processIdentity=$ControllerIdentity
      bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
  }
  ```

  Verify the original requesting Node identity before/after publication.
  For every file, open with the existing native private reader, capture its
  checked identity, retained byte length and digest; preserve the original
  native proof throughout. Capture the three directory identities using
  native directory leases. Construct ordered JSON objects, including the
  nested completion runtime fields, so a fresh process can compare the
  producer's exact canonical field values. Retain the published intent in
  the proof's checked file list until proof close.

  Publish with `WindowsPrivateFile.Publish`, never Node's Windows mode bits
  or permission repair. Existing `writeWorkerFile/privateMode` only enforces
  Unix ownership and is not sufficient private Windows publication.
  Return exactly `status,descriptor,intent`, with status `prepared` and
  descriptor path `task-retirement.json`. Retain incomplete artifacts on
  publication failure; never overwrite a colliding intent.

- [x] **Step 4: reopen unchanged intent without adopting a live preparer.**

  On an existing marker, first obtain the full original native proof again.
  Open the marker with `WindowsPrivateFile.Open` and parse its exact root
  fields with `Read-AgentsChatMaintenanceFields`. Compare every non-creator
  field's raw JSON to the newly captured canonical candidate; this also
  refuses unexpected or duplicate nested fields and changed identities.
  Parse creator fields strictly and validate both PID/creation identities.
  Accept live identities only when both are exactly this same original
  Node/native proof session. Otherwise require both former identities to be
  absent with the existing original-process check. Never replace creator
  references merely to claim ownership.

  Preserve the marker's original bytes/digest/identity on reopen. Refuse
  partial JSON, foreign scope, altered paths/state/receipts, unsupported ACLs
  or hard links, leaving all original evidence and runtime untouched.
  The client captures and deeply freezes the exact result schema; require
  actual proof/admission WeakMap binding before sending `prepare-retirement`,
  and check admission/original native process around its reply.

- [x] **Step 5: complete original-actor loss and refusal coverage.**

  Extend the real Node fixture with a held IPC child that prepares the
  marker, reports both original helper identities and remains alive.
  While it is alive, competing ordinary acquisition must be busy. Terminate
  only that original Node child, wait for both native identities to vanish,
  then reopen under a fresh admission/proof and require identical marker
  bytes and file identity. Assert returned native volume/file IDs against
  Node bigint `stat` for all original files and directories.

  Alter one stored scope/path/identity field or truncate the marker, invoke
  fresh preparation and require refusal with no further writes. Restore only
  the fixture's original bytes between cases. Exercise forged proof/admission,
  same-session idempotency, foreign controls and unchanged state/lock/runtime.
  The existing native proof cases continue to verify all original receipt,
  task-policy and listener refusals after this fixture.

- [x] **Step 6: accept only after full Actions completion.**

  Update the saved closure, push implementation, read native diagnostics and
  preserve the full 25-job regression after native success. Mark this task
  accepted only on complete success. Subsequent exact/prefix retirement,
  worker handoff and atomic operation unlock remain explicitly unfinished.

**Causal evidence:** `c8a24cf / 37051846485`, native job `110986898609`,
failed at 19:09:11 UTC on the missing `prepareWindowsTaskRetirement` export,
after genuine completion and retained-session acceptance at 19:09:11 UTC.
The characterized causal run was then cancelled.

**Task 5AI acceptance:** `b30581f / 37052547806` completed all 25 jobs
successfully, observed 19:33:19 UTC. Native job `110989222192` passed intent
preparation, original-actor loss, unchanged reopen and refusal cases on update
(19:16:01 UTC), restore (19:18:35 UTC), and originally disabled tasks
(19:21:17 UTC), followed by every original completion refusal case. Actual
Windows application job `110989221920` passed three prebuilt starts and
authenticated create/mutate/restored data at 19:18:24 UTC. All implementation
steps are complete; this intent still does not delete receipts or unlock.

### Task 5AJ: exact native private-file retirement handle

Continue the approved write-ahead retirement design with the OS deletion
boundary needed by its consumer. Checking a path, closing the proof handle,
then calling path-based `Remove-Item` leaves an identity race. Do not introduce
recursive deletion or make the read-only proof's existing handles deletable.
Add an explicit exclusive retirement handle which validates the prepared
descriptor and performs deletion on that same handle. This primitive alone
does not authorize task evidence cleanup, recovery or operation unlock.

**Files:**
- Modify `scripts/deployment/WindowsPrivateFile.cs`: add a nested disposable
  `RetirementFile`, native `SetFileInformationByHandle`, and the explicit
  `RetainForRetirement(file, sha256, dev, ino, bytes)` factory. Reuse existing
  private file/directory validation. Keep the nine installed helper sources.
- Create `tests/deployment-windows-private-retirement.ps1`: native positive,
  descriptor refusal, replacement/sharing, permission/link and close cases.
- Modify `tests/deployment-windows-private-file.ps1`: invoke the focused
  retirement cases after existing private-file acceptance using the already
  compiled base class. Keep the existing Actions job rather than adding
  another full application build.
- Modify `README.md`: distinguish the primitive from accepted transaction
  retirement/unlock support.

**Verified API references:** Microsoft's
[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
requires `DELETE` access for `FileDispositionInfo` (class 4).
[FILE_DISPOSITION_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info)
contains a one-byte `BOOLEAN DeleteFile`, not a four-byte Win32 `BOOL`.
Use explicit disposition only after final checks; do not use delete-on-close
at open time, POSIX deletion flags, permission repair or replacement flags.

- [x] **Step 1: publish the native missing-method causal case.**

  The focused fixture creates an actually private native directory and
  publishes a small original receipt with the existing publisher. Capture
  its native identity, length and digest, dispose the read-only handle, then:

  ```powershell
  $retirement = [Deployment.WindowsPrivateFile]::RetainForRetirement(
      $file, $sha256, $identity.Dev, $identity.Ino, $bytes)
  try {
      $retirement.Check()
      $retirement.Delete()
      Assert (-not (Test-Path -LiteralPath $file)) 'Original private file survived retirement'
  } finally { $retirement.Dispose() }
  ```

  Invoke from the existing private-file fixture with:

  ```powershell
  & (Join-Path $PSScriptRoot 'deployment-windows-private-retirement.ps1')
  ```

  Push only to the feature branch; capture the missing native static method
  after existing private-file cases pass. Characterize/cancel this causal
  run, not the preceding complete implementation regression.

- [x] **Step 2: implement explicit exclusive retirement admission.**

  Extend the private `OpenFile` with an optional `retirement = false`; only
  this factory passes true. Existing Open and CopyTrustedSource semantics
  stay unchanged:

  ```csharp
  uint access = read | readControl | (retirement ? 0x10000u : 0u);
  uint share = retirement ? 0u : shareRead;
  retained.handle = CreateFileW(file, access, share, IntPtr.Zero,
      openExisting, openReparsePoint, IntPtr.Zero);
  ```

  Add the native declaration:

  ```csharp
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass,
      ref byte information, uint bytes);
  ```

  The factory retains the private parent directory first. It then opens
  the file with the exclusive DELETE-capable handle and reuses
  `CaptureOpenedFile` for ACL, non-link, regular-file, canonical path, size
  and exact digest validation. Compare both native identity strings and
  the retained length before returning the handle:

  ```csharp
  public static RetirementFile RetainForRetirement(string file, string sha256,
      string dev, string ino, int bytes)
  {
      RequirePath(file);
      DirectoryLease parent = OpenDirectory(Path.GetDirectoryName(file));
      WindowsPrivateFile original = null;
      try
      {
          original = OpenFile(file, sha256, true, true);
          EvidenceIdentity identity = original.CaptureIdentity();
          if (identity.Dev != dev || identity.Ino != ino || original.ByteLength != bytes)
              throw new InvalidDataException("Original retirement file identity or length differs.");
          parent.Check();
          return new RetirementFile(original, parent);
      }
      catch
      {
          try { if (original != null) original.Dispose(); }
          finally { parent.Dispose(); }
          throw;
      }
  }
  ```

- [x] **Step 3: delete only through that original checked handle.**

  The nested lease owns the file and parent, exposes no raw handle or
  arbitrary-path delete operation, and performs no deletion on ordinary
  disposal:

  ```csharp
  public sealed class RetirementFile : IDisposable
  {
      readonly WindowsPrivateFile original;
      readonly DirectoryLease parent;
      internal RetirementFile(WindowsPrivateFile original, DirectoryLease parent)
      {
          this.original = original;
          this.parent = parent;
      }
      public void Check()
      {
          parent.Check();
          original.Check();
          parent.Check();
      }
      public void Delete()
      {
          Check();
          byte disposition = 1;
          Native(SetFileInformationByHandle(original.handle, 4, ref disposition, 1),
              "Retire original private file");
          Dispose();
      }
      public void Dispose()
      {
          try { original.Dispose(); }
          finally { parent.Dispose(); }
      }
  }
  ```

  Exclusive sharing rejects existing readers and prevents new data readers,
  writers, renames and competing deletes. The retained parent prevents
  ancestor replacement. Failed checks and an ordinary close preserve the
  file. After deletion or disposal, Check/Delete refuse the disposed handle.

- [x] **Step 4: cover the destructive boundary in actual Windows Actions.**

  Extend the causal fixture using the same published private receipt:
  wrong hash, dev, ino and length each refuse and leave exact original bytes;
  original read-only proof contention refuses; after release, exclusive
  retirement blocks independent read/write/rename attempts and directory
  moves. Ordinary Dispose preserves the original receipt. Delete removes
  only that receipt and leaves a neighbouring receipt unchanged.

  Publish fresh fixtures for a widened ACL, hard link, symbolic link,
  redirected parent and changed ACL after admission. Verify refusal without
  repair/deletion. For descriptor mismatch use:

  ```powershell
  Refuses {
      [Deployment.WindowsPrivateFile]::RetainForRetirement(
          $file, $sha256, $identity.Dev, ($identity.Ino + '0'), $bytes).Dispose()
  } 'Original retirement file identity or length differs.'
  ```

  Keep the size/type checks in the existing base fixture. No local native
  compiler, test runner or server. Read the actual native output and retain
  the full implementation run, including the three completed-task intent
  scenarios and real Windows application/database restore.

- [x] **Step 5: record complete acceptance; transaction wiring follows.**

  Accept the primitive only after the native cases and every Actions job
  pass. Exact/prefix task cleanup must subsequently retain/reopen its
  prepared evidence, original runtime/policy/listener and shared admission;
  replacing the old proof handles with DELETE-capable handles must not
  bypass these checks. Worker handoff and operation unlock remain separate
  explicit transaction transitions.

**Task 5AJ causal evidence:** `8e963a5 / 37054238487`, native task-options
job `110996797719`, reached the missing `RetainForRetirement` native method
at 19:34:58 UTC after the full existing private-file fixture passed. The
characterized causal run was cancelled; the preceding Task 5AI regression
was preserved through complete success.

**Task 5AJ acceptance:** `00c9857 / 37055288448` completed all 25 jobs
successfully at 19:54:43 UTC. Native task-options job `110998382788` passed
exact handle deletion, identity/refusal and ordinary-close cases at
19:40:31 UTC, followed by ACL/link/redirected-parent refusal cases. Native
completion job `110998382687` repeated all three intent/actor-loss/refusal
scenarios successfully. Actual Windows application job `110998382206`
passed authenticated create/mutate/restored data and three prebuilt starts
at 19:43:10 UTC. This accepts the native deletion boundary, not transaction
cleanup or operation unlock.

### Task 5AK: minimal durable native runtime checkpoint for retirement

The original full proof deliberately pins all 23 receipts with read-only
handles that prevent deletion. It also requires all receipts on reopening.
Before replacing those handles with checked retirement handles, persist the
native facts required to re-observe the original runtime after a deletion
prefix. Do not weaken the full proof or duplicate the entire receipt history.
Use one small private checkpoint bound to the accepted intent, not a new
lock, a heartbeat, a compressed archive or a deployment-success claim.

This task publishes/reopens that checkpoint while full original evidence
still exists. A subsequent cleanup consumer must check the exact remaining
inventory and the original runtime against it before every deletion. This
task does not delete receipts or release the operation lock.

**Files:**
- Create `scripts/deployment/windows-task-retirement-checkpoint.ps1`:
  capture already-verified native facts and publish/reopen the fixed private
  `task-retirement-checkpoint.json`.
- Create `scripts/deployment/windows-task-retirement-checkpoint.mjs`:
  immutable exact checkpoint/result capture; no filesystem mutation.
- Modify `scripts/deployment/windows-task-retirement-intent.ps1`: extract
  its canonical private publication/reopen and creator checks for reuse by
  the two fixed retirement record names, preserving version-1 intent behavior.
- Modify `scripts/deployment/windows-task-retirement-record.mjs`: export
  its strict file descriptor, creator and process-pair capture for reuse;
  keep the original exact intent schema unchanged.
- Modify `scripts/deployment/windows-task-completion-controller.ps1` and
  `windows-task-completion-proof.mjs`: explicit `prepare-retirement-checkpoint`
  request/API with the same real proof/admission binding.
- Create `tests/deployment-windows-task-retirement-checkpoint.mjs`;
  invoke after the accepted intent test and before deliberate completion
  evidence mutations in `deployment-windows-task-completion-proof-cases.ps1`.
- Add the two helper files to both saved worker-engine inventories.
- Modify the `windows-completion-proof` job in
  `.github/workflows/deployment-lifecycle.yml`: increase only its overall
  envelope from 10 to 15 minutes for the added native checkpoint scenarios.
  The accepted original scenarios already take roughly nine minutes.
  Keep all controller/readiness/request timeouts unchanged.
- Update `README.md` with the checkpoint's exact, non-unlock boundary.

- [x] **Step 1: publish and capture the missing checkpoint entry.**

  The initial test uses actual admission and full native proof:

  ```javascript
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  import { readFile } from 'node:fs/promises';
  import path from 'node:path';
  import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
  import {
    openWindowsTaskCompletionProof, prepareWindowsTaskRetirement,
    prepareWindowsTaskRetirementCheckpoint,
  } from '../scripts/deployment/windows-task-completion-proof.mjs';
  const [control, pwsh] = process.argv.slice(2);
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
    try {
      const intent = await prepareWindowsTaskRetirement(control, proof, admission);
      const result = await prepareWindowsTaskRetirementCheckpoint(control, proof, admission);
      assert.equal(result.status, 'prepared');
      assert.equal(result.descriptor.path, 'task-retirement-checkpoint.json');
      assert.deepEqual(result.intent, intent);
      assert.deepEqual(result.checkpoint.intent, intent.descriptor);
      const bytes = await readFile(path.join(control, result.descriptor.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.descriptor.sha256);
      assert.deepEqual(JSON.parse(bytes), result.checkpoint);
      assert.deepEqual(await prepareWindowsTaskRetirementCheckpoint(control, proof, admission), result);
      await proof.check();
    } finally { await proof.close(); }
  });
  console.log('PASS: private runtime checkpoint binds original retirement intent without deleting evidence');
  ```

  Invoke with current native PowerShell, requiring zero Node exit code:

  ```powershell
  & (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-task-retirement-checkpoint.mjs') $Control $pwsh
  Assert ($LASTEXITCODE -eq 0) 'Native retirement runtime checkpoint failed'
  ```

  Push to the existing feature branch; capture the missing
  `prepareWindowsTaskRetirementCheckpoint` export after actual intent
  acceptance. Cancel only this characterized causal run.

- [x] **Step 2: capture the minimal canonical checkpoint from full proof.**

  The exact checkpoint fields are `version,intent,configuration,
  definitionSha256,securityDescriptorSha256,enabled,listener,retiredBridge,
  retiredOwner,creator`. Version is 1. `intent` is the original prepared
  marker descriptor, including its native identity and exact digest.
  `configuration` is the verified literal installed configuration path.
  Hash the exact native Scheduler XML and security descriptor, not a
  newly normalized or reconstructed policy. Capture:

  ```powershell
  function Get-AgentsChatRetirementTextHash([string]$Text) {
      $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Text)
      return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  }
  $candidate = [ordered]@{
      version=1; intent=$prepared.descriptor; configuration=$Context.Configuration
      definitionSha256=(Get-AgentsChatRetirementTextHash $Context.NativeDefinition)
      securityDescriptorSha256=(Get-AgentsChatRetirementTextHash $Context.SecurityDescriptor)
      enabled=$Context.Enabled
      listener=[ordered]@{
          pid=$Context.Completed.listenerPid.GetInt32()
          processIdentity=$Context.Completed.listenerIdentity.GetString()
          createdAt=$Context.Completed.listenerCreatedAt.GetString()
          address=$Context.Completed.listenerAddress.GetString()
          pairedRecords=$Context.Completed.listenerPairedRecords.GetBoolean()
      }
      retiredBridge=[ordered]@{ pid=$Context.BridgePid; processIdentity=$Context.BridgeIdentity }
      retiredOwner=[ordered]@{
          pid=$Context.Admission.ownerPid.GetInt32()
          processIdentity=$Context.Admission.ownerIdentity.GetString()
      }
      creator=[ordered]@{
          pid=$ControllerPid; processIdentity=$ControllerIdentity
          bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
      }
  }
  ```

  First call the accepted native `Prepare-AgentsChatTaskRetirement`, which
  checks full original proof and retains the private intent. Capture the
  fields above, then run full proof immediately before and after private
  publication. Retain the checkpoint file in the proof's checked Files list.
  Check the original requesting Node creation identity around publication.

  Reuse the intent's exact canonical-field reopen comparison and strict
  creator parsing. Existing checkpoint bytes/identity must stay unchanged;
  reopening requires that same original Node/native session or absence of
  both stored creator identities. Compare all non-creator fields with a
  fresh candidate from the full proof; no replacement or ACL repair.

- [x] **Step 3: enforce a strict, immutable Node protocol boundary.**

  Response exact fields: `status,descriptor,intent,checkpoint`.
  Status is `prepared`; descriptor path is
  `task-retirement-checkpoint.json`. Capture `intent` with the accepted
  version-1 prepared-intent codec, then require deep equality between its
  descriptor and `checkpoint.intent`.

  Reuse exact descriptor fields `path,dev,ino,bytes,sha256`; use exact process
  pairs `pid,processIdentity` and the existing four-field creator. Require a
  canonical local Windows configuration path ending in `configuration.json`,
  lowercase 64-character hashes, and Boolean enabled/pairedRecords.
  Listener createdAt is a canonical positive decimal bounded by Int64.MaxValue.
  Match the native listener's admitted address set:
  `127.0.0.1`, `0.0.0.0`, `::`, `::ffff:127.0.0.1`; pairedRecords true
  requires `::`. Deeply freeze all nested records.

  Export `prepareWindowsTaskRetirementCheckpoint(control,proof,admission,
  {signal}={})` only through the actual module-private proof binding.
  Add its explicit protocol method, preserving check/close/intent behavior.
  Require the returned intent control and completion observation to equal
  the existing original context; validate admission before/after the request.

- [x] **Step 4: exercise persistence, original actor loss and corruption.**

  Extend the initial native fixture with a held child creating both records,
  report the complete checkpoint result and both native controller identities,
  and terminate only that original Node. Verify native helpers disappear and
  fresh admission/proof reopens identical bytes, native identity and creator.
  Keep ordinary acquisition busy while the original child holds admission.

  Add strict codec cases for extra fields, invalid listener identity/time/
  address/pairing, non-Boolean policy and mismatched intent descriptor.
  Change one stored policy hash, original listener timestamp or intent
  descriptor; preparation must refuse without rewriting. Truncate/duplicate
  checkpoint fields and substitute a live creator; require refusal. Restore
  only fixture bytes between negatives. Keep all 23 original files, state,
  lock and runtime policy untouched; existing completion refusal tests follow.

- [x] **Step 5: accept full Actions regression before partial cleanup use.**

  Preserve all 25 implementation jobs after native success, including actual
  Windows application data restore and exact private-file deletion. Record
  native logs and full run conclusion, then implement the checkpoint reader
  and prefix-cleanup consumer. The checkpoint is not itself permission to
  bypass remaining-evidence, original-runtime or worker-handoff checks.

**Task 5AK causal evidence:** `1f2f708 / 37057709392`, native job
`111006401762`, reached the missing `prepareWindowsTaskRetirementCheckpoint`
export at 20:04:05 UTC after genuine retained intent acceptance in the same
second. The characterized causal run was cancelled. The implementation
extracts canonical private publication/reopen for the two fixed retirement
record names, preserves the original intent schema, and adds the strict
checkpoint with original-actor-loss and corruption coverage. Full acceptance
remains pending.

The initial implementation `cf54be0 / 37058475936` exposed an extraction
error: the two new process/creator exports were accidentally nested inside
`processPair`. Linux contracts (`111008914746`) and native proof
(`111008914944`, 20:09:08 UTC) both reported `Unexpected token 'export'`.
Move both exports to module scope without changing the capture checks, then
repeat the complete Actions run. No checkpoint behavior was accepted by
that failed import.

**Task 5AK acceptance:** corrected `cb7a2aa / 37058867876` completed
all 25 jobs successfully at 20:46:21 UTC. Native job `111015913769`
passed original-actor-loss/reopen and policy/listener/intent/live-creator
refusals for update (20:30:23 UTC), restore (20:33:40 UTC), and originally
disabled tasks (20:37:03 UTC), followed by every prior intent/full-proof case.
Both contract jobs passed. Actual Windows application `111015913642`
passed authenticated create/mutate/restored data and three prebuilt starts
at 20:30:50 UTC. The initial `cf54be0` run was retained through all jobs:
22 passed, and the three known import-failure jobs failed. The accepted
checkpoint still preserves all receipts and does not implement partial cleanup
or operation unlock.

### Task 5AL: preserve ordinary ownership guards after task receipt cleanup

Before a consumer can remove the task-maintenance directory, both durable
root records must independently prevent ordinary admission, unlock and
worker-retirement recovery. Otherwise directory removal would make remaining
Windows retirement evidence invisible to the existing maintenance checks.
Preserve read-only reconciliation and the existing Linux live-retirement
exception; it must not exempt Windows task-retirement evidence.

**Files:**
- Modify `scripts/deployment/state.mjs`: one shared entry predicate for
  `requireNoServiceMaintenance` and read-only `reconcileInterruptedOperation`.
- Modify `tests/deployment-state.test.mjs`: test each root marker without
  the task-maintenance directory, including empty/truncated marker contents.
- Modify `tests/deployment-windows-admission-state.mjs`: actual native
  admission, lock release, fresh acquisition and worker-recovery refusals.
- Update `README.md` to state the remaining root-marker barrier.

- [x] **Step 1: publish the missing root-marker guard cases.**

  For each of `task-retirement.json` and
  `task-retirement-checkpoint.json`, obtain an ordinary lock, write only the
  root marker, then require:

  ```javascript
  await assert.rejects(releaseLock(root, lock), /maintenance/i);
  await assert.rejects(requireNoServiceMaintenance(root, { allowLiveRetirement: true }), /maintenance/i);
  assert.equal((await reconcileInterruptedOperation(root)).status, 'blocked');
  assert.deepEqual(await readFile(ownerPath), originalOwnerBytes);
  ```

  A second fresh control with only an empty root marker must refuse
  acquisition and report blocked rather than idle. Run through the existing
  Actions contracts, capture the missing rejection and preserve the accepted
  `cb7a2aa` baseline. Do not run tests locally.

- [x] **Step 2: share the exact maintenance predicate.**

  Add and use:

  ```javascript
  function serviceMaintenanceEntry(name, allowLiveRetirement = false) {
    const entry = process.platform === 'win32' ? name.toLowerCase() : name;
    return entry.startsWith('service-')
      || ['task-maintenance', 'task-retirement.json', 'task-retirement-checkpoint.json'].includes(entry)
      || (!allowLiveRetirement && entry === 'live-retirement.json');
  }
  ```

  `requireNoServiceMaintenance` checks
  `(await readdir(directory)).some(name => serviceMaintenanceEntry(name, allowLiveRetirement))`.
  Read-only reconciliation uses the same predicate with no exception before
  interpreting owner/state. Keep the existing refusal error and blocked
  response, including their operation/phase details. Do not inspect marker
  contents, remove evidence, create admission resources during inspection,
  or introduce a task-retirement bypass.

- [x] **Step 3: exercise the actual Windows entrypoints.**

  Extend the retained native-admission fixture. For each root marker,
  acquire an ordinary lock under the actual admission, save its owner bytes,
  create the marker, and require release/reconciliation refusal. Require
  `recoverRetirement({control,...options,admission})` to return
  `DEPLOYMENT_RECOVERY_UNSETTLED` caused by the maintenance guard, without
  creating recovery evidence or changing the original owner bytes.

  Remove only the fixture marker, release the original fixture lock, then
  recreate an empty marker with no lock/directory. Fresh acquisition must
  refuse and reconciliation must remain blocked. Clean up that named fixture
  marker and confirm ordinary admission still works. Keep all existing
  competing/forged/foreign-admission and non-mutating inspection tests.

- [ ] **Step 4: require native and complete Actions acceptance.**

  Push the implementation and retain its full regression. Read native
  admission-state output and require both platform contracts plus all
  remaining jobs to pass. This wires a necessary cleanup barrier only;
  actual exact/prefix retirement and final worker/unlock handoff follow.

**Task 5AL causal result:** `402261e / 37062928408` Linux contracts
`111023657159` failed at 20:49:01 UTC on both root markers with
`Missing expected rejection` at ordinary lock release. Both existing
service/task-directory barriers passed immediately before these failures.
Captured the causal log and cancelled this characterized run.

**Implementation scope:** the shared predicate and actual admission fixture
are implemented. Native fixtures also use each marker's uppercase spelling,
because Windows case aliases must not hide remaining evidence. Linux
continues using case-sensitive names. Actual native and full acceptance
remain pending until the implementation run finishes.

**Task 5AL native result / CI envelope:** `b078486 / 37063208496`
passed the actual admission guard cases in job `111024634816`, followed by
all three completion/intent/checkpoint scenarios. Windows contracts
`111024634773` reported 332 passing assertions and zero failures, followed
by all five two-test cold-retirement samples passing. The job nevertheless
reached its 10-minute total envelope (20:51:53 to 21:01:56 UTC) and was
reported cancelled. It is not a green full regression. Increase only the
Windows contracts job envelope to 15 minutes; keep Linux at 10 minutes,
all five samples, and every individual process/request/readiness deadline.
Preserve the existing run through completion and require subsequent full
acceptance with the corrected envelope.

### Task 5AM: checkpoint-backed receipt retirement and interrupted-prefix recovery

**Boundary:** retain original state, lock, both root records, native runtime,
policy, released lease and original listener throughout receipt retirement.
Use the existing native controller for live transfer. It must open/check the
new scope before closing the full proof; the old full-proof object then becomes
unavailable. A fresh process may open the same scope only after both recorded
creator identities are absent. No second lock, receipt archive, owner rewrite,
runtime adoption, task-policy mutation or automatic operation unlock.

**Files and responsibilities:**
- `scripts/deployment/windows-task-retirement-scope.ps1`: native private
  record reopening, retained checkpoint authority, strict ordered inventory,
  exact next-file retirement and disposal.
- `scripts/deployment/windows-task-completion-proof.ps1`: share original
  runtime/policy/instance/lease/domain assertions without weakening full-proof
  receipt or original-process checks.
- `scripts/deployment/windows-task-completion-records.ps1`: share the fixed
  completion record order and runtime field capture.
- `scripts/deployment/windows-task-completion-controller.ps1`: live
  `begin-retirement`, cold retirement mode, `retire-next`, mode-safe check/close.
- `scripts/deployment/windows-task-completion-proof.mjs`: original
  admission-bound live transfer and fresh retirement opening; separate
  WeakMap bindings prevent copied or foreign objects from authorizing deletion.
- `scripts/deployment/windows-task-retirement-scope.mjs`: strict immutable
  `{status:'retiring', retiredFiles, checkpoint}` observation codec.
- `scripts/deployment/saved-worker-engine.mjs` and
  `tests/deployment-saved-worker.test.mjs`: exact installed helper closure.
- `tests/deployment-windows-task-retirement.mjs`: a genuine destructive
  completion scenario, separate from all existing receipt mutation fixtures.
- Runtime-host/task-node/transaction-controller/activation-case fixture routes:
  a new `activate-complete-retirement` action and update/restore/disabled
  scenarios.
- `.github/workflows/deployment-lifecycle.yml`: one independent native
  retirement job, retaining the existing 25-job regression.

- [ ] **Step 1: publish a genuine causal retirement fixture.**

  After actual native task completion and original transaction-controller
  settlement, call the existing completion module and require:

  ```javascript
  assert.equal(typeof api.beginWindowsTaskRetirement, 'function');
  assert.equal(typeof api.openWindowsTaskRetirement, 'function');
  assert.equal(typeof api.retireNextWindowsTaskFile, 'function');
  ```

  The fixture's held child acquires actual admission, opens full proof and
  transfers it. Require the original native process identity to stay equal,
  full-proof check/prepare to refuse after transfer, and copied/foreign
  retirement/admission bindings to refuse. Retire exactly three original
  receipts, send the original checkpoint and native identities over IPC, then
  let the parent terminate that specific child. Require both native proof and
  admission processes to exit with the original Node owner.

- [ ] **Step 2: reopen only a contiguous missing prefix.**

  The parent reopens the same checkpoint after creator loss. Preserve the
  checkpoint result exactly and require `retiredFiles === 3`. Each original
  descriptor must still have its fixed allowlisted path, dev/ino, byte count
  and SHA256. Retain the original control, lock and maintenance directories.
  Reject unknown maintenance entries, a missing file after the first remaining
  file, changed bytes, same-byte replacement, changed checkpoint/native policy,
  changed original listener and a recorded creator still alive.

  Prefix inference is constrained to the original ordered descriptor array:

  ```javascript
  let retiredFiles = 0;
  let remainingStarted = false;
  for (const descriptor of checkpoint.intent.intent.files) {
    if (present.has(descriptor.path)) remainingStarted = true;
    else if (remainingStarted) throw new Error('Non-prefix retirement inventory.');
    else retiredFiles++;
  }
  ```

  Native code performs the inventory check against the retained private
  directory and opens/checks every remaining descriptor, not just its name.
  A live scope fixes its observed prefix; subsequent unexpected disappearance
  or reappearance poisons it rather than changing that prefix.

- [ ] **Step 3: preserve native runtime authority across live handoff.**

  Open/check the checkpoint scope while the full proof still holds all its
  handles. Both creator pairs must either match the exact current Node/native
  identities or be absent. Retain both marker files, exact original
  state/owner files and directory identities, the current installed bundle,
  original readiness, runtime process handle and listener.

  Hash the exact current Scheduler XML/SDDL and compare with the stored
  checkpoint before retaining their strings for subsequent exact comparison.
  Require original task instance GUID, owner PID/creation/session, launcher,
  released lease, native Job and original listener fingerprint, using shared
  completion assertions. Do not reconstruct or install task policy.

  Close the full proof only after the new scope passes. Then invalidate its
  Node facade without closing the native process now owned by the retirement
  facade. Any handoff failure closes both retained scopes and preserves every
  receipt. Original controller exit still terminates the same native child.

- [ ] **Step 4: delete only the next exact receipt through its checked handle.**

  Before mutation, check the entire remaining inventory and original runtime.
  Release only the target receipt's read handle, then call the accepted
  `WindowsPrivateFile.RetainForRetirement(path, sha256, dev, ino, bytes)`.
  Recheck original authority and the exclusive target before invoking
  `Delete()`. Advance the in-memory prefix by one only after that call returns;
  check the new inventory and runtime again before acknowledging.

  The request has only `{id,method:'retire-next'}`; there is no caller-supplied
  path or count. Every reply retains the exact original checkpoint and must
  report the previous count plus one. At count 23, retain the empty
  task-maintenance directory, both root markers, state and original owner.
  Exhausted, closed, foreign or poisoned authority cannot delete anything.

- [ ] **Step 5: accept interruption and genuine three-scenario regression.**

  Corruption cases rename original fixture files out and back, preserving
  their native IDs; do not delete/recreate authentic receipts. Remove only
  named synthetic replacement/extra files. After actor death and strict
  refusal cases, reopen at prefix three and retire the remaining twenty
  receipts. Require the directory empty and state/owner bytes unchanged.
  Close/reopen at prefix 23, with the exact same checkpoint and live original
  runtime. Ordinary acquisition remains blocked by Task 5AL.

  Run only in Actions:

  ```powershell
  ./tests/deployment-windows-runtime-host.ps1 -Scenario transaction-activate-complete-retirement
  ./tests/deployment-windows-runtime-host.ps1 -Scenario transaction-activate-complete-retirement-restore
  ./tests/deployment-windows-runtime-host.ps1 -Scenario transaction-activate-complete-retirement-disabled
  ```

  Capture the missing API failure before implementation. Preserve the
  implementation's complete run and require all 26 jobs. Empty-directory
  retirement, worker evidence handoff and final operation unlock remain the
  next explicit boundary; this step must not claim they already work.

- [ ] Share installed literal npm command discovery in
  `linux-service-inspection.mjs`; keep running discovery intact and dispatch
  inactive/failed runtime accounts to a focused inactive discovery helper.
  Read the supported npm interpreter and resolve the first executable Node
  using the retained startup PATH. Check both the named candidate and its
  canonical target are outside the project before returning the canonical
  Node path (matching running discovery/snapshot identity).
- [ ] Recheck executable resolution and configuration-file policy alongside
  every returned inactive authority method. Do not lose higher-priority PATH
  appearance checks when consumers request policy-only or inhibited checks.
  Running service observation must also bind `/proc/MainPID/exe` to the
  declared Node target, including post-activation checks.
- [ ] Use one validated original-history helper in `linux-deployment.mjs`,
  `linux-restore.mjs` and `linux-preflight-refusal.mjs`: running keeps its
  original InvocationID, stopped keeps the opaque full-observation marker.
  Report `running: false` to the transaction engine and do not invoke current
  deployment/no-op admission for an originally stopped service.
- [ ] Preserve snapshot/build/stopped authority and ordinary source/account
  privilege fences; reuse existing transaction recovery behavior, which only
  restarts a prior runtime when it was actually running.
- [ ] Wire `linux-restore-entry.mjs` live-owner recovery through installed
  discovery and verify supplied saved native fields against the discovered
  service. Cold dispatch remains separately journal-bound. Update the explicit
  saved dependency closure for new discovery imports.
- [ ] Update public help/README for the newly accepted installed states only
  after their actual entry paths are wired. Read-only preview must preserve
  the original stopped state and not claim liveness.
- [ ] Run the two additional real lifecycle jobs and all 20 original gates;
  do not substitute the lightweight fixtures for public Next.js acceptance.

**Readiness acceptance:** `be135a564e0a15fe0fc52b18eff9f61f0f36ec1f` /
Actions `36423061540` passed all nine jobs. Real non-root HTTP listeners passed
IPv4 and dual-stack checks; the foreign listener received no probe.

### Bounded readiness startup wait

Causal `c068a0e` / `36423114774` requires bounded waiting for an owned endpoint
to leave HTTP 503 startup state, cancellation of an unfinished response at the
stage deadline, and no retry of incompatible authentication-provider responses.
Only the explicit no-listener-yet and HTTP 503 conditions are retryable.
Ownership changes, ambiguity, malformed response and provider mismatch are final
errors. Every retry re-establishes native listener ownership. The existing stage
runner supplies deadline, cancellation and settlement semantics; no local server
or validation was used. Full implementation acceptance is pending.
