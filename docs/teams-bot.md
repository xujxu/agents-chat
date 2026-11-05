# Microsoft Teams bot

agents-chat can expose one agent as a Microsoft Teams bot. Users send the bot a message in a
1:1 Teams chat, and the configured agent replies there. Replies stream as the agent writes them.

## How it works

```
Teams ──HTTPS──▶ /api/teams/messages ──loopback──▶ /api/acp (send / poll / respond / interrupt)
                     │                                   │
                     └── Bot Connector API ◀── replies ──┘
```

- Bot Framework calls the messaging endpoint with a signed JWT. The endpoint verifies the
  token (signature, audience = bot app id, issuer, tenant, and `serviceurl` claim), returns `200`
  right away, and handles the message in the background.
- The Teams user is mapped to an agents-chat account by **email/UPN**, looked up from the Teams
  roster. The bridge calls the existing `/api/acp` route as that user. Chat ownership, agent access,
  and admin role therefore work exactly as they do in the web UI.
- Each Teams 1:1 conversation maps to one agents-chat chat named `Teams: …`. These chats also
  appear in the web UI. `/new` starts a fresh chat.
- Agent questions and permission prompts are posted as numbered lists. Reply with the number or
  the label. Free-text questions take one answer per line.

## Commands

| Command | Effect |
| --- | --- |
| `/new [prompt]` | Start a new chat, optionally with a first prompt |
| `/stop` | Stop the running response |
| `/whoami` | Show the mapped account, agent, and chat id |
| `/help` | Show help |

## Setup

1. **Create the agent.** In the agents-chat Agents panel, create a dedicated agent for Teams
   (for example id `teams`). Make it public, or grant access to the users who will use the bot.
2. **Register the bot.** In the [Teams Developer Portal](https://dev.teams.microsoft.com/bots),
   create a bot and set the messaging endpoint to `https://<public-host>/api/teams/messages`.
   Give it a credential: a client secret, or, if your tenant blocks secrets, the
   [Key Vault token option](#key-vault-token-no-client-secret) below.
3. **Configure the server.** Add these to `.env.local`:

   | Variable | Required | Description |
   | --- | --- | --- |
   | `TEAMS_BOT_APP_ID` | yes | Bot (Entra app) id |
   | `TEAMS_BOT_APP_SECRET` | one of | Bot client secret |
   | `TEAMS_BOT_TOKEN_VAULT` | one of | Key Vault name or URL holding a pre-minted Bot Framework token |
   | `TEAMS_BOT_TOKEN_SECRET` | no | Secret name in that vault. Defaults to `teams-bot-token` |
   | `TEAMS_TENANT_ID` | yes | Tenant whose users may use the bot |
   | `TEAMS_AGENT_ID` | yes | Agent id that answers Teams messages |
   | `TEAMS_BOT_AUTH_TENANT` | no | Token tenant. Defaults to `TEAMS_TENANT_ID`; use `botframework.com` for multi-tenant bots |
   | `TEAMS_ALLOWED_USERS` | no | Comma-separated emails/UPNs allowed to use the bot |
   | `TEAMS_INTERNAL_BASE_URL` | no | Loopback URL of this app; defaults to `http://127.0.0.1:$PORT` (3000) |

   The feature stays disabled, and the endpoint returns `404`, until the app id, tenant, agent,
   and one credential are set. Restart the service after changing them.
4. **Install the app.** In the Developer Portal app, add the bot under *App features → Bot* with
   the **Personal** scope. Then use *Preview in Teams*, or download the package and upload it
   via *Apps → Manage your apps → Upload an app*.

## Key Vault token (no client secret)

Some tenants block client secrets and self-signed certificates on app registrations. In that
case, keep no credential locally: a scheduled job in Azure mints the bot token with a managed
identity, and this server reads it from Key Vault.

```
Container Apps Job (every 30 min, user-assigned managed identity, no ingress)
  └─ MI token (aud api://AzureADTokenExchange) ──federated credential on bot app──▶ Entra
       └─ Bot Framework token ──▶ Key Vault secret `teams-bot-token`
agents-chat ── `az account get-access-token --resource https://vault.azure.net` ──▶ reads secret
```

1. Create a user-assigned managed identity.
2. On the bot's Entra app, add a federated credential: issuer
   `https://login.microsoftonline.com/<tenant>/v2.0`, subject = the identity's principal id,
   audience `api://AzureADTokenExchange`.
3. Create the secret `teams-bot-token` in a Key Vault (RBAC mode). Grant the identity
   *Key Vault Secrets Officer* scoped to that secret only, and grant the account that runs
   agents-chat *Key Vault Secrets User*.
4. Create a scheduled Container Apps job (image `mcr.microsoft.com/azure-cli`) that runs
   `az login --identity`, exchanges the identity token for a token with scope
   `https://api.botframework.com/.default` (`client_assertion_type=…jwt-bearer`), and writes it to
   the secret.
5. Set `TEAMS_BOT_TOKEN_VAULT` and sign in with `az login` as the account that runs the service.

The server re-reads the secret every 10 minutes and rejects tokens issued for another app or
already expired.

## Limitations

- Personal (1:1) chats only. Group chats and channels are ignored.
- Text only. Attachments and Adaptive Cards are not supported yet.
- In-flight turn state is kept in memory. A service restart during a reply ends that reply in
  Teams, but the full answer is still saved and visible in the web UI.
