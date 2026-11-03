# Simple deployment with releases, rollback and data snapshots

## Goal

Replace PR #3's transactional deployment framework (379 files, ~49k lines under
`scripts/deployment/`) with a small, maintainable design that still provides:

- a failed install/build never affects the running app;
- a failed health check rolls back automatically;
- manual rollback to any of the last 3 versions without rebuilding, restoring
  the chat data that matches that version;
- a chat-data snapshot before every switch;
- a deploy that crashes or is killed can be re-run safely.

Target size: about 800–1,000 new lines. Built fresh from `main` on
`feat/simple-deploy`; PR #3 stays open as a reference until this is accepted.

## Non-goals

- Recovering from every possible interruption point with proofs/journals.
- Process-ownership, ACL or native-handle verification.
- Zero-downtime switching (a short stop/start is acceptable).
- Automatic database downgrade migrations (old code is paired with old data).

## Layout

`-ProjectDir` / `--project-dir` (env `AGENTS_CHAT_PROJECT_DIR`) is the
deployment folder, not a git checkout:

```
<ProjectDir>/
  repo/                 git clone; the only build workspace (node_modules, .next)
  releases/<sha>/       standalone output (~70 MB): server.js, .next/static,
                        public/, scripts/ (start/watchdog), links into shared/
  current               symlink (Linux) / junction (Windows) -> releases/<sha>
  shared/               .data/ logs/ .env.local agents.json nodes.json
  backups/<sha>-<utc>/  *.db copied from shared/.data just before switching away
                        from <sha>; plus pre-migration service definitions
  state.json            see below
  deploy.lock           {pid, startedAt}
```

The app resolves `.data`, `logs`, `.env.local`, `agents.json` and `nodes.json`
from its working directory. The standalone `server.js` sets its working
directory to its own folder, so each release links these names to `shared/`
(directory symlinks/junctions for folders, file symlinks for files; both
platforms run elevated).

Retention: keep 3 releases and 3 backups. Never prune `current` or the most
recent previous release. Prune only after a successful operation.

### state.json

```json
{
  "current": "<sha>",
  "previous": ["<sha>", "<sha>"],
  "verified": true,
  "pending": null,
  "lastResult": {"op": "update", "from": "<sha>", "to": "<sha>",
                 "outcome": "succeeded|rolled-back|failed", "step": "health",
                 "at": "<iso>", "message": "..."},
  "lockHash": "<sha256 of package-lock.json for current build>"
}
```

`pending` is `{op, from, to, step, backup}` and is written before the stop and
cleared after the operation finishes. `verified` is false after `-NoWait`.

## Components

