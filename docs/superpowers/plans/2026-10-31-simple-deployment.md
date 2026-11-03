# Simple Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-10-31-simple-deployment-design.md`:
release folders + `current` link, DB snapshots, automatic and manual rollback,
crash-safe re-runs, on Windows (Scheduled Task) and Linux (systemd).

**Architecture:** One Node core (`scripts/deploy/core.mjs`) runs every
operation. Pure decisions live in `scripts/deploy/state.mjs` (unit-tested);
filesystem/process helpers in `scripts/deploy/fsops.mjs`; platform service
control in `service-linux.mjs` / `service-windows.mjs`. The six public
scripts are thin wrappers. All validation runs in GitHub Actions.

**Tech Stack:** Node 24 (ESM, `node:test`, `node:sqlite` in tests only),
PowerShell 5.1+/7, Bash, systemd, Windows Task Scheduler, Next.js standalone.

---

## File map

| File | Responsibility |
|---|---|
| `app/api/health/route.ts` | Public health: opens chat DB, returns `{ok, version}` (`version` from `REVISION` file in cwd) |
| `middleware.ts` | Exclude `api/health` from auth matcher |
| `scripts/deploy/state.mjs` | Pure state transitions and decisions |
| `scripts/deploy/fsops.mjs` | Links (symlink/junction), copy dir, disk free, lock file, run command, HTTP poll |
| `scripts/deploy/service-linux.mjs` | Unit render/rewrite/backup/restore, stop/start, port wait |
| `scripts/deploy/service-windows.mjs` | Task read/register/export/import, disable/enable, stop tree, start |
| `scripts/deploy/core.mjs` | CLI parsing + operations (install, import, update, rebuild, restore, status, dry-run, remove-task) |
| `scripts/deploy.{ps1,sh}`, `update.{ps1,sh}`, `restore.{ps1,sh}` | Wrappers: privilege + Node 24 check, map flags, exec core |
| `scripts/install-scheduled-task.ps1` | Default user = current account; `-StartArguments` passed to watchdog |
| `scripts/service-watchdog.ps1` | Accept `-StartArguments`; no hardcoded user PATH; launch `start.ps1 -NoBuild …` |
| `scripts/start.ps1` | `-NoBuild` (run `node server.js` with recorded node), `-Port` |
| `scripts/agents-chat.service` | Template for release layout |
| `tests/deploy/state.test.mjs` | Unit tests |
| `tests/deploy/e2e-linux.sh`, `tests/deploy/e2e-windows.ps1`, `tests/deploy/marker.mjs` | E2E scenarios |
| `.github/workflows/deploy.yml` | unit + linux-e2e + windows-e2e |

## Data model (`state.json`)

```json
{ "current": null, "previous": [], "verified": false, "pending": null,
  "lastResult": null, "lockHash": null, "backups": {}, "service": {} }
```

- `backups[sha]` = backup folder name holding the `.data` copy taken when
  switching away from `sha` (the data that matches `sha`).
- `pending` = `{op, from, to, step, backup}`; written before the stop.
- `service` = platform settings recorded at install/import (task name,
  logon type, trigger, start arguments, port; unit user).

## Tasks

### Task 1: Health endpoint
- [ ] Create `app/api/health/route.ts` (`dynamic = 'force-dynamic'`, `runtime = 'nodejs'`): `getDb().prepare('select 1').get()`, read `REVISION` from `process.cwd()` if present, return `{ok:true, version}`; on error 500 `{ok:false}`.
- [ ] Add `api/health` to the negative lookahead in `middleware.ts` matcher.
- [ ] Commit `feat: add public health endpoint for deployments`.

### Task 2: Pure state helpers (TDD)
Functions (all pure, exported from `state.mjs`):
`emptyState()`, `DeployError(code, message, exitCode)`,
`chooseRestoreTarget(state, revision, releases)`,
`planPrune(state, releases, backupDirs, keep=3)`,
`recoveryPlan(state)`, `isLockStale(lock, isAlive)`,
`evaluatePreflight(facts)`, `checkSkipInstall(state, lockHash)`,
`beginSwitch(state, {op, from, to})`, `recordBackup(state, dir)`,
`completeSwitch(state, {verified, lockHash, now})`,
`failSwitch(state, {outcome, step, message, now})`.
- [ ] Write `tests/deploy/state.test.mjs` cases:
  restore default = previous[0]; named revision must be in releases and have a backup; error when no previous;
  prune keeps current + previous[0] + newest up to 3, deletes older, never deletes pending targets; backups pruned to those referenced or newest 3;
  recovery: none when pending null; switch before backup → relink only; after backup → relink + restore data; install (from null) → remove service;
  stale lock when pid dead, live otherwise;
  preflight collects failing checks;
  skip-install refused when hash differs or missing;
  completeSwitch moves from→previous (dedup, max 5), sets backups[from], clears pending; failSwitch keeps current=from and records outcome.
