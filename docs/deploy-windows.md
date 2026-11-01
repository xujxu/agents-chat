# First-time deployment on Windows 11

This guide installs Agents-Chat as a background service (a Scheduled Task) on a
Windows 11 machine that has never run it before. It takes about 15 minutes, most
of it waiting for the first build.

When you are done:

- the app runs at `http://localhost:3000` and restarts automatically if it exits,
- it starts again when you sign in to Windows,
- later updates are one command and roll back automatically if they fail.

The examples use these folders; you can choose others:

| Folder | Purpose |
|---|---|
| `C:\src\agents-chat` | Your git checkout. You only run the scripts from here. |
| `C:\agents-chat` | The deployment folder created by the scripts. The app runs from here. |

## 1. Install the prerequisites

Open **PowerShell** (normal, not elevated) and install Git:

```powershell
winget install --id Git.Git -e
```

Install **Node.js 24** (the version the project is tested with): open
<https://nodejs.org/dist/latest-v24.x/>, download `node-v24.*-x64.msi` and run it
with the default options. It installs for all users in `C:\Program Files\nodejs`,
which the background task uses. Do not use `winget install OpenJS.NodeJS.LTS`:
that now installs Node.js 26, which the project does not support yet. If you
already have another version, uninstall it first (`winget uninstall OpenJS.NodeJS.LTS`
or **Settings → Apps**).

Close and reopen PowerShell so the new `PATH` is picked up, then check the versions:

```powershell
git --version
node -v        # must be v24.x
```

You also need about 2 GB of free disk space on the drive that holds `C:\agents-chat`.

## 2. Get the code

```powershell
git clone https://github.com/huanyingtianhe/agents-chat.git C:\src\agents-chat
```

The deploy script builds whatever is on the default branch (`main`) of this
clone's `origin`.

## 3. Create the configuration file

The app reads its settings from `C:\agents-chat\shared\.env.local`. Create the
folder and the file with a random secret and a local admin account:

```powershell
New-Item -ItemType Directory -Force C:\agents-chat\shared | Out-Null

$secret = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
@"
NEXTAUTH_SECRET=$secret
NEXTAUTH_URL=http://localhost:3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-strong-password
"@ | Set-Content -Encoding ascii C:\agents-chat\shared\.env.local

notepad C:\agents-chat\shared\.env.local   # change ADMIN_PASSWORD, then save
```