| File | Purpose |
|---|---|
| `scripts/deploy/core.mjs` | Operations: install, import, update, rebuild, restore, status, dry-run. Reads/writes `state.json`, lock, preflight, build, stage, snapshot, switch, health, rollback, prune. |
| `scripts/deploy/state.mjs` | Pure helpers (unit-tested): rollback target selection, prune selection, crash-recovery decision from `pending`, stale-lock detection, preflight evaluation. |
| `scripts/deploy/service-linux.mjs` | systemd: write/restore unit, `stop`, `start`, `is-active`. |
| `scripts/deploy/service-windows.mjs` | Scheduled Task via PowerShell: read existing task settings, register (through `install-scheduled-task.ps1`), stop, start, disable/enable triggers, export/import XML. |
| `scripts/deploy.ps1`, `update.ps1`, `restore.ps1` | Thin wrappers: elevation + Node 24 check, map parameters, run `core.mjs`. |
| `scripts/deploy.sh`, `update.sh`, `restore.sh` | Same for Linux (root check). |
| `scripts/install-scheduled-task.ps1` | Kept; `-UserId` defaults to the current account (no hardcoded identity); watchdog path points at `<ProjectDir>\current\scripts\`. Accepts start options (tunnel mode) to pass to the watchdog. |
| `scripts/service-watchdog.ps1` | Kept; passes start options through; runs `start.ps1 -NoBuild`. |
| `scripts/start.ps1` | Adds `-NoBuild`: skip clean/build and run `node server.js` from the release. Default (dev use) unchanged. |
| `scripts/agents-chat.service` | Template: `WorkingDirectory=<ProjectDir>/current`, `ExecStart=<node> server.js`, `Environment=PORT=3010`. |
| `app/api/health/route.ts` | Public `GET`, returns `{ok, version}` after opening the chat DB; 500 on failure. Excluded from the auth middleware matcher. |
| `scripts/package-release.mjs` | Reused for staging the standalone output into `releases/<sha>`. |

Removed relative to PR #3: `scripts/deployment/*`, its tests and the
`deployment-lifecycle.yml` workflow. `update.*` and `restore.*` are rewritten
as thin wrappers.

Ports stay as on `main`: Windows 3000 (tunnel and Azure AD redirect URIs use
it), Linux 3010. `-Port`/`--port` overrides for the health check and service.

## Commands

Windows (elevated PowerShell); Linux uses the same scripts as `.sh` with
kebab-case flags.

| Task | Command |
|---|---|
| First install | `deploy.ps1 -ProjectDir <dir>` (`-Repo <url>`, `-Revision`, `-TaskLogonType`, `-TaskTriggerType`, `-NoTunnel` / `-Cloudflare`) |
| Migrate existing checkout | `deploy.ps1 -ProjectDir <new dir> -ImportFrom <old checkout>` |
| Upgrade | `update.ps1 -ProjectDir <dir>` (refuses if not installed) |
| Specific commit | `update.ps1 -ProjectDir <dir> -Revision <sha>` |
| Rebuild current | `deploy.ps1 -ProjectDir <dir> -SkipGitPull` |
| Restore | `restore.ps1 -ProjectDir <dir> [-Revision <sha>] -AcceptDataLoss` |
| Preview | `update.ps1 -ProjectDir <dir> -DryRun` |
| Status | `update.ps1 -ProjectDir <dir> -Status [-Json]` |
| Remove task | `deploy.ps1 -ProjectDir <dir> -RemoveTask` (Windows only) |
| Skip `npm ci` | `-NoInstall` / `--no-install`; refused if `package-lock.json` hash differs from `state.lockHash` |
| Skip health wait | `-NoWait` / `--wait 0`; release marked unverified, no automatic rollback |
| Health wait | `-WaitSeconds N` / `--wait N`, default 120 |

`-Json` prints one result object on stdout; progress goes to stderr.
Exit code 0 = succeeded, 1 = failed (old version still running or restored),
2 = invalid usage or preflight refusal.

## Flows

### Preflight (all mutating commands; the whole of `-DryRun`)

- Elevated / root; Node 24 on PATH; Git available (not needed by restore).
- Lock free (a lock whose PID is not alive is stale and is taken over).
- Disk: free space ≥ 1.5 GB + 2 × size of `shared/.data` (restore: 2 × data).
- Install: `shared/.env.local` exists (or `-ImportFrom` has one); no service
  or task with the name already exists; ProjectDir is absent or contains only
  `shared/`.
- Update/restore: `state.json` exists; service/task exists.
- `-DryRun` prints the plan (from → to, steps) and check results, changes nothing.

### Crash recovery (start of every mutating command)

If `state.pending` is set, the previous run was interrupted. Undo it before
anything else: stop the service, point `current` to `pending.from`, restore
`pending.backup` if it was taken, start, health-check, clear `pending`, record
`lastResult.outcome = "failed"` with the interrupted step. All steps are
idempotent (re-linking, re-copying, start/stop when already in that state).
For an interrupted install (`from` is null), remove the service definition
and leave the folder for inspection.

### Update / rebuild

1. Build in `repo/`: `git fetch`, `git checkout --detach <target>`, `npm ci`
   (unless `-NoInstall`), `npm run build`. App keeps running. Failure: stop,
   record failed, exit 1.
2. Stage to `releases/<target>/` (reuse if already staged with a matching
   build), create links to `shared/`.
3. Write `pending {step: "switch", from, to}`.
4. Windows: disable task triggers. Stop service; wait until port is free
   (timeout 60 s).
5. Copy `shared/.data/*.db` (and `-wal`/`-shm` if present) to
   `backups/<from>-<utc>/`; record it in `pending.backup`.
6. Point `current` to `<target>`; start; Windows: re-enable triggers.
7. Health: poll `GET http://127.0.0.1:<port>/api/health` until 200 or timeout
   (skipped with `-NoWait`, then `verified=false`).
8. Success: `current=target`, push `from` to `previous`, clear `pending`,
   save `lockHash`, prune, record succeeded.
   Failure: stop, point `current` to `from`, restore the backup, start,
   health-check, clear `pending`, record rolled-back, exit 1.

### Restore

Target: `-Revision` or `previous[0]`; it must exist in `releases/` with a
backup taken when switching away from it. Without `-AcceptDataLoss`, refuse
with a message explaining that chats newer than that backup will be removed.
Then: write `pending`, disable triggers, stop, snapshot current data to
`backups/<current>-<utc>/` (so the restore itself can be undone), point
`current` to the target, copy the target's backup into `shared/.data`, start,
health-check, update state. On health failure, undo exactly like an update.

### Install and migration

Fresh install: clone `-Repo` (default: `origin` URL of the checkout the
script is run from) into `repo/`, build, stage, register the service/task
(Windows: `install-scheduled-task.ps1` with current account and given logon
type/trigger/tunnel mode), start, health-check, write `state.json`. Failure
removes the registered service/task.

Migration (`-ImportFrom <old>`):

1. Preflight also checks that the old checkout has `.env.local` and that the
   existing task/unit points into it.
2. Clone the old checkout's `origin` into `repo/`, check out the commit the
   old checkout is on (or `-Revision`), build, stage. Old app keeps running.
3. Copy `.env.local`, `agents.json`, `nodes.json` into `shared/` (copy, not move).
4. Save the existing task XML / unit file to `backups/`.
5. Stop the old service; wait for the port; copy `.data/` and `logs/` into `shared/`.
6. Re-point: Windows re-registers the same task name keeping account, logon
   type, trigger and start arguments; Linux rewrites `WorkingDirectory` and
   `ExecStart`, keeping `User`, `Environment`, `EnvironmentFile` and drop-ins.
7. Start and health-check. Success writes `state.json`. Failure restores the
   saved task XML / unit, starts the old app and reports.

The old checkout is never modified; the user deletes it when satisfied.

### Remove task (Windows)

Stop and unregister the task. Releases, data and backups are kept.

## Testing

Unit (`node --test tests/deploy/*.test.mjs`, no new dependencies): rollback
target, pruning, crash-recovery decision for each `pending.step`, stale lock,
preflight evaluation, `-NoInstall` lock-hash check. About 15 cases.

E2E (`.github/workflows/deploy.yml`, one `ubuntu-latest` job with systemd and
one `windows-latest` job with a Scheduled Task). The test creates a local bare
repo as `origin` and adds commits to it; no product test hooks. A marker row is
written to `shared/.data/chats.db` with the built `better-sqlite3`.

1. Migration from a `main`-style checkout and service; marker kept; old checkout unchanged.
2. Upgrade to a commit with a different health `version`; marker kept.
3. Build-breaking commit: update fails, old version keeps serving throughout.
4. Health-failing commit: automatic rollback; previous version and data serve.
5. Second marker, then `restore -AcceptDataLoss`: marker 1 present, marker 2 gone.
6. Kill `update` once `pending` appears; re-run; recovers and ends healthy.
7. `-NoInstall` refused after a lock change; `-NoWait` reports unverified.
8. Windows: task logon type, trigger and tunnel argument preserved; `-RemoveTask`.

All validation runs in GitHub Actions.

## Documentation

Rewrite the README "Deployment" sections for the commands above: prerequisites,
install, migrate, update, restore, status, file layout and troubleshooting.