- [ ] Run in Actions (`node --test tests/deploy/`) → fail; implement; pass.
- [ ] Commit `feat(deploy): add pure deployment state helpers`.

### Task 3: fsops helpers
`replaceLink(linkPath, target)` (Linux: temp symlink + rename; Windows: remove junction then create), `removeLink(p)` (unlink, fallback rmdir; never recursive),
`linkShared(releaseDir, sharedDir)` for `.data`, `logs` (dir links) and `.env.local`, `agents.json`, `nodes.json` (file links; created empty in shared if missing),
`copyDir(src, dst)` (fresh copy), `replaceDataFrom(backupDir, dataDir)` (empty dataDir contents then copy),
`freeBytes(dir)` (`fs.statfsSync`), `dirBytes(dir)`, `acquireLock(root)` / `releaseLock`, `run(cmd, args, {cwd, user})` (inherits stdio to stderr; Linux non-root user via `runuser -u`),
`waitHttp(url, seconds)`, `waitPortFree(port, seconds)`, `sha256File(p)`.
- [ ] Write, commit `feat(deploy): add filesystem and process helpers`.

### Task 4: Service adapters
Common interface: `exists()`, `read()` → settings, `install(settings)`, `backup(dir)`, `restoreBackup(dir)`, `remove()`, `stop()`, `start()`, `pointsInto(dir)`.
- Linux: unit at `/etc/systemd/system/agents-chat.service`; `install` renders template (`__USER__`, `__GROUP__`, `__ROOT__`, `__NODE__`, `__PORT__`); `rewriteForImport(oldDir, root, node, port)` replaces `WorkingDirectory=`, `ExecStart=`, and old `.env.local` path in `EnvironmentFile=`.
- Windows: settings from `Get-ScheduledTask` (UserId, LogonType, trigger kind, `-StartArguments` parsed from action arguments; legacy action → `""` meaning dev tunnel); `install` calls `install-scheduled-task.ps1` from `<root>\current\scripts`; `stop` = `Disable-ScheduledTask`, write `.service-stop`, `Stop-ScheduledTask`, kill watchdog process tree (command line contains watchdog path) and port owners; `start` = remove `.service-stop`, `Enable-ScheduledTask`, `Start-ScheduledTask`; backup = `Export-ScheduledTask` XML.
- [ ] Write both, commit `feat(deploy): add systemd and scheduled task adapters`.

### Task 5: Core operations
CLI: `node core.mjs <install|update|rebuild|restore|status|remove-task> [--project-dir D] [--import-from D] [--repo URL] [--revision SHA] [--no-pull] [--no-install] [--wait N] [--port N] [--dry-run] [--json] [--accept-data-loss] [--task-name N] [--logon-type T] [--trigger-type T] [--start-args S]`.
Sequence per spec "Flows". Build: link `shared/.env.local` into `repo/`, `git fetch origin`, `git checkout --detach --force <sha>`, `npm ci`, `npm run build`; stage `.next/standalone` → `releases/<sha>.tmp`, add `.next/static`, `public`, `scripts`, `REVISION`, `node-path.txt`, remove copied `.env*`, link shared, rename to `releases/<sha>`.
Output: one JSON result on stdout with `--json`; human lines to stderr. Exit 0/1/2.
- [ ] Write, commit `feat(deploy): add release-based deployment core`.

### Task 6: Wrappers and Windows scripts
- [ ] `deploy.sh`/`update.sh`/`restore.sh`: require root + Node 24, `exec node scripts/deploy/core.mjs <op> "$@"` (`deploy` → `install` when state absent, else `rebuild`/`update`).
- [ ] `deploy.ps1`/`update.ps1`/`restore.ps1`: PowerShell param blocks with the documented names, elevation + Node 24 checks, map to core flags.
- [ ] Update `install-scheduled-task.ps1`, `service-watchdog.ps1`, `start.ps1`, `agents-chat.service`.
- [ ] Commit `feat(deploy): add deploy/update/restore entry scripts`.

### Task 7: CI
- [ ] `tests/deploy/marker.mjs` (`node:sqlite`): `write <db> <value>`, `has <db> <value>` (exit 0/1).
- [ ] `tests/deploy/e2e-linux.sh` and `e2e-windows.ps1`: bare origin, scenarios 1–8 from the spec, `fail()` dumps state/logs.
- [ ] `.github/workflows/deploy.yml`: triggers on push to `feat/simple-deploy` and PRs touching deploy files; jobs `unit`, `linux-e2e`, `windows-e2e` (Node 24).
- [ ] Commit `test(deploy): add unit and end-to-end deployment workflow`.

### Task 8: Validate in Actions, fix until green.

### Task 9: README deployment sections rewrite.

### Task 10: PR + review.
