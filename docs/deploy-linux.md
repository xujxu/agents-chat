# First-time deployment on Linux

This guide installs Agents-Chat as a systemd service on a Linux server that has
never run it before. The commands are for Ubuntu/Debian; other systemd
distributions work the same way with their own package manager. It takes about
15 minutes, most of it waiting for the first build.

When you are done:

- the app runs at `http://localhost:3010` as the `agents-chat` service,
- it starts at boot and restarts automatically if it crashes,
- later updates are one command and roll back automatically if they fail.

The examples use these folders; you can choose others:

| Folder | Purpose |
|---|---|
| `~/agents-chat` | Your git checkout. You only run the scripts from here. |
| `/opt/agents-chat` | The deployment folder created by the scripts. The app runs from here. |

## 1. Install the prerequisites

Install Git and Node.js 24 system-wide (from NodeSource, so the binary is in
`/usr/bin` and readable by the service user):

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v        # must be v24.x or newer
```

A Node.js installed with nvm, fnm or volta also works if the service runs as
root, but a system-wide install avoids permission problems when the service runs
as your user (step 4).

You also need `sudo`, systemd, and about 2 GB of free disk space under `/opt`.

## 2. Get the code

```bash
git clone https://github.com/huanyingtianhe/agents-chat.git ~/agents-chat
```

The deploy script builds whatever is on the default branch (`main`) of this
clone's `origin`.

## 3. Create the configuration file

The app reads its settings from `/opt/agents-chat/shared/.env.local`. Create it
with a random secret and a local admin account:

```bash
sudo mkdir -p /opt/agents-chat/shared
sudo tee /opt/agents-chat/shared/.env.local > /dev/null <<EOF
NEXTAUTH_SECRET=$(openssl rand -base64 32)
NEXTAUTH_URL=http://localhost:3010
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-strong-password
EOF
sudo chmod 600 /opt/agents-chat/shared/.env.local
sudo nano /opt/agents-chat/shared/.env.local   # change ADMIN_PASSWORD, then save
```

Rules for this file (systemd reads it):

- one `KEY=value` per line; no `export`, no single quotes, no `${VAR}`;
- do not set `PORT` or `HOSTNAME` here; use `--port` when deploying instead.

All other settings (Microsoft Entra ID or GitHub sign-in, Azure Relay, logging)
are optional. `~/agents-chat/.env.example` lists them; see
[Environment variables](../README.md#environment-variables).

## 4. Deploy

```bash
cd ~/agents-chat
sudo ./scripts/deploy.sh --project-dir /opt/agents-chat --user "$USER"
```

`--user "$USER"` runs the service as your account, so agents you sign in to
(step 6) can use your credentials. Without `--user` the service runs as root.

What happens:

1. The script checks the prerequisites. If something is missing it prints
   `Preflight failed:` with the reason and changes nothing (exit code 2).
2. It clones the repository into `/opt/agents-chat/repo`, runs `npm ci` and
   `npm run build`. This is the slow part (3–10 minutes the first time).
3. It copies the build into `/opt/agents-chat/releases/<commit>-<time>/`, points
   `/opt/agents-chat/current` at it and creates
   `/etc/systemd/system/agents-chat.service`.
4. It starts the service and waits up to 2 minutes for
   `http://127.0.0.1:3010/api/health`.

On success it prints the installed release and exits with code 0.

## 5. Check that it works

```bash
curl -s http://localhost:3010/api/health      # {"ok":true,"version":"<commit>"}
sudo ./scripts/update.sh --project-dir /opt/agents-chat --status
systemctl status agents-chat
```

Open <http://localhost:3010> (or an SSH tunnel: `ssh -L 3010:localhost:3010 <server>`)
and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from step 3.

Tip: `export AGENTS_CHAT_PROJECT_DIR=/opt/agents-chat` and `sudo -E ...` let you
omit `--project-dir`.

## 6. Add an agent

The chat needs at least one ACP agent, for example the GitHub Copilot CLI.
Install it and sign in **as the service user** (your account if you used
`--user "$USER"`):

```bash
sudo npm install -g @github/copilot
copilot          # complete the sign-in, then exit
command -v copilot
```

In the app, open the **Agents** panel → **+** → **Add Agent in Server** and enter:

- **Agent ID**: `copilot`, **Display Name**: `GitHub Copilot`
- **Command**: the path printed above (for example `/usr/bin/copilot`)
- **Arguments**: `--acp`
- **Working Directory**: the project folder the agent should work in

See [Agents](../README.md#agents) for other agents.

## 7. Optional: serve it over HTTPS

Browsers only allow some features (for example the upload checksums used when
saving chats) on HTTPS or `localhost`. To use the app from other machines, put a
reverse proxy with TLS in front of it. Example with nginx and Let's Encrypt for
`chat.example.com`:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/agents-chat > /dev/null <<'EOF'
server {
    server_name chat.example.com;
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;          # agent replies are streamed
        proxy_read_timeout 1h;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/agents-chat /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chat.example.com
```

Then set `NEXTAUTH_URL=https://chat.example.com` in
`/opt/agents-chat/shared/.env.local` and run `sudo systemctl restart agents-chat`.
The default nginx request size limit (1 MiB) is enough.

## 8. Day-to-day commands

Run from `~/agents-chat`:

```bash
git pull                                                           # get the latest deploy scripts
sudo ./scripts/update.sh  --project-dir /opt/agents-chat           # build and switch to the latest main
sudo ./scripts/update.sh  --project-dir /opt/agents-chat --dry-run # show what an update would do
sudo ./scripts/restore.sh --project-dir /opt/agents-chat --accept-data-loss   # previous version and its data
sudo journalctl -u agents-chat -f                                  # follow the logs
```

See [Updating on Linux](update-linux.md) for all update and rollback options.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `Run with sudo` | Prefix the command with `sudo`. |
| `Node.js 24 not found on PATH` | Install Node.js system-wide (step 1), or check `sudo node -v`. |
| `Preflight failed: .env.local not found` | Create `/opt/agents-chat/shared/.env.local` (step 3). |
| `Preflight failed: A service/task with this name already exists` | An older `agents-chat` unit exists. Migrate it with `--import-from <old checkout>` (see [Updating on Linux](update-linux.md)), or remove it: `sudo systemctl disable --now agents-chat && sudo rm /etc/systemd/system/agents-chat.service`. |
| `Health check ... did not pass` | Run `sudo journalctl -u agents-chat -n 100`. A missing `NEXTAUTH_SECRET`, a bad line in `.env.local`, or port 3010 already in use (`sudo ss -ltnp 'sport = :3010'`) are common causes. |
| `npm ci` fails compiling `better-sqlite3` | Install build tools: `sudo apt-get install -y build-essential python3`, then deploy again. |
| Agent fails to start | Use the full path to the agent executable and sign in to it as the service user. |

To uninstall:

```bash
sudo systemctl disable --now agents-chat
sudo rm /etc/systemd/system/agents-chat.service && sudo systemctl daemon-reload
sudo rm -rf /opt/agents-chat     # deletes the chat history in shared/.data
```