All other settings (Microsoft Entra ID or GitHub sign-in, Dev Tunnel, Azure Relay,
logging) are optional. `C:\src\agents-chat\.env.example` lists them; see
[Environment variables](../README.md#environment-variables).

## 4. Deploy

Open **PowerShell as Administrator** (Start → type *PowerShell* → *Run as
administrator*) and run:

```powershell
cd C:\src\agents-chat
Set-ExecutionPolicy -Scope Process Bypass -Force   # allow the repo scripts in this window only
.\scripts\deploy.ps1 -ProjectDir C:\agents-chat -NoTunnel
```

`-NoTunnel` serves the app on this machine only. To reach it from other devices
over HTTPS, set up a Dev Tunnel afterwards (step 7).

What happens:

1. The script checks the prerequisites. If something is missing it prints
   `Preflight failed:` with the reason and changes nothing (exit code 2).
2. It clones the repository into `C:\agents-chat\repo`, runs `npm ci` and
   `npm run build`. This is the slow part (5–10 minutes the first time).
3. It copies the build into `C:\agents-chat\releases\<commit>-<time>\`, points
   `C:\agents-chat\current` at it and registers the Scheduled Task
   **Agents-Chat-Startup**, which runs as your account when you sign in.
4. It starts the task and waits up to 2 minutes for `http://localhost:3000/api/health`.

On success it prints the installed release and exits with code 0.

## 5. Check that it works

```powershell
Invoke-RestMethod http://localhost:3000/api/health          # ok: True and the deployed commit
.\scripts\update.ps1 -ProjectDir C:\agents-chat -Status     # installed release, previous ones, last result
Get-ScheduledTask -TaskName Agents-Chat-Startup | Select-Object TaskName, State
```

Open <http://localhost:3000> in a browser and sign in with `ADMIN_USERNAME` /
`ADMIN_PASSWORD` from step 3.

Tip: `$env:AGENTS_CHAT_PROJECT_DIR = 'C:\agents-chat'` lets you omit `-ProjectDir`
in the current window.

## 6. Add an agent

The chat needs at least one ACP agent, for example the GitHub Copilot CLI.
Install it and sign in **as the same Windows user** that runs the task:

```powershell
npm install -g @github/copilot
copilot          # complete the sign-in, then exit
(Get-Command copilot).Source   # note the full path
```

In the app, open the **Agents** panel → **+** → **Add Agent in Server** and enter:

- **Agent ID**: `copilot`, **Display Name**: `GitHub Copilot`
- **Command**: the full path printed above (for example `C:\Users\<you>\AppData\Roaming\npm\copilot.cmd`)
- **Arguments**: `--acp`
- **Working Directory**: the project folder the agent should work in

Using the full path avoids "command not found" errors in the background task.
See [Agents](../README.md#agents) for other agents.

## 7. Optional: reach the app from other devices (Dev Tunnel)

```powershell
winget install --id Microsoft.devtunnel -e
devtunnel user login
devtunnel create agents-chat --allow-anonymous
devtunnel port create agents-chat -p 3000
devtunnel show agents-chat          # note the URL ending in -3000.<region>.devtunnels.ms
```

Add both values to `C:\agents-chat\shared\.env.local`:

```
DEV_TUNNEL_NAME=agents-chat
DEV_TUNNEL_URL=https://<id>-3000.<region>.devtunnels.ms
```

Then switch the task to Dev Tunnel mode (elevated PowerShell):

```powershell
C:\agents-chat\current\scripts\install-scheduled-task.ps1 -Tunnel DevTunnel -Port 3000
Start-ScheduledTask -TaskName Agents-Chat-Startup
```

In tunnel mode `start.ps1` sets `NEXTAUTH_URL` to the tunnel URL, so sign in
through that URL.

## 8. Day-to-day commands

Run from `C:\src\agents-chat` in an elevated PowerShell (after
`Set-ExecutionPolicy -Scope Process Bypass -Force`):

```powershell
git pull                                                         # get the latest deploy scripts
.\scripts\update.ps1  -ProjectDir C:\agents-chat               # build and switch to the latest main
.\scripts\update.ps1  -ProjectDir C:\agents-chat -DryRun       # show what an update would do
.\scripts\restore.ps1 -ProjectDir C:\agents-chat -AcceptDataLoss   # go back to the previous version and its data
```

The app code is fetched into `C:\agents-chat\repo` by the scripts; `git pull`
only keeps the deploy scripts themselves current. If an update fails its health
check, the previous version and its chat data are put back automatically. See
[Updating on Windows](update-windows.md) for all update and rollback options.

## Run without signing in (optional)

By default the app runs only while you are signed in to Windows. To run it from
boot without a signed-in user, choose this at the first deploy:

```powershell
.\scripts\deploy.ps1 -ProjectDir C:\agents-chat -NoTunnel -TaskLogonType S4U -TaskTriggerType AtStartup
```

To change it on an existing install (elevated PowerShell; use `-Tunnel DevTunnel`
if you set up step 7):

```powershell
C:\agents-chat\current\scripts\install-scheduled-task.ps1 -Tunnel None -Port 3000 -LogonType S4U -TriggerType AtStartup
Start-ScheduledTask -TaskName Agents-Chat-Startup
```

## Troubleshooting

| Symptom | What to do |
|---|---|
| `...deploy.ps1 cannot be loaded because running scripts is disabled` | Run `Set-ExecutionPolicy -Scope Process Bypass -Force` in that window first. |
| `Preflight failed: Run elevated` | Open PowerShell with *Run as administrator*. |
| `Preflight failed: .env.local not found` | Create `C:\agents-chat\shared\.env.local` (step 3). |
| `Preflight failed: A service/task with this name already exists` | An older Agents-Chat task exists. Migrate it with `-ImportFrom <old checkout>` instead, or remove it with `Unregister-ScheduledTask Agents-Chat-Startup`. |
| `Health check ... did not pass` | Read `C:\agents-chat\shared\logs\service-watchdog.log` and `start-service-child*.log`. A missing `NEXTAUTH_SECRET` or a port already in use (`Get-NetTCPConnection -LocalPort 3000`) are common causes. |
| The app stops when you sign out | Expected with the default task; see *Run without signing in*. |
| Agent fails to start | Use the full path to the agent executable and make sure it is signed in as the task's user. |

To uninstall: `.\scripts\deploy.ps1 -ProjectDir C:\agents-chat -RemoveTask`, then
delete `C:\agents-chat` (this deletes the chat history in `shared\.data`).
