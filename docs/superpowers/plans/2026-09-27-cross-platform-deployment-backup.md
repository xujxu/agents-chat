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
