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

- [ ] **Step 1: Add causal contract tests.**

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

- [ ] **Step 2: Push tests and collect causal red in Actions.**

```bash
git add tests/deployment-owned-worker.test.mjs .github/workflows/deployment-lifecycle.yml docs/superpowers/plans/2026-09-27-cross-platform-deployment-backup.md
git commit -m "test: define native worker admission and settlement ordering" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

Expected red: missing `owned-worker.mjs`. Workflow runs the exact new test file
alongside existing deployment contracts, on Linux and Windows.

- [ ] **Step 3: Implement coordinator with the following core structure.**

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

- [ ] **Step 4: Push implementation and require green on both platforms.**

```bash
git add scripts/deployment/owned-worker.mjs
git commit -m "feat: coordinate owned worker admission and settlement" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin feat/deployment-backup
gh run list -R xujxu/agents-chat --workflow deployment-lifecycle.yml --branch feat/deployment-backup --limit 1 --json databaseId,headSha,status,conclusion
```

- [ ] **Step 5: Record accepted code/run and carry native integration forward.**

N2 cannot unblock existing deployment state, release a lock, or establish OS
ownership itself. Durable storage/private engine, concrete platform transport,
original-handle/cgroup observations, crash reentry and all eight real-process
groups remain required before public script integration.
