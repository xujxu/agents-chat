# Updating on Linux

How to update an Agents-Chat install created with `scripts/deploy.sh`, roll it
back, and move an older checkout-based install to the new layout. For a first
install, see [First-time deployment on Linux](deploy-linux.md).

All commands run from your checkout with `sudo`:

```bash
cd ~/agents-chat
```

The examples pass `--project-dir /opt/agents-chat`. To omit it, run
`export AGENTS_CHAT_PROJECT_DIR=/opt/agents-chat` and use `sudo -E`.

## How an update works

1. **Build**: fetches the new commit into `/opt/agents-chat/repo` and builds it
   while the current version keeps running. If the build fails, nothing changes.
2. **Switch**: stops the `agents-chat` service, copies `shared/.data` (chat
   history) to `backups/`, points `current` at the new release and starts it.
3. **Check**: waits up to 2 minutes for `http://127.0.0.1:3010/api/health` to
   report the new commit.
4. **Roll back if needed**: if the check fails, the previous release **and** the
   data copied in step 2 are put back automatically.

The app is down only during steps 2–3 (usually a few seconds). The last 3
releases and data backups are kept.

## Update to the latest version

```bash
git pull                                                     # get the latest deploy scripts first
sudo ./scripts/update.sh --project-dir /opt/agents-chat --dry-run   # optional: target commit and pre-checks
sudo ./scripts/update.sh --project-dir /opt/agents-chat
```

Updates follow the default branch (`main`) of the repository. Exit codes:

| Code | Meaning |
|---|---|
| `0` | Updated and healthy. |
| `1` | Build failed (old version still running, nothing changed), or the health check failed and the previous version was restored. The message says which. |
| `2` | Not started: invalid option or a failed pre-check (`Preflight failed: ...`). Nothing changed. |

Add `--json` for a single JSON result on stdout, for example in a cron job or CI.

## Other update options

```bash
sudo ./scripts/update.sh --project-dir /opt/agents-chat --revision 1a2b3c4d   # a specific commit (or branch/tag)
sudo ./scripts/update.sh --project-dir /opt/agents-chat --no-install         # skip npm ci; refused if package-lock.json changed
sudo ./scripts/update.sh --project-dir /opt/agents-chat --wait 300           # allow a slower start before rolling back
sudo ./scripts/update.sh --project-dir /opt/agents-chat --wait 0             # do not wait; marked unverified, never auto-rolled back
sudo ./scripts/deploy.sh --project-dir /opt/agents-chat --skip-git-pull --no-install   # rebuild the installed commit
```

## See what is installed

```bash
sudo ./scripts/update.sh --project-dir /opt/agents-chat --status
```

The fields that matter most:

| Field | Meaning |
|---|---|
| `current` | Release that is running (`<commit>-<build time>`). |
| `previous` | Older releases you can restore, newest first. |
| `verified` | `false` if the last switch skipped the health check (`--wait 0`). |
| `lastResult` | Outcome of the last operation, the step that failed and the error message. |
| `pending` | Normally `null`. Set only while an operation runs or if one was interrupted. |

## Roll back to a previous version

```bash
sudo ./scripts/restore.sh --project-dir /opt/agents-chat --dry-run --accept-data-loss   # which release would be restored
sudo ./scripts/restore.sh --project-dir /opt/agents-chat --accept-data-loss             # the most recent previous release
sudo ./scripts/restore.sh --project-dir /opt/agents-chat --revision 1a2b3c4d --accept-data-loss
```

Restore puts back the release **and the chat data saved when you moved away from
it**, so chats and messages created since then are lost; that is why
`--accept-data-loss` is required. To keep them, copy what you need first, or
update forward to a fixed commit instead.

## Change settings without updating

After editing `/opt/agents-chat/shared/.env.local` or `/etc/agents-chat.env`:

```bash
sudo systemctl restart agents-chat
curl -s http://localhost:3010/api/health
```

## Move an older install to the new layout

If Agents-Chat was set up with the earlier scripts, the `agents-chat` unit runs
directly from your git checkout (for example `/home/me/agents-chat`). Migrate it
once:

```bash
cd /home/me/agents-chat && git pull          # get the new scripts
sudo ./scripts/deploy.sh --project-dir /opt/agents-chat --import-from /home/me/agents-chat
```

This builds the checkout's commit into `/opt/agents-chat`, copies `.env.local`,
`agents.json`, `nodes.json`, `.data` and `logs` into `/opt/agents-chat/shared`,
saves the old unit file to `/opt/agents-chat/backups/migration-<time>/`, and
changes only `WorkingDirectory` and `ExecStart` in the unit. `User`,
`Environment`, `EnvironmentFile` lines and drop-ins are kept. If the new version
fails its health check, the old unit is restored and the old app started again.

The old checkout itself is not changed. After the new install has run well for a
while, it is only needed as the place you run the scripts from.

## If something goes wrong

| Symptom | What to do |
|---|---|
| Exit code 1 with `... Restored <release>.` (rolled back) or a build error | Run `update.sh --status` and read `lastResult`, then `sudo journalctl -u agents-chat -n 200`. |
| `-NoInstall refused: package-lock.json differs ...` | Dependencies changed; run without `--no-install`. |
| `Another deployment is running (deploy.lock is held)` | Wait for the other run to finish. A lock left by a process that no longer exists is taken over automatically. |
| The update was interrupted (SSH dropped, Ctrl+C, reboot) | Run the same command again. It first undoes the interrupted switch, then continues. Use `tmux` or `screen` for long updates over SSH. |
| `Not enough free disk space` | Free space under `/opt/agents-chat`; each release is a few hundred MB and backups are the size of `shared/.data`. |
| `Restore ... Re-run with --accept-data-loss` | Add `--accept-data-loss` after reading *Roll back to a previous version*. |
