# Microsoft Teams bot

agents-chat can expose one agent as a Microsoft Teams bot. Users message the bot in a 1:1 Teams chat,
or @mention it in a group chat, and the configured agent replies there. Replies stream into Teams as
the agent writes them. The same conversations also appear in the agents-chat web UI.

- [Architecture](#architecture)
- [Commands](#commands)
- [Group chats](#group-chats)
- [Setup](#setup)
- [Option B: Key Vault token (no client secret)](#option-b-key-vault-token-no-client-secret)
- [Security](#security)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## Architecture

```mermaid
flowchart LR
  user([Teams user]) -->|"1:1 chat or<br/>@mention in group chat"| teams[Microsoft Teams]
  teams --> bfs[Bot Connector service]
  bfs -->|"POST /api/teams/messages<br/>signed JWT"| route
  subgraph host[agents-chat server]
    route[Teams endpoint] -->|"verify JWT, ack 200,<br/>process in background"| bridge[Teams bridge]
    bridge -->|"loopback /api/acp<br/>as the mapped user"| acp[ACP routes]
    acp --> agent[[Agent process]]
    acp --> db[(chats.db)]
  end
  bridge -->|"replies, streaming updates,<br/>roster lookup (bot token)"| bfs
  subgraph azure["Azure (option B only)"]
    job[Container Apps job<br/>managed identity] -->|"federated credential"| entra[Entra ID]
    job -->|"Bot Framework token<br/>every 30 min"| kv[(Key Vault secret)]
  end
  bridge -.->|"read token<br/>(az login)"| kv
```

1. The Bot Connector service calls `https://<public-host>/api/teams/messages` with a signed JWT.
   The endpoint verifies it, returns `200` right away, and handles the message in the background.
2. The bridge looks up the sender in the Teams roster and maps them to an agents-chat account by
   **email/UPN**. It then calls the existing `/api/acp` route over loopback as that user. Chat
   ownership, agent access, and the admin role work exactly as in the web UI.
3. Each Teams 1:1 conversation maps to one agents-chat chat named `Teams: …`. In a group chat, each
   person gets their own agents-chat chat. `/new` starts a new one. If you switch agents with
   `/agent`, each agent gets its own chat in that conversation, filed under that agent in the web UI.
4. The bridge polls the turn and streams the growing answer to Teams. Each reply, and each question the agent asks you, starts with the
   answering agent's name (for example an italic `🤖 teams` annotation), and the progress line reads
   `<agent> is thinking…`, so you can always tell which agent you are talking to. Agent questions and
   permission prompts are posted as numbered lists. Reply with the number or label; free-text
   questions take one answer per line.

## Commands

| Command | Effect |
| --- | --- |
| `/new [prompt]` | Start a new chat, optionally with a first prompt |
| `/stop` | Stop the running response |
| `/whoami` | Show the mapped account, agent, model, and chat id |
| `/agent [number or name]` | List the agents you can use, or switch this conversation to one. The choice is per person and per conversation; switching back continues that agent's earlier chat |
| `/session [number or words]` | List your sessions (agents-chat chats) with the current agent, switch this conversation to one by number or chat id, or search them by name and message text like the web UI's chat search |
| `/model [number or name]` | List the agent's models, or switch to one (also changes your model for this agent in the web UI) |
| `/help` | Show help |

Teams turns use the same model as the web UI: the model you last picked for this agent in agents-chat, otherwise the agent's default model.

`/agent` lists the same agents you can talk to in the web UI (public agents, your own, ones shared
with you, and all agents for admins). The bot's default agent comes from `TEAMS_AGENT_ID`; `/model`
and `/new` apply to whichever agent you are currently using.

`/session` shows your 10 most recent sessions with the current agent, including chats started in
the web UI, newest first (✅ marks the one in use). `/session <number>` picks from the last list or
search result, and the choice is per person, per conversation, and per agent. In group chats
`/session` only lists and opens sessions started in that group chat, because everyone there can
see the replies.

## Group chats

When the **Group chat** scope is enabled, anyone in the chat can add the bot (chat header → **+** /
**Apps**). To avoid interrupting the discussion:

- The bot acts **only on messages that @mention it**, for example `@agent-xujx summarize the build
  failure`. Everything else is ignored. Teams only delivers @mentions to the bot by default, and the
  bridge also checks the mention itself.
- Commands work the same way: `@agent-xujx /stop`, `@agent-xujx /new`.
- **Each person runs as themselves.** The asker is mapped to their own agents-chat account and gets
  their own chat for that group. Only the asker can answer the agent's questions or `/stop` their
  turn. Replies @mention the asker. To answer a question from the agent, @mention the bot with
  your answer.
- **Replies are visible to everyone in the group chat.** The agent runs with the asker's access, so
  do not ask it for anything the other members should not see.
- Only people listed in `TEAMS_ALLOWED_USERS` get a response. The bot ignores everyone else without
  replying, including members from other organizations and anonymous users.

## Setup

You need:

- A running agents-chat deployment (see the [Windows](deploy-windows.md) or [Linux](deploy-linux.md) guide).
- A public HTTPS URL that reaches it, such as a reverse proxy or a
  [dev tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/).
- Permission to create apps in the [Teams Developer Portal](https://dev.teams.microsoft.com) and to
  upload custom apps in Teams.

### 1. Create the agent

In the agents-chat **Agents** panel, create a dedicated agent for Teams, for example with id `teams`.
Make it public, or grant access to the users who will use the bot.

### 2. Expose the messaging endpoint

The Bot Connector service must reach `https://<public-host>/api/teams/messages`. With a dev tunnel:

```powershell
devtunnel create agents-chat --allow-anonymous
devtunnel port create agents-chat -p 3000
devtunnel host agents-chat
```

Anonymous tunnel access is required because the Bot Connector service cannot sign in to the
tunnel. The endpoint itself rejects any request without a valid Bot Framework token, and every
other route still requires an agents-chat sign-in. Keep the tunnel host running alongside the service.

### 3. Register the bot

1. In the Developer Portal, open **Tools → Bot management → New bot**. This creates a single-tenant
   Entra app; note its **app (client) id**.
2. Under **Configure**, set the endpoint address to `https://<public-host>/api/teams/messages`.
3. Give the bot a credential:
   - **Option A: client secret.** Under **Client secrets**, add a secret and keep it for
     `TEAMS_BOT_APP_SECRET`.
   - **Option B: Key Vault token.** Use this when your tenant blocks client secrets and
     certificates. Follow [Option B](#option-b-key-vault-token-no-client-secret), then continue here.

### 4. Configure agents-chat

Add these to `.env.local` (`shared/.env.local` for script deployments), then restart the service:

| Variable | Required | Description |
| --- | --- | --- |
| `TEAMS_BOT_APP_ID` | yes | Bot app (client) id |
| `TEAMS_BOT_APP_SECRET` | one of | Option A: bot client secret |
| `TEAMS_BOT_TOKEN_VAULT` | one of | Option B: Key Vault name or URL holding the Bot Framework token |
| `TEAMS_BOT_TOKEN_SECRET` | no | Option B: secret name. Defaults to `teams-bot-token` |
| `TEAMS_TENANT_ID` | yes | Tenant whose users may use the bot |
| `TEAMS_AGENT_ID` | yes | Agent id that answers Teams messages |
| `TEAMS_ALLOWED_USERS` | yes | Comma-separated emails/UPNs allowed to use the bot. Empty means **nobody**: the bot ignores everyone |
| `TEAMS_BOT_AUTH_TENANT` | no | Token tenant for option A. Defaults to `TEAMS_TENANT_ID`; use `botframework.com` for multi-tenant bots |
| `TEAMS_INTERNAL_BASE_URL` | no | Loopback URL of this app. Defaults to `http://127.0.0.1:$PORT` (3000) |

The feature stays off, and the endpoint returns `404`, until the app id, tenant, agent, and one
credential are set. `NEXTAUTH_SECRET` must also be set, as it is for the web UI. Until
`TEAMS_ALLOWED_USERS` lists at least one email, the bot does not reply to anyone.

Check the endpoint: an unsigned request must be rejected with `401`.

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://<public-host>/api/teams/messages -H "Content-Type: application/json" -d "{}"
```

### 5. Create and install the Teams app

1. In the Developer Portal, open **Apps → New app** and fill in the basic information.
2. Under **App features → Bot**, select the bot from step 3 and enable the **Personal** scope.
   Also enable **Group chat** if people should be able to add the bot to group chats
   (see [Group chats](#group-chats)). Do not grant the `ChatMessage.Read.Chat` (RSC) permission;
   the bot does not need it.
3. Use **Preview in Teams**, or **Publish → Download app package** and upload it in Teams through
   **Apps → Manage your apps → Upload an app**. To make it available to chosen colleagues, see
   [Share the bot with colleagues](#share-the-bot-with-colleagues).
4. Open the bot in Teams and send `/whoami`. It should show your agents-chat account.

### Share the bot with colleagues

A custom-uploaded app is visible only to you. To give specific people in your tenant the bot,
without publishing it to the org catalog, upload it with **shared** scope and share it with them
through the [Microsoft 365 Agents Toolkit CLI](https://learn.microsoft.com/microsoftteams/platform/toolkit/microsoft-365-agents-toolkit-cli)
(`atk`). Only the people you add can find it; it does not appear in the store for anyone else.
Your tenant's app-upload policy must allow this.

The repo has a template in `teams-app/`. The filled-in copy holds your app package and the shared
app's ids, so keep it out of git, like `.env.local`. For script deployments, keep it in
`shared/teams-app/`.

The commands below are PowerShell (on Linux, `atk` takes the same arguments). Set `$dir` to your
folder in every new shell:

```powershell
$dir = 'C:\agents-chat\shared\teams-app'   # your deployment's shared\teams-app
```

1. **Set up the folder** (once). Install the CLI and, from the root of an agents-chat checkout,
   copy the template:

   ```powershell
   npm install -g @microsoft/m365agentstoolkit-cli
   New-Item -ItemType Directory -Force "$dir\env", "$dir\appPackage" | Out-Null
   Copy-Item teams-app\m365agents.yml $dir
   Copy-Item teams-app\env\.env.dev.example "$dir\env\.env.dev"
   ```

   The result is:

   ```text
   teams-app\
     m365agents.yml          # from the template; no edits needed
     env\.env.dev            # from .env.dev.example; leave the values empty
     appPackage\teams-app.zip
   ```

2. **Add the app package.** In the [Developer Portal](https://dev.teams.microsoft.com/apps), open
   your app (step 5), select **Publish → Download app package**, and save the zip as
   `$dir\appPackage\teams-app.zip`. Do not unzip it. If you keep another file name, change
   `appPackagePath` in `m365agents.yml` to match. Leave `scope: shared` as it is: the value must be
   lowercase, or `atk provision` fails.

3. **Sign in and upload** (once, and again after each app change). Sign in with an owner of the
   Teams app; a browser window opens:

   ```powershell
   atk auth login m365
   atk provision --env dev -f $dir -i false
   ```

   You do not type any ids. The first upload fills in `M365_TITLE_ID`, `M365_APP_ID`, and
   `SHARE_LINK` in `env\.env.dev` and adds a `projectId` line to `m365agents.yml`. Check them with
   `Get-Content "$dir\env\.env.dev"`. Keep both files: later uploads and shares use them to find the
   same app, and without them `atk provision` creates a second shared copy. To upload a changed
   package, increase `version` in the app's manifest (Developer Portal: **Basic information → Version**), download it again over the old zip, and run `atk provision` again.

4. **Share** with each colleague. The bot then appears in their Teams apps; you can also send them
   `SHARE_LINK` from `env\.env.dev` to open it directly.

   ```powershell
   atk share --env dev -f $dir --scope users --email 'alice@contoso.com,bob@contoso.com' -i false
   atk share remove --env dev -f $dir --users 'bob@contoso.com' -i false   # revoke
   ```

5. **Allow them in agents-chat.** Sharing the Teams app does not grant any access to agents-chat.
   Add each person to `TEAMS_ALLOWED_USERS` in `.env.local` (the bot ignores everyone else),
   restart the service, and make sure they have an agents-chat role and access to the agents they
   should use.

#### `atk` command reference

Run these in a PowerShell window on the machine that has the folder. If `atk` is not recognized
after the install, open a new window, or call it by its full path
(`& "$(npm prefix -g)\atk.cmd" ...`). `-i false` turns off the interactive prompts.

| Task | Command |
| --- | --- |
| Sign in (opens a browser; the sign-in is cached, so this is needed only once or after it expires) | `atk auth login m365` |
| Show the signed-in account | `atk auth list m365` |
| Sign out | `atk auth logout m365` |
| Upload or update the shared app | `atk provision --env dev -f $dir -i false` |
| Share with users or groups | `atk share --env dev -f $dir --scope users --email 'a@contoso.com,b@contoso.com' -i false` |
| Revoke a user's access | `atk share remove --env dev -f $dir --users 'a@contoso.com' -i false` |
| Remove a co-owner | `atk share remove --env dev -f $dir --owners 'a@contoso.com' -i false` |
| Help for any command | `atk <command> --help`, for example `atk share --help` |

Do not use `atk share --scope tenant`: it shares the app with everyone in the tenant.

## Option B: Key Vault token (no client secret)

No long-lived credential is stored anywhere. A scheduled Container Apps job signs in with a
user-assigned managed identity, uses a federated credential on the bot app to mint a Bot Framework
token, and writes it to a Key Vault secret. agents-chat reads the secret with the Azure CLI login of
the account that runs the service.

The job has no ingress, no storage account, and no secrets. The identity can write only that one secret.

Set these PowerShell variables first:

```powershell
$rg = '<resource-group>'; $location = '<region>'; $kv = '<key-vault-name>'
$tenant = '<tenant-id>'; $appId = '<bot-app-id>'
```

1. **Managed identity**

   ```powershell
   az identity create -g $rg -n agent-bot-mi -l $location
   $mi = az identity show -g $rg -n agent-bot-mi | ConvertFrom-Json
   ```

2. **Federated credential on the bot app.** It trusts tokens of that identity only.

   ```powershell
   @{ name = 'agent-bot-mi'; issuer = "https://login.microsoftonline.com/$tenant/v2.0"
      subject = $mi.principalId; audiences = @('api://AzureADTokenExchange') } |
     ConvertTo-Json | Set-Content fic.json
   az ad app federated-credential create --id $appId --parameters fic.json
   Remove-Item fic.json
   ```

3. **Key Vault secret and roles.** The vault must use the RBAC permission model.

   ```powershell
   az keyvault secret set --vault-name $kv -n teams-bot-token --value pending -o none
   $kvId = az keyvault show -n $kv --query id -o tsv
   # The job identity can write this one secret only
   az role assignment create --role 'Key Vault Secrets Officer' --assignee-object-id $mi.principalId `
     --assignee-principal-type ServicePrincipal --scope "$kvId/secrets/teams-bot-token"
   # The account that runs agents-chat can read it
   az role assignment create --role 'Key Vault Secrets User' --assignee '<service-account-upn>' `
     --scope "$kvId/secrets/teams-bot-token"
   ```

4. **Token job.** Save this script as `token-job.sh`:

   ```bash
   set -euo pipefail
   az login --identity --client-id "$MI_CLIENT_ID" --allow-no-subscriptions -o none
   A=$(az account get-access-token --resource api://AzureADTokenExchange --query accessToken -o tsv)
   R=$(az rest --method post --skip-authorization-header --url "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token" --headers Content-Type=application/x-www-form-urlencoded --body "client_id=$APP_ID&grant_type=client_credentials&scope=https%3A%2F%2Fapi.botframework.com%2F.default&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer&client_assertion=$A" --query "[access_token,expires_in]" -o tsv)
   TOK=$(echo "$R" | sed -n 1p); EXP=$(echo "$R" | sed -n 2p)
   EXPAT=$(date -u -d "+${EXP} seconds" +%Y-%m-%dT%H:%M:%SZ)
   az keyvault secret set --vault-name "$VAULT" -n teams-bot-token --value "$TOK" --content-type application/jwt --tags "expiresAt=$EXPAT" -o none
   echo "token refreshed, expiresAt=$EXPAT"
   ```

   Then create the environment and the job from a JSON spec, which `--yaml` accepts, and run the
   job once. A spec file avoids the quoting problems of passing the script on the command line.

   ```powershell
   az containerapp env create -g $rg -n agent-bot-env -l $location --logs-destination none
   $envId = az containerapp env show -g $rg -n agent-bot-env --query id -o tsv
   $job = @{
     location = $location
     identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ $mi.id = @{} } }
     properties = @{
       environmentId = $envId
       configuration = @{
         triggerType = 'Schedule'; replicaTimeout = 300; replicaRetryLimit = 2
         scheduleTriggerConfig = @{ cronExpression = '*/30 * * * *'; parallelism = 1; replicaCompletionCount = 1 }
       }
       template = @{ containers = @(@{
         name = 'token'; image = 'mcr.microsoft.com/azure-cli:latest'
         resources = @{ cpu = 0.25; memory = '0.5Gi' }
         command = @('/bin/bash', '-c'); args = @((Get-Content token-job.sh -Raw) -replace "`r", '')
         env = @(
           @{ name = 'MI_CLIENT_ID'; value = $mi.clientId }, @{ name = 'TENANT_ID'; value = $tenant }
           @{ name = 'APP_ID'; value = $appId }, @{ name = 'VAULT'; value = $kv }
         )
       }) }
     }
   }
   $job | ConvertTo-Json -Depth 10 | Set-Content job.json
   az containerapp job create -g $rg -n agent-bot-token --yaml job.json
   az containerapp job start -g $rg -n agent-bot-token
   ```

   After a minute, the secret's `expiresAt` tag should be about 24 hours ahead:
   `az keyvault secret show --vault-name $kv -n teams-bot-token --query tags`.

5. **Server.** Set `TEAMS_BOT_TOKEN_VAULT=<key-vault-name>` and run `az login` as the account that
   runs agents-chat. If the service runs as another account (for example a Scheduled Task user),
   sign in as that account. On an Azure VM, run `az login --identity` instead.

The server caches the token and re-reads the secret every 10 minutes in the background. It rejects
tokens issued for another app or already expired. The job refreshes every 30 minutes and each token
lasts about 24 hours, so a few failed runs cause no outage.

## Security

- **Inbound authentication.** Only tokens issued by the Bot Connector service
  (`iss=https://api.botframework.com`) are accepted. They are verified with the Bot Framework signing
  keys, audience = bot app id, and a 5-minute clock tolerance. Entra ID tokens are rejected: any app
  in a tenant can get one with the bot as audience, so they do not prove the request came from Teams.
- **Request binding.** The token's `serviceurl` claim must match the activity, the tenant must equal
  `TEAMS_TENANT_ID`, the channel must be `msteams`, and only personal and group chats are served.
  Group chat members from other organizations and anonymous users are ignored.
- **Outbound token.** The bot token is only sent to Bot Framework / Teams service hosts on an
  allow-list, never to an arbitrary `serviceUrl`.
- **User identity** comes from a server-to-server roster lookup, not from message content. The bridge
  acts with that user's normal agents-chat permissions; `ADMIN_EMAILS` decides the admin role exactly
  as in the web UI. Access is deny-by-default: only emails listed in `TEAMS_ALLOWED_USERS` can use
  the bot, in 1:1 and group chats. Everyone else gets no reply at all (no welcome, help, error, or
  "not allowed" message), so the bot does not reveal itself to people who find or add it.
- **Keeping the app private.** Do not use **Publish → Publish to your org** in the Developer Portal;
  install it for yourself with **Preview in Teams** or a custom upload, keep yourself as the only
  owner, and share it only through [shared scope](#share-the-bot-with-colleagues), not by handing
  out the app package. Keep the app package and your `teams-app` folder out of git. Teams cannot
  stop someone who learns the bot app id from uploading their own package for it, which is why the
  allow-list is enforced on the server.
- **Session.** The bridge mints a short-lived (1 hour) NextAuth session token in memory and uses it
  only on the loopback call to `/api/acp`. It is never sent to Teams or written to disk.
- **Credentials.** Option B stores no credential on the server or in Azure. Key Vault holds only the
  short-lived Bot Framework token, and the job identity can write only that secret. If the host has a
  fixed outbound IP, you can also restrict the vault firewall to it.
- **Logs** contain activity metadata and errors, never tokens or message text.

## Performance

Measured with a local harness: real `/api/acp`, real Key Vault and agent, and a simulated
Bot Connector with 250 ms round trips.

| Step | Time |
| --- | --- |
| Endpoint acknowledgement | Immediate; processing runs in the background |
| First "Thinking…" indicator in Teams | ~0.3 s (warm), ~0.5 s for a new user (one roster lookup; then cached and re-checked in the background every hour) |
| Agent cold start (first message after a service restart) | 4–6 s, while the indicator is already shown. After 4 s it changes to "Starting the agent…", and after 20 s to "Still starting the agent…" |
| Agent finished → final message in Teams | ~0.5 s or less (500 ms poll + one Bot Connector call) |
| Streaming updates | At most one every 1.5 s, as Teams requires |
| Bot token and inbound signing keys | Fetched at service start (log line `Teams bot credentials warmed up`) and kept fresh every 5 minutes, so messages do not wait on `az`, Key Vault, or Entra ID |

After the indicator appears, it shows what the agent is doing (thinking, or the current tool)
until the first words of the answer stream in.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Endpoint returns `404` | A required `TEAMS_*` variable is missing, or the service was not restarted |
| Bot never answers; logs show `Rejected Teams activity` | The messaging endpoint points to another bot app id, or the server clock is off |
| Logs show `keyvault_cli_token_failed` | The service account is not signed in with `az login`, or the sign-in expired |
| Logs show `bot_token_keyvault_failed: 403` | The service account lacks *Key Vault Secrets User* on the secret |
| Logs show `bot_token_keyvault_expired` | The token job is failing. Run `az containerapp job execution list -g <rg> -n agent-bot-token -o table` |
| Bot does not reply at all, not even a welcome | The user is not in `TEAMS_ALLOWED_USERS` (or it is empty), has no email/UPN in the roster (for example a guest), or is outside `TEAMS_TENANT_ID`. Logs show `Ignoring Teams user ...` with the reason. Add the email and restart |
| "agent is not configured" / "do not have access" | Check `TEAMS_AGENT_ID` and the agent's sharing settings |

## Limitations

- 1:1 and group chats only. In team channels the bot only answers an @mention with a short notice.
- In a group chat, Teams allows one streamed reply at a time. If two people ask at once, the second
  reply arrives as a single message instead of streaming.
- Text only. Attachments and Adaptive Cards are not supported yet.
- In-flight turn state is kept in memory. A service restart during a reply ends that reply in Teams,
  but the full answer is still saved and visible in the web UI.
