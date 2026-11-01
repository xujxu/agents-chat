# Updating on Windows

How to update an Agents-Chat install created with `scripts\deploy.ps1`, roll it
back, and move an older checkout-based install to the new layout. For a first
install, see [First-time deployment on Windows 11](deploy-windows.md).

All commands run in an **elevated PowerShell** (*Run as administrator*) from your
checkout, after allowing the repo scripts for that window:

```powershell
cd C:\src\agents-chat
Set-ExecutionPolicy -Scope Process Bypass -Force
$env:AGENTS_CHAT_PROJECT_DIR = 'C:\agents-chat'   # so -ProjectDir can be omitted
```

## How an update works

1. **Build**: fetches the new commit into `C:\agents-chat\repo` and builds it while
   the current version keeps running. If the build fails, nothing changes.
2. **Switch**: stops the task, copies `shared\.data` (chat history) to
   `backups\`, points `current` at the new release and starts the task.
3. **Check**: waits up to 2 minutes for `http://localhost:3000/api/health` to
   report the new commit.
4. **Roll back if needed**: if the check fails, the previous release **and** the
   data copied in step 2 are put back automatically.

The app is down only during steps 2–3 (usually under a minute). The last 3
releases and data backups are kept.

## Update to the latest version

```powershell
git pull                      # get the latest deploy scripts first
.\scripts\update.ps1 -DryRun  # optional: shows the current and target commit and checks prerequisites
.\scripts\update.ps1
```

Updates follow the default branch (`main`) of the repository. Exit codes:

| Code | Meaning |
|---|---|
| `0` | Updated and healthy. |
| `1` | Build failed (old version still running, nothing changed), or the health check failed and the previous version was restored. The message says which. |
| `2` | Not started: invalid option or a failed pre-check (`Preflight failed: ...`). Nothing changed. |

## Other update options

```powershell
.\scripts\update.ps1 -Revision 1a2b3c4d          # a specific commit (or a branch/tag name)
.\scripts\update.ps1 -NoInstall                   # skip npm ci (faster); refused if package-lock.json changed
.\scripts\update.ps1 -WaitSeconds 300             # allow a slower start before rolling back
.\scripts\update.ps1 -NoWait                      # do not wait; the release is marked unverified and never auto-rolled back
.\scripts\deploy.ps1 -SkipGitPull -NoInstall      # rebuild and restart the commit that is already installed
```

## See what is installed

```powershell
.\scripts\update.ps1 -Status
```

The fields that matter most:

| Field | Meaning |
|---|---|
| `current` | Release that is running (`<commit>-<build time>`). |
| `previous` | Older releases you can restore, newest first. |
| `verified` | `false` if the last switch skipped the health check (`-NoWait`). |
| `lastResult` | Outcome of the last operation, the step that failed and the error message. |
| `pending` | Normally `null`. Set only while an operation runs or if one was interrupted. |

## Roll back to a previous version

```powershell
.\scripts\restore.ps1 -DryRun -AcceptDataLoss     # shows which release would be restored
.\scripts\restore.ps1 -AcceptDataLoss             # the most recent previous release
.\scripts\restore.ps1 -Revision 1a2b3c4d -AcceptDataLoss   # a specific one from "previous"
```

Restore puts back the release **and the chat data saved when you moved away from
it**, so chats and messages created since then are lost; that is why
`-AcceptDataLoss` is required. To keep them, export or copy what you need first,
or update forward to a fixed commit instead.

## Change settings without updating

After editing `C:\agents-chat\shared\.env.local`, restart the app with a health
check:

```powershell
.\scripts\deploy.ps1 -SkipGitPull -NoInstall
```

## Move an older install to the new layout

If Agents-Chat was set up with the earlier scripts, the Scheduled Task runs
directly from your git checkout (for example `C:\src\agents-chat`). Migrate it
once:

```powershell
git pull                                                       # in the old checkout: get the new scripts
.\scripts\deploy.ps1 -ProjectDir C:\agents-chat -ImportFrom C:\src\agents-chat
```

This builds the checkout's commit into `C:\agents-chat`, copies `.env.local`,
`agents.json`, `nodes.json`, `.data` and `logs` into `C:\agents-chat\shared`,
saves the old task definition to `C:\agents-chat\backups\migration-<time>\`, and
re-points the existing task. The task keeps its account, logon type, trigger,
tunnel mode and port. If the new version fails its health check, the old task
definition is restored and the old app is started again.

The old checkout itself is not changed. After the new install has run well for a
while, it is only needed as the place you run the scripts from.

## If something goes wrong

| Symptom | What to do |
|---|---|
| Exit code 1 with `... Restored <release>.` (rolled back) or a build error | Run `.\scripts\update.ps1 -Status` and read `lastResult`, then `C:\agents-chat\shared\logs\service-watchdog.log`, `start-service-child*.log` and `server*.log`. |
| `-NoInstall refused: package-lock.json differs ...` | Dependencies changed; run without `-NoInstall`. |
| `Another deployment is running (deploy.lock is held)` | Wait for the other run to finish. A lock left by a process that no longer exists is taken over automatically. |
| The update was interrupted (window closed, reboot) | Run the same command again. It first undoes the interrupted switch, then continues. |
| `Not enough free disk space` | Free space on the drive with `C:\agents-chat`; each release is a few hundred MB and backups are the size of `shared\.data`. |
| `Restore ... Re-run with -AcceptDataLoss` | Add `-AcceptDataLoss` after reading *Roll back to a previous version*. |
