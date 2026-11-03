# Restart command design

## Goal

Provide one simple command to restart a deployed agents-chat service after
changing configuration (for example `shared\.env.local`), similar to
`systemctl restart` on Linux.

## Scope

- **Windows:** add `scripts\restart.ps1`.
- **Linux:** no new script. `sudo systemctl restart agents-chat` already
  restarts the service and reloads `shared/.env.local`, because the systemd
  unit lists that file as an `EnvironmentFile`. The docs already describe this
  command.
- No changes to `core.mjs`, the deploy, update, or restore flows, or
  `state.json`.

## Why Windows needs a script

The Windows service is a Scheduled Task (`Agents-Chat-Startup`) that runs
`scripts\service-watchdog.ps1`. The watchdog loops on `start.ps1`, which starts
`node server.js` and, in Dev Tunnel mode, also starts `devtunnel host`.

`Stop-ScheduledTask` does not reliably kill this hidden process tree. The
documented manual procedure (`Stop-ScheduledTask`, kill the port listener,
`Start-ScheduledTask`) can leave an old watchdog or tunnel running.
`service-windows.mjs` `stop()` already does this correctly, and `restart.ps1`
mirrors its steps.

## Usage

```powershell
# elevated PowerShell
& C:\path\to\agents-chat\current\scripts\restart.ps1
```

| Parameter | Default | Purpose |
|---|---|---|
| `-TaskName` | `Agents-Chat-Startup` | The Scheduled Task to restart. |
| `-WaitSeconds` | `60` | How long to wait for `/api/health`. `0` skips the wait. |

The port and watchdog path come from the task's own action arguments
(`-Port N`, `-File "<watchdog>"`), so the script has no `-Port` or
`-ProjectDir` parameters and cannot drift from the installed task.

## Behavior

1. Fail with exit code 2 if the shell is not elevated or the task does not
   exist.
2. Read the task action arguments and parse the port (default `3000`) and the
   watchdog path.
3. Stop:
   1. `Disable-ScheduledTask`, so no trigger fires mid-restart.
   2. `taskkill /T /F` every `powershell.exe` or `pwsh.exe` process (other
      than the current one) whose command line contains the watchdog path.
      This also kills `node` and `devtunnel`.
   3. `Stop-ScheduledTask`.
   4. Stop any process still listening on the port.
4. Start: `Enable-ScheduledTask`, then `Start-ScheduledTask`.
5. Unless `-WaitSeconds 0` is given, poll `http://localhost:<port>/api/health`
   every 2 seconds until it returns HTTP 200 or the timeout passes.
   - Healthy: print `Agents-Chat restarted (port N, healthy).` and exit 0.
   - Timeout: print a failure that points to
     `logs\service-watchdog.log` and exit 1. The task stays enabled and
     running, so the watchdog keeps retrying.

Configuration is reloaded because `start.ps1` reads `.env.local` on every
start.

## Error handling

- Not elevated, or task missing: exit 2 with a clear message.
- Health timeout: exit 1. Do not roll back, because a restart has nothing to
  roll back to.
- All other failures throw (`$ErrorActionPreference = 'Stop'`).

## Documentation

- `docs/update-windows.md`, "Change settings without updating": replace the
  manual stop and start block with `restart.ps1`.
- `docs/deploy-windows.md`: point the restart and troubleshooting references
  at `restart.ps1`.
- `README.md`: if it lists operational commands, add one line per platform:
  `restart.ps1` (Windows) and `sudo systemctl restart agents-chat` (Linux).

## Testing

Extend `tests/deploy/e2e-windows.ps1` with a step that runs after a successful
deploy:

1. Record the watchdog process ID.
2. Run `restart.ps1` and expect exit code 0.
3. Expect `/api/health` to respond, and expect the old watchdog process to be
   gone and a new one to be running.

No unit tests: the script is a thin PowerShell wrapper over Windows APIs.
