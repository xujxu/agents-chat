# Agents Chat

A standalone multi-agent chat UI for **ACP (Agent Client Protocol)** agents. Direct communication with ACP-compatible CLI tools — GitHub Copilot CLI, Claude Code, and any ACP-compliant agent.

![Next.js 16](https://img.shields.io/badge/Next.js-16-black) ![React 19](https://img.shields.io/badge/React-19-blue) ![SQLite](https://img.shields.io/badge/Storage-SQLite-green) ![ACP Protocol](https://img.shields.io/badge/Protocol-ACP-purple)

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- At least one ACP-compatible agent installed (GitHub Copilot CLI, Claude Code, etc.)

<p align="center">
  <img src="docs/images/screenshot-aurora-theme.png" width="49%" alt="Aurora theme" />
  <img src="docs/images/screenshot-claude-theme.png" width="49%" alt="Claude theme" />
</p>

## Quick Start

```bash
npm install
npm run dev          # starts on https://localhost:3010
```

Open [https://localhost:3010](https://localhost:3010).

> **Note:** `npm run dev` enables HTTPS via `--experimental-https`. Accept the self-signed cert on first load.

## Mobile browser compatibility

New and restored empty chats show a welcome view with `/` command and `@`
agent hints until the first conversation message. This view is not saved as
chat history. The composer placeholder shares the message-body typography;
mobile input text remains at least 16px to avoid focus-triggered zoom.

Markdown uses a document-wide text-adjustment policy to keep its font
sizes stable across portrait and landscape. Native pinch zoom remains
available.

Chat reading position is anchored to the bottom of the visible conversation
across orientation changes. Following the latest messages stays at the bottom;
when reading history, the same visible text or image position remains near the
composer. Scrolling manually establishes a new reading position.

**Known limitation:** In the observed iPhone Chrome environment, pinching
larger, returning to original scale, releasing, then rotating can leave
the whole page unexpectedly zoomed. This also reproduced on an isolated
HTML page without the chat runtime; the paired Safari trial stayed at
original scale. The typography fix does not correct this native page-zoom
behavior. Safari is a verified temporary alternative for that observed
case, not a guarantee across every browser or OS version.

## Production

For persistent deployment, use one of the platform-specific scripts below. Both handle build + restart + health check in one command.

### Chat persistence and proxy limits

The browser saves only new or changed messages. Small updates are batched below
512 KiB; individually larger messages, attachments, and ACP prompt/context
payloads use resumable 256 KiB binary chunks (about 350 KiB per JSON request).
The final save/send request contains a small upload reference. Nginx's default
1 MiB request limit therefore does not require increasing. ACP tool and thinking
parts remain server-owned and are not uploaded back by the browser.

Before clearing the composer, saves enter an IndexedDB outbox scoped to the
authenticated user and application chat ID, not the rotating ACP session ID.
User messages must also be confirmed by the server before agent dispatch.
Network requests time out after 30 seconds; retries reuse the same immutable
operation ID. Successful commits and their receipts are atomic, so a lost
acknowledgement does not duplicate messages. Refresh/online recovery retries
pending saves, **never agent execution**. Use the message's **Retry** action
explicitly when you want to send a recovered question to an agent.
Interrupted sends retain a pending-confirmation state even in chats with existing
agent sessions; recovery exposes Retry with a warning to check existing replies.
This includes replies sent from the workflow follow-up card.
Only the submitted composer revision and attachments are cleared after local
staging, so typing the next message while storage is busy does not erase it.
Navigation cancels active save requests without discarding unconfirmed drafts.
Recovery adopts newer server revisions and ignores stale reads that would move
the confirmed message version backwards.

The local drafts panel provides server/local comparison, JSON download (including
attachments), discard, and **Save as new message**.
Recovery copies reuse a durable operation associated with the source draft,
including when their acknowledgement is lost. Attachment-only copies retain
their retry prompt and original agent selection.
Switching accounts isolates both drafts and recovery error/busy state; delayed
callbacks from the previous account cannot consume drafts or replace the current
conversation with their response.
Different message IDs merge; conflicting edits to the same ID are retained locally rather than silently
overwriting another device. Deleted chats have persistent tombstones: delayed
saves cannot resurrect them, and recovered copies use a new chat ID. Same-browser
tabs coordinate uploads with renewable 60-second IndexedDB leases; server version
checks and idempotency remain authoritative across devices.

Each serialized upload is limited to 64 MiB; existing attachment limits still
apply (8 files, 10 MiB each, 25 MiB total before Base64 encoding). Incomplete
uploads expire after 24 hours, with at most 128 uploads / 256 MiB reserved per user.
Successful clients release uploads after acknowledgement. Browser storage
availability/quota failures are explicit: keep the tab open and copy/download
the message if local storage is unavailable. Clearing browser data also deletes
unsynced drafts. HTTPS or localhost is required for browser cryptographic upload
checksums. This change does not recover messages already missing from the database.

### Binary release bundles

GitHub Releases can also publish prebuilt runtime bundles for Windows and Linux. Each release asset contains the Next.js standalone server output, static assets, `public/`, `.env.example`, and startup scripts:

- Linux: `agents-chat-linux-x64.tar.gz`
- Windows: `agents-chat-windows-x64.zip`

Create a release by pushing a tag such as `v0.1.0`:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The release workflow in `.github/workflows/release.yml` will build both bundles and upload them to the matching GitHub Release draft. After downloading a bundle:

```bash
cp .env.example .env.local
PORT=3010 ./scripts/start-release.sh
```

On Windows:

```powershell
Copy-Item .env.example .env.local
powershell -ExecutionPolicy Bypass -File .\scripts\start-release.ps1
```

### Deployment (Windows Scheduled Task)

For persistent deployment on a Windows machine, use `scripts\deploy.ps1` which manages a Scheduled Task that auto-starts the app on login/boot.

On this development branch, Windows transaction/backup/recovery integration is
still incomplete; do not use it as the final cross-platform deployment release.
The task parameter and read-only definition changes below passed native
PowerShell 5.1 acceptance. The full 25-job regression, including private
runtime-control transport, task-held Jobs, scoped control requests,
retained private configuration, direct native task-owner checks and the
installed private runtime host, native restart inhibition and write-through
private receipt publication, durable native task-stop contexts and
original-Node-controller close/exit handling, private lock/state transaction
authorization, native private-directory creation and distinct child-token/Job
characterization with actual private Node lock/state/journal/saved-engine
creation, passed at `c7de917` (run `37017549550`). This also accepts the
production native controller process: literal arguments and bidirectional
stdio, unchanged caller token, private child-file ownership, retained working
directory, and original-Job descendant settlement without stopping independent
processes. Real task controllers and installed runtime bundles now use
production creation-time privacy rather than fixture ACL repair.
Native original-owner retirement also passed for update and restore
(task-options job `110784933138`): the task stays disabled, its
original owner exits cleanly, and private receipts bind the exact activation
state. Disabled replacement-task publication also passed: it preserves
account, triggers, existing permissions (including a nondefault ACL) and
unrelated task XML, retains a validated private candidate, and publishes
intent/completion evidence without starting it. Incorrect digests and paths
containing Scheduler substitutions are refused before replacement.
Controller-bound unverified runtime lifetime and authenticated lease release
also passed: original controller loss or expiry terminates the guarded host
and its original Job, while release by the actual original pipe peer lets the
same runtime survive controller exit. This does not establish application
health. Guarded transactional replacement activation also passed native
update/restore and controller-loss cases (`ad311cf`, job `110814478038`):
temporary demand-start suppresses triggers and restart-on-failure, the new
original task/Job is bound to private readiness, and the task is disabled
again while its runtime lease remains armed. All 24 regression jobs passed
for this step; transaction-evidence retirement and lock release remain
incomplete. Active checks retain the original Scheduler
instance as well as the process, and reject a changed activation-state digest
before settling the unreleased generation.
Integration into the public deployment entrypoints remains pending.
The isolated real Windows application job also passed in that run:
three prebuilt managed starts, authenticated chat
persistence, stopped-database restoration, original-Job listener ownership and
unchanged build artifacts. This is not yet acceptance of the public Windows
deploy/update/restore transaction.
Native listener checks now retain original process/Job ownership and kernel
bind time, including the exact dual-stack wildcard pair. Foreign listeners,
same-process rebinds and independently created same-process wildcard pairs
are refused. Controller-side HTTP readiness and the full 24-job shared-readiness
regression passed at `839ac62`, including saved Linux restore and real Windows
application/data checks. Health-gated permanent task-policy restoration and
original-peer lease release passed native update/restore, custom-permission,
originally-disabled and changed-state cases at `f7c5e19`; all 24 regression
jobs also passed. Actual read-only lease observation passed at `8f3063b`,
including observation of the released original runtime after controller exit;
all 24 jobs passed. The fresh-process completed-task proof now retains the
23-file private evidence chain, lock/state, installed bundles and original
native runtime/listener identity. It is read-only and grants no mutation or
lock-release authority; its dedicated 25th regression job and full regression
passed at `2c1aafc`. Expanded native update, restore/custom-permission and
originally-disabled cases passed at `c7de917`, including refusals for live
controllers, changed evidence/policy and same-process listener rebinding.
The expanded full regression also passed all 25 jobs.
Windows shared admission uses a private, non-inherited
exclusive file handle, following the standard package-manager locking pattern.
The primitive preserves durable operation evidence and does not itself permit
recovery or unlock. Native admission and the three completed-task proof
scenarios passed at `234bef9`, along with all 25 full-regression jobs.
The original-controller-bound bridge passed native acceptance at `c1f90f1`,
including competing processes, invalid contexts/requests and controller loss.
Its full regression also passed all 25 jobs. Shared admission is now wired
into Windows operation-lock acquisition/release and saved worker-retirement
recovery, with explicit PowerShell selection and retained-context checks.
This entrypoint integration passed all 25 Actions jobs at `b08a6fe`, including
real Windows application/data restoration and native publication with generated
temporary paths beyond MAX_PATH. Admission never grants authority to bypass
durable evidence. Mutating Windows controllers
and their test fixtures use private creation-time ownership rather than
repairing arbitrary existing permissions.
Recovery integration retains the completed-task proof on its original
native controller while the caller holds actual same-installation admission.
Its native contention, strict-context/protocol and controller-loss cases passed
at `119b17e`, including update, restore and originally disabled tasks; all 25
Actions jobs passed. It does not grant evidence-deletion or unlock authority.
The retained proof can prepare a private `task-retirement.json`, binding the
original lock/state, all 23 maintenance records, directory/file identities
and the original preparing processes. Reopening preserves the original intent
and requires either that same retained session or both original preparers
absent. This preparation preserves every maintenance file and the operation
lock. This preparation passed all 25 Actions jobs at `b30581f`, including
original-actor loss and strict reopening/refusal on all three native scenarios.
The private-file layer also provides an explicit exclusive, checked
DELETE-capable handle. It deletes only the original descriptor-matched file
through that handle; ordinary disposal preserves it. Its native refusal and
deletion cases, all three completed-task scenarios, and the full 25-job
regression passed at `00c9857`. It is not yet wired as task retirement or
unlock authority.
The retained full proof can also prepare a private runtime checkpoint bound
to that intent: exact task-policy/security hashes, original listener binding,
installed configuration and retired process identities. It preserves all
receipts and is intended for subsequent partial-cleanup recovery; native
checkpoint acceptance passed all three scenarios and the full 25-job
regression at `cb7a2aa`; its receipt-cleanup consumer is accepted below.
Both root retirement records independently block ordinary lock acquisition,
release, worker-retirement recovery and idle reporting even without the task
receipt directory. Windows checks include case aliases; marker contents are
not interpreted as permission to clear the barrier.
Checkpoint-backed receipt retirement now has a separate native scope and
Actions fixture: live handoff retains the original controller, while cold
reopening accepts only an exact missing prefix after creator loss. Each
request deletes only the next original descriptor through its exclusive
native handle. All three native scenarios and the full 26-job regression
passed at `670818a / 37067463428`. The consumer retains the
empty task receipt directory, state, lock and both root records, and does not
perform final worker cleanup or unlock.
The native empty-directory retirement handle passed its Windows refusal cases
and the full 26-job regression at `0a1500a / 37071297219`.
A final-cleanup consumer now retains and
validates the original sealed worker operation, publishes a private version 3
`worker-retirement.json`, and transfers the same native controller. Its fixed
entry list covers the empty task directory, settled worker evidence, saved
worker helpers, task markers and old lock. Cold reopening uses the retained
manifest and an independent saved recovery engine, never directory absence
alone. Ordinary ownership stays blocked until the final manifest is retired.
All three native scenarios (update, restore and originally disabled task),
including two destructive crash prefixes, final unlock and preservation of
unrelated runtime bundles, passed at `8599304 / 37076374627`. The full
26-job Linux/Windows regression also passed.
The live completion controller additionally exposes single-step native
acknowledgements for deterministic write-ahead interruption testing. It keeps
the existing nine receipt files and the normal all-at-once completion API;
the update, restore and disabled-task scenarios and all 26 regression jobs
passed at `6b9e26d / 37080601995`. This remains live-owner authority, not cold
recovery. A separate interrupted-completion consumer now replays only a
validated receipt prefix for the same surviving, released runtime, after
fresh native-listener and HTTP checks. It preserves original receipt values
and reconciles only recognized task-policy states. An exclusive read-only
handle to the existing release-intent receipt keeps a dying recovery bridge
serialized until its own exit, even after its Node admission owner exits.
The consumer, five genuine actor-loss cases and all 31 regression jobs passed
at `4b1a84f / 37082766145`. Additional coverage that loses admission while a
recovery bridge remains alive, then kills the recovery actor and resumes
its acknowledged progress, also passed with all 31 jobs at
`e4c793f / 37083428275`.
Pre-release/reboot recovery and public Windows integration remain unaccepted.
Installed native-task discovery is now implemented as a separate read-only
observer. All three native discovery cases (update, restore with custom task
security, and originally disabled task) and all 34 regression jobs passed at
`5928115 / 37086347173`. It derives the literal installed bundle
from the actual task, retains original process/instance/account and private
readiness evidence, and checks that generation's active Job and unguarded or
released lease. It does not depend on retired operation journals, create
admission or lock records, grant stop authority, or infer HTTP health.
A separate production capture helper now publishes the existing task admission
record from that retained observer, the original live operation lock and matching
preflight state under shared native admission. It uses explicit private native
publication rather than caller-provided runtime metadata. Update, custom-security
restore and originally disabled native scenarios, including refusal cases and
the complete stop-to-cleanup sequence, passed with all 34 regression jobs at
`e59b0e9 / 37089382913`. Public Windows command composition remains unfinished.
Windows owned source/build stages now share the existing Linux orchestration
and bind mutations to the original native task transaction, selected commit
and designated phase. The native fixture's actual Git/npm commands, small
fixture build and subsequent completion/cleanup passed with all 34 regression
jobs at `a2092bf / 37092400795`; this is not full application deployment
acceptance. Build workers use the installed task's account in the controller's
actual session, which may differ from an S4U service's session zero; native
worker account/session checks remain enforced. Cross-account execution is
refused before worker enrollment. Cold recovery does not gain a rebuild dependency.
Windows configuration inspection is implemented with retained native source
file identities, content hashes and owner/group/DACL descriptors, including
explicit absence checks. It reads the installed bundle environment, applies
case-insensitive Windows dotenv/build precedence, and refuses ambiguous aliases
without reporting secret values. Native ACL-change and source/build integration
passed with all 34 lifecycle jobs (`4cf4e97`, Actions `37095933156`). This does
not yet implement ACL restoration or broaden the private backup policy.
Windows snapshot capture now includes deduplicated owner/group/DACL and
ordinary file-attribute metadata in a version-3 manifest, with source ACL
rechecks and a private destination requirement. Native cases and all 34 lifecycle
jobs passed (`188ab55`, Actions `37098213362`). Existing Linux snapshot formats remain unchanged; saved
recovery includes the new verification dependencies. Windows project payload
restoration now uses private creation before copying, identity-bound deletion
including read-only files, and standard handle-based owner/group/DACL and
attribute restoration. It requires version-3 metadata and unchanged root policy;
legacy, cross-account, Git-bearing and external-runtime snapshots refuse before
project mutation. Windows may add the DACL `AI` flag when its standard security
API converts a legacy descriptor to automatic inheritance; restoration permits
only that addition, not changes to owners, groups, ACE order/rights/inheritance,
protection flags or file attributes. Root policy remains exact.
This implementation is awaiting Windows Actions acceptance;
Git/runtime restoration and full Windows application acceptance remain separate.
First registration defaults to the current Windows account, or accepts an
explicit `-UserId`. On redeployment, omitted account, logon, trigger and tunnel
options preserve the existing supported task settings. Foreign task actions and
unsupported principal/trigger modes are refused before changing the task.
The native task-definition inspector records and rechecks XML,
task permissions, principal/mode settings and Scheduler instances. It is
read-only and explicitly returns no runtime authority: a Scheduler engine PID
is not proof of ownership of the watchdog or its descendants, and Ready or
Disabled is not proof that application processes are stopped. Public integration
of Windows containment, artifact/configuration binding and recovery remains pending.

```powershell
# Deploy (pulls latest code, restarts the service, waits for readiness)
.\scripts\deploy.ps1

# Deploy without git pull
.\scripts\deploy.ps1 -SkipGitPull

# Deploy with AtStartup trigger (runs even without login)
.\scripts\deploy.ps1 -TaskTriggerType AtStartup -TaskLogonType S4U

# Local serving behind separately managed HTTPS; no tunnel or Azure AD changes
.\scripts\deploy.ps1 -UserId 'MACHINE\appuser' -NoTunnel

# Explicitly restore normal tunnel startup for a previously NoTunnel task
.\scripts\deploy.ps1 -NoTunnel:$false

# Remove the scheduled task entirely
.\scripts\deploy.ps1 -RemoveTask
```

The deploy script:
1. Pulls latest code from git (unless `-SkipGitPull`)
2. Stops the existing Scheduled Task and cleans up port 3000
3. Restarts the task so the app rebuilds and serves again
4. Waits up to 180s for `localhost:3000` to respond

Logs are written to `logs/service-watchdog.log` and `logs/start-service-child.log`.

### Deployment (Linux systemd)

**Deployment-backup branch: staged update command.** The new
`sudo bash scripts/update.sh --project-dir /absolute/installed/checkout` updates
an **existing running, inactive or failed** `agents-chat.service` using its installed account,
Node/npm and configuration, rather than the invoking user's environment.
It supports execution inside the installed checkout or from separate tools via
`--project-dir`. Before source replacement it captures controller code in a private
temporary directory, including modules needed by later dynamic imports and worker
bootstraps. Completed commands remove this code-only copy; an abruptly killed
controller may leave one under `/tmp/agents-chat-controller-*`. These directories
contain neither application data nor configuration and are not recovery authority.
`--dry-run --json` reports local revisions, estimated backup/build space, planned
steps and pending checks without fetching, creating control files, launching
workers or executing target code. It does not run Git status/filters/fsmonitor,
so source cleanliness remains pending, along with target/database admission,
capacity rechecks and readiness. An unavailable local target is explicitly
unknown; a tracking ref is never presented as remotely refreshed. Preview does
not replace the last operation result or authorize an update.
To restore the retained backup, use
`sudo bash scripts/restore.sh --project-dir /absolute/installed/checkout --accept-data-loss`.
Export newer data first: restoration replaces application data with its backup
version. The command verifies and invokes the saved external recovery engine;
it does not fetch Git objects, install dependencies or build the application.
It accepts `--json` and `--timeout SECONDS` (per-stage, default 1800); `--help`
lists its requirements. If the selected historical source has no restore script,
run this command from a separate tools checkout and specify the installed path.
New native backups bind the exact recovery-engine digest in a version-2 snapshot.
When controller helpers change, the update saves an immutable
`recovery-engine-<sha256>` generation rather than replacing the original
`recovery-engine` directory. Version-1 backups continue to use that original
engine. Do not remove these directories or unpublished `.staging` evidence;
older restore tools that cannot read version-2 snapshots must not be used.
After a successful update and verified worker retirement, obsolete generated
engines are removed while preserving the original engine and the generation
required by the retained backup/current operation. Cleanup first renames a
verified unused generation to `retired-recovery-engine-<sha256>` and removes its
manifest last, allowing interrupted file deletion to resume. Unknown files,
staging directories or unsettled worker evidence block cleanup rather than
being silently discarded.
Use `--help` for supported flags, `--status --json` for read-only status, and
`--json` for machine-readable outcomes (progress/errors remain on stderr).
Failed deploy/update results include bounded diagnostic codes and controller
module line/column locations, without raw exceptions, private paths or native
command output.
If the retained backup directory is absent, restore refuses with
`DEPLOYMENT_BACKUP_MISSING` (`backupAvailable: false` in JSON); it cannot recover
a failed first installation without a previous backup. Existing but incomplete
backup contents are reported as errors, not reclassified as a missing backup.
Git object backups include single-file and split commit graphs. Restoration
preserves newer immutable objects while restoring the saved graph pointer layout;
alternate object stores, unknown entries and writer locks remain unsupported.
The controller requires Node.js 24+, `/usr/bin/git`, systemd, port 3010, and a
minimum 2 GiB build-space budget in addition to backup space. It keeps one
complete backup and independent recovery helpers in the private sibling
`.<project-basename>.deployment` directory. Preserve that directory after failure.

This command is **not yet the complete cross-platform deployment release**:
first install and deferred verification/no-wait are
not supported by `update.sh` and are refused rather than delegated to another
installer. The first-install controller and its version-4 live/cold retirement
have passed Actions acceptance, including real source builds, application
readiness, cancellation and interruption/tampering recovery.

**Public `deploy.sh` has passed fresh-install and running-service Actions
acceptance. Do not use this branch on a live installation before the remaining
runtime-mode and platform gates.** The old
root build/install procedure has been replaced, not retained as a fallback.
The staged native command supports a fresh installation or redeployment of an
existing running, inactive or failed service; deferred verification,
`--wait 0` and deploy `--dry-run` are explicitly refused.
The continuous Linux gate also passes first deployment, an unchanged update,
two source-content updates, and saved recovery of the original source, build
and authenticated chat data after removing installed scripts and Git packs.

Inactive/failed public lifecycle support passed all 22 Actions jobs at
`5eb4d81` (run `36870898113`). Admission does not start the service
to discover its executables or read a fictitious process environment. It requires
literal `npm start`, npm's `#!/usr/bin/env node` interpreter, and an external Node
selected from the retained startup PATH (unit/EnvironmentFile, then ExecSearchPath,
then manager PATH), not the controller or Next dotenv PATH. Project-local candidates
are refused, and earlier PATH candidates are rechecked throughout the operation.
Non-locale manager-global environment assignments must be explicitly overridden in
the retained unit/EnvironmentFile; dotenv does not mask those startup assignments.
For example, a host-global `SGX_AESM_ADDR` needs a deliberate per-service assignment
if present. Do not remove host-wide settings just to admit an update.
A stopped same-commit update still builds and verifies. Pre-source failure never
starts an originally stopped service; explicit restore starts and verifies the
restored application. Status and preview preserve the stopped/failed state and
do not claim that readiness passed.

For first installation, prepare a clean source checkout owned by its non-root,
primary-group-only runtime account and private production authentication
configuration, such as `.env.local`. The account needs a writable npm cache,
normally under its home.
The service must be absent, without prior `.data`, `.next`, `node_modules` or
operation evidence. Existing artifacts/evidence require inspection, not deletion
to force a fresh install. The controller requires Node.js 24, `/usr/bin/git`
and systemd; it does not automatically install packages, change account ownership
or generate configuration.

```bash
# Read-only help/status
sudo ./scripts/deploy.sh --help
sudo ./scripts/deploy.sh --project-dir /absolute/checkout --status --json

# Fresh source build, owned service publication, enablement and readiness
sudo ./scripts/deploy.sh --project-dir /absolute/checkout --no-pull

# Existing installation: redeploy, or update (running services can be already-current)
sudo ./scripts/deploy.sh --project-dir /absolute/checkout --no-pull
sudo ./scripts/update.sh --project-dir /absolute/checkout
```

Root controls systemd and private transaction evidence; fresh source-changing
Git operations, npm/build and application processes use the non-root checkout owner, not the sudo
caller. Existing installations retain their admitted account, Node/npm
executables and configuration. Redeploy uses `operation: deploy` and does not
skip merely because its source is already current. `--no-install` is supported
only for an existing installation; fresh installation always installs
dependencies. Positive `--wait`, `--timeout`, `--revision`, `--json` and
`--project-dir` follow the update command's conventions.

First deployment creates no prior backup. On failure it explicitly reports this
and retains the lock and worker/service evidence for inspection. First-unit
publication and enablement are separately journaled and initially inhibited;
startup alone is not application acceptance. Version-4 accepted retirement
binds the real installation/enablement journals, persistent startup link and
published deployment receipt. The link and receipt are never deletion targets
and remain prerequisites throughout live and saved cold cleanup.

Manage the service:

```bash
sudo systemctl status   agents-chat
sudo systemctl restart  agents-chat
sudo systemctl stop     agents-chat
sudo journalctl -u agents-chat -f          # live log stream
```

Fresh units set production mode and their inspected executable path/home.
Next.js reads the admitted project dotenv files in production precedence order:
`.env.production.local`, `.env.local`, `.env.production`, then `.env`.
Use supported literal values and keep authentication configuration private.
Fresh units do not automatically load `/etc/agents-chat.env` or inherit the
root controller's environment. Existing services retain their admitted systemd
environment and `EnvironmentFile` settings. Native readiness currently uses
port 3010; changing an arbitrary `PORT` value does not change that contract.

### Logging

The server uses **pino + pino-roll** for structured logs. Defaults:

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` (prod) / `debug` (dev) | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `LOG_DIR` | `<project>/logs` | Absolute or relative path |
| `LOG_FILE` | `app.log` | Base file name |
| `LOG_ROTATE_FREQUENCY` | `daily` | `daily` / `hourly` / milliseconds |
| `LOG_ROTATE_SIZE` | `10m` | Max size before mid-period rotation |
| `LOG_RETENTION` | `7` | Number of rotated files to keep |

Files written under `$LOG_DIR`:

- `app.<date>.<n>.log` — pino structured JSON (rotated)

On Linux, stdout/stderr are also captured by journald (`journalctl -u agents-chat`).

## Features

- **Multi-agent chat** — Talk to one ACP agent or mention multiple agents in one message.
- **@mention routing** — Type `@agent-id` to target specific agents; messages without mentions go to the currently selected/default agent.
- **Auto agent orchestration** — A scheduler agent decides which agent should act next, evaluates results, and produces a final summary.
- **Discussion orchestration** — Run multiple agents in parallel for configurable rounds, then summarize.
- **Pipeline orchestration** — Run agents sequentially, passing each output to the next.
- **File attachments** — Drag-and-drop or click to attach images and files to messages (up to 8 files, 10 MB each).
- **Files tab** — Browse an agent's working directory (local _or_ remote/relay agents), filter to changed files, open files inline, edit Markdown with split preview or live editing, and save changes back to disk. For relay agents the backend auto-connects the node and resolves `cwd` from the remote machine.
- **Model selection** — Per-agent model picker synced from the agent's available models.
- **Slash commands** — Type `/` in a single-agent chat to pick from the agent's ACP-advertised slash commands (autocomplete dropdown).
- **In-app ACP sign-in** — Agents that require authentication (e.g., Copilot CLI) expose a sign-in flow directly in the UI; the composer surfaces a `needs auth` pill when a turn fails because of missing auth and verifies sign-in actually succeeded.
- **Scheduler / cron jobs** — Schedule any agent to run on a cron expression with per-job run timeout, a themed time picker, and schedule times rendered in the user's local timezone.
- **Environment variables** — Per-agent KEY=VALUE configuration for API keys and agent settings.
- **Themes** — 5 built-in themes (Aurora, Sunset, VS Code Dark, Claude, ChatGPT).
- **Message actions** — Copy (plain), **Copy with format** (rich Markdown→HTML/Markdown, excluding thinking and tool-call DOM), retry, or branch from any message.
- **Mention autocomplete** — Typing `@` filters the agent dropdown as you type.
- **Full screen toggle** — Header button (desktop + mobile) to expand the chat into full screen.
- **Multi-turn queue** — Send follow-up messages while an agent is processing; turns are queued and executed in order.
- **Streaming responses** — Real-time streaming with phase indicators for thinking, tool execution, and replying.
- **Agent management** — Add, configure, remove, and permission agents from the UI. The "last used agent" is persisted per-user on the server.
- **Relay agents** — Connect to remote agents on other machines via Azure Relay.
- **Node registry** — Register and discover remote agent nodes; auto-discovers Azure Relay hybrid connections. The Node Setup Kit lets you choose the launcher (Copilot CLI or Agency).
- **Chat history** — Persistent message history in SQLite (`.data/chats.db`) with sidebar run status, sorted newest-first and filtered to the signed-in user.
- **Session resume** — Reloading a chat restores agent session context via `session/load`.
- **Shared chats** — Generate a read-only share link for any conversation, with Open Graph image optimized for Teams previews.
- **Mobile responsive** — Full-featured UI on phones and tablets with swipeable panels and touch-friendly controls. On mobile, the sidebar collapse button closes the navigation drawer; the header navigation button reopens the full Chats/Files tabs without changing the saved desktop collapse preference.
- **Authentication** — Azure AD SSO, **GitHub OAuth**, or local credentials login; admin/user roles.

## Using the app

### Chat and message routing

1. Select or create a chat from the left **Chats** sidebar.
2. Type a normal message to send it to the default selected agent.
3. Type `@agent-id` to route the message to a specific agent.
4. Mention multiple agents, for example `@frontend @reviewer implement and review this change`, to enable orchestration controls in the composer.

The chat sidebar shows each chat's recent status so you can switch away while a turn is running and still see whether it is `Running`, `Done`, or `Error`.

### Auto agent orchestration

When a message mentions more than one agent, the composer exposes orchestration modes:

- **Auto** — A scheduler agent plans the next step, chooses one of the mentioned agents, waits for its result, then decides whether another agent should run or whether to produce a final summary.
- **Discussion** — All mentioned agents respond in parallel. You can choose the number of discussion rounds. A summary is generated after the final round.
- **Pipeline** — Agents run in the order they were mentioned. Each agent receives the previous agent's output.

Auto mode is useful when the task has conditional flow, such as "ask one agent to implement, then have another test/review depending on the result." The scheduler is routing-only: it should pick agents and write instructions rather than doing project work itself.

### Slash commands

In a chat targeting a single agent, type `/` in the composer to open a dropdown of the agent's ACP-advertised slash commands. Selecting one inserts the command; arguments (if any) can be typed after it. Slash commands are only shown when the chat targets exactly one agent.

### Scheduler (cron jobs)

Any agent can be scheduled to run on a cron expression:

1. Open the agent's settings or the **Scheduler** UI.
2. Pick a cron schedule using the themed picker (times are displayed in your local timezone).
3. Set an optional **per-job run timeout** so a stuck job is cancelled automatically.
4. Save. The job will fire on schedule, run a turn against the agent, and record the result.

### In-app ACP sign-in

Some ACP agents (for example GitHub Copilot CLI) require authentication before they can answer prompts. When an agent reports it needs auth:

- The composer surfaces a **needs auth** pill.
- Open the agent's panel and click **Sign in**. The UI runs the agent's `authenticate` ACP flow and verifies the sign-in actually completed before clearing the pill.

### Files tab

The left sidebar has two tabs: **Chats** and **Files**.

Use **Files** to inspect and edit files from any agent's working directory (local _or_ relay):

1. Open the **Files** tab.
2. Choose an agent from the dropdown. Relay agents are supported — the backend auto-connects the node and resolves the working directory from the remote machine.
3. Browse the file tree. The backend skips heavy/generated folders such as `.git`, `node_modules`, `.next`, `dist`, `build`, and binary/media file extensions.
4. Click a file to open it inline.
5. For Markdown files, choose:
   - **Split** — text editor plus rendered preview.
   - **Live Edit** — editable rendered Markdown.
6. Click **Save** to write changes back to the agent's working directory.

The **Diff / Changed** toggle lists only files changed according to git (`git diff --name-only HEAD` plus untracked files). Files listing no longer has an artificial file-count cap, but it still keeps traversal safety guards such as maximum depth and skipped directories/extensions.

## Configuration

### Environment variables

Copy `.env.example` to `.env.local` and fill in the required values:

```bash
cp .env.example .env.local
```

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXTAUTH_SECRET` | ✅ | Random secret for signing JWTs |
| `NEXTAUTH_URL` | ✅ | Public URL of the app, for example `https://localhost:3010` |
| `AZURE_AD_CLIENT_ID` | Optional | Azure AD / Microsoft Entra app client ID; enables SSO login when set |
| `AZURE_AD_CLIENT_SECRET` | Optional | Azure AD client secret |
| `AZURE_AD_TENANT_ID` | Optional | Tenant ID, default `common` |
| `GITHUB_CLIENT_ID` | Optional | GitHub OAuth app client ID; enables "Sign in with GitHub" when set. Configure the OAuth app's callback URL as `${NEXTAUTH_URL}/api/auth/callback/github`. |
| `GITHUB_CLIENT_SECRET` | Optional | GitHub OAuth client secret |
| `ADMIN_USERNAME` | Optional | Local admin username for credentials login |
| `ADMIN_PASSWORD` | Optional | Local admin password |
| `ADMIN_EMAILS` | Optional | Comma-separated emails granted admin role for Azure AD users |
| `RELAY_SEND_CONNECTION_STRING` | Optional | Azure Relay send connection string; required for relay agents and node probing |
| `RELAY_KEY_VAULT_NAME` | Optional | Key Vault name used when generating the node setup ZIP |
| `RELAY_KEY_VAULT_SECRET_NAME` | Optional | Key Vault secret name used when generating the node setup ZIP |
| `RELAY_SUBSCRIPTION_ID` | Optional | Azure subscription ID used by node setup ZIPs and relay node auto-discovery |
| `RELAY_RESOURCE_GROUP` | Optional | Azure resource group used by node setup ZIPs and relay node auto-discovery |
| `RELAY_NAMESPACE` | Optional | Azure Relay namespace name |

### Agents

Agents are stored in SQLite (`.data/config.db`) and managed through the UI. On first boot the app auto-migrates any existing `agents.json` file.

#### Add a local/server agent from the UI

1. Open the right **Agents** panel.
2. Click **+**.
3. Choose **Add Agent in Server**. This option is admin-only because it starts a process on the app server.
4. Fill in:
   - **Agent ID** — unique lowercase identifier, used for `@mentions`.
   - **Display Name** — human-friendly name in the UI.
   - **Command** — ACP-compatible executable, for example `copilot.exe`, or an absolute path.
   - **Arguments** — space-separated arguments, commonly `--acp`.
   - **Working Directory** — project folder where the agent should run.
   - **YOLO mode** — auto-approve mode; the backend appends the relevant yolo flag where supported.
5. Click **Create Agent**.

#### Add a GitHub Copilot CLI agent

1. Open the right **Agents** panel → **+** → **Add Agent in Server**.
2. Fill in:
   - **Agent ID** — e.g. `copilot`
   - **Display Name** — e.g. `GitHub Copilot`
   - **Command** — `copilot.exe` (or full path to the Copilot CLI binary)
   - **Arguments** — `--acp`
   - **Working Directory** — project folder
   - **YOLO mode** — check to auto-approve tool calls
3. Click **Create Agent**.

#### Add a Claude Code agent

Claude Code can be added as an ACP agent using the `@agentclientprotocol/claude-agent-acp` package:

1. Open the right **Agents** panel → **+** → **Add Agent in Server**.
2. Fill in:
   - **Agent ID** — e.g. `claude-code`
   - **Display Name** — e.g. `claude-code`
   - **Command** — `npx`
   - **Arguments** — `@agentclientprotocol/claude-agent-acp@latest`
   - **Working Directory** — project folder where Claude should operate
   - **YOLO mode** — check to auto-approve tool calls
3. Click **Create Agent**.

##### Using with an Anthropic API key

Set the following in the agent's **Environment Variables** textarea (in Settings):

```
ANTHROPIC_API_KEY=sk-ant-...
```

> **Important:** Leave the model picker on the model you set in env after starting the agent. The `ANTHROPIC_MODEL` env var controls which model is used. Selecting a model from the picker will override the env var with an incompatible internal name, causing "model not supported" errors.

#### Other supported ACP agents

Any ACP-compatible tool can be added. Here are common examples:

**Gemini CLI**
```json
{
  "id": "gemini",
  "name": "Gemini CLI",
  "command": "npx",
  "args": ["@google/gemini-cli@latest", "--experimental-acp"],
  "cwd": ""
}
```

**Codex CLI**
```json
{
  "id": "codex",
  "name": "Codex CLI",
  "command": "npx",
  "args": ["@zed-industries/codex-acp@latest"],
  "cwd": ""
}
```

**OpenClaw**
```json
{
  "id": "openclaw",
  "name": "OpenClaw",
  "command": "npx",
  "args": ["openclaw", "acp"],
  "cwd": ""
}
```

**Hermes Agent**
```json
{
  "id": "hermes",
  "name": "Hermes Agent",
  "command": "hermes",
  "args": ["acp"],
  "cwd": ""
}
```

For any `npx`-based agent, set **Command** to `npx` and **Arguments** to the package name + flags.

#### Add a remote/relay agent from the UI

Remote agents run on a registered node and connect through Azure Relay.

Option A — from the **Agents** panel:

1. Open **Agents** → **+** → **Add Agent from Remote Node**.
2. Choose a node.
3. Enter an agent ID, display name, and working directory on that remote machine.
4. Click **Create Remote Agent**.

Option B — from the **Nodes** panel:

1. Open **Nodes**.
2. Click the `＋` action on a node row.
3. Enter an agent ID, display name, and working directory.
4. Click **Create Relay Agent**.

Relay agents are stored with `relay: true` and `relayConnectionName` pointing at the node/hybrid connection.

#### Seed agents with `agents.json`

To seed agents without the UI, create `agents.json` at the project root before first boot:

```json
{
  "agents": [
    {
      "id": "copilot",
      "name": "GitHub Copilot CLI",
      "command": "copilot.exe",
      "args": ["--acp"],
      "cwd": "C:\\work",
      "yolo": true
    }
  ]
}
```

#### Agent fields

| Field | Description |
|-------|-------------|
| `id` | Unique agent identifier used for `@mentions` |
| `name` | Display name |
| `command` | Path to the ACP executable for local/server agents |
| `args` | Command line arguments, default commonly `["--acp"]` |
| `cwd` | Working directory for the agent process |
| `yolo` | Auto-approve mode |
| `noTools` | Disable tool calls; agent responds as chat-only, usually faster |
| `relay` | Connect via Azure Relay WebSocket instead of local process |
| `relayConnectionName` | Azure Relay hybrid connection/node name, required when `relay: true` |
| `env` | Environment variables passed to the agent process (KEY=VALUE per line in UI, JSON object in `agents.json`) |
| `public` | Allow all authenticated users to talk to this agent; default is owner-only |

### Nodes

Nodes represent remote machines that can host relay agents. A node is backed by an Azure Relay hybrid connection.

#### Add a node with the setup kit

1. Configure Azure Relay variables in `.env.local` or deployment app settings:
   - `RELAY_SEND_CONNECTION_STRING` for server-side relay connections and node probing.
   - optionally `RELAY_KEY_VAULT_NAME` and `RELAY_KEY_VAULT_SECRET_NAME`; these values are embedded into newly downloaded setup ZIPs so the remote node can fetch `RELAY_CONNECTION_STRING` from Key Vault.
   - optionally `RELAY_SUBSCRIPTION_ID` and `RELAY_RESOURCE_GROUP`; these values are embedded into newly downloaded setup ZIPs so the remote node can create/update/delete its Hybrid Connection.
   - optionally `RELAY_NAMESPACE` for auto-discovery.
   Restart or redeploy the app and download a new `copilot-node-setup.zip` after changing these environment variables.
2. Open the **Nodes** panel.
3. Click **+** to open **Node Setup Kit**.
4. Choose the launcher you want the node to run (**Copilot CLI** or **Agency**) and download `copilot-node-setup.zip`.
5. Copy/extract it on the remote devbox.
6. Open PowerShell in the extracted folder.
7. Run:

```powershell
.\setup-node.ps1
```

The kit includes `setup-node.ps1` and `relay-listener.js`. Prerequisites shown in the UI are Node.js, GitHub Copilot CLI, and Azure CLI logged in. After setup, the node appears in the **Nodes** panel automatically when discovery is configured.

#### Manage nodes

- Click **↻** in the Nodes panel to refresh node status.
- Click a node row to probe/refresh that node.
- Online nodes show a filled status dot.
- Double-click a node name to rename it when you have permission.
- Click `＋` on a node row to create a relay agent on that node.
- Click `✕` on a node row to remove a node you can modify.

## Architecture

- **Frontend**: Next.js 16 (App Router), React 19, CSS modules + styled-jsx, react-markdown.
- **Backend**: Next.js API routes managing ACP agent processes, relay WebSockets, chat persistence, file browsing, config, and auth.
- **Protocol**: NDJSON-RPC over stdio for local agents; WebSocket for relay agents.
- **Storage**: SQLite via better-sqlite3 — `.data/chats.db` for chat history and shared chats, `.data/config.db` for agent/node config.
- **Auth**: NextAuth.js with Azure AD SSO or local credentials providers.

## ACP Protocol Flow

1. **Spawn/connect** — Start a local agent process with configured command + args, or connect to a relay node via Azure Relay.
2. **Initialize** — Send `initialize` with `protocolVersion: 1`.
3. **New Session** — Send `session/new` with working directory and MCP server list.
4. **Prompt** — Send `session/prompt` with the user message.
5. **Stream** — Receive `session/update` notifications for thinking, tool execution, and response chunks.
6. **Complete** — Prompt resolves when the agent finishes; the next queued turn starts automatically.
7. **Resume** — On reconnect, send `session/load` to restore prior session context.

The backend handles server-side requests from agents, including terminal management (`terminal/create`, `terminal/output`, `terminal/wait_for_exit`, etc.) and file system access (`fs/read_text_file`, `fs/write_text_file`).

## Data Migration

If migrating from a legacy JSON-file setup:

```bash
npx tsx lib/migrate.ts
```

## Tests

Tests are Playwright E2E plus lightweight Node regression checks. Playwright expects the app running on `localhost:3010`.

The **Playwright E2E** workflow runs on every PR targeting `main` and every push to `main`.
It builds and serves the production app with isolated CI credentials, runs desktop Chromium
in four shards, and runs Android Chromium and iPhone WebKit as independent jobs. Desktop
failures do not prevent mobile coverage from running. Mobile checks cover navigation and
overlay state, sidebar collapse/reopen and desktop preference preservation across breakpoints,
narrow screens and landscape, keyboard/composer geometry, file previews,
and management panels. Failed jobs upload HTML reports, traces, screenshots, and server logs.
Do not run stateful E2E tests against a production instance or its database.

```bash
# Backend/source regression checks
node tests/session-mcp-routing.test.mjs
node tests/session-prompt-stop-reason.test.mjs
node tests/markdown-file-limit.test.mjs
npx tsx tests/chat-store-last-selection.test.ts

# Type/build checks
npx tsc --noEmit
npm run build

# Playwright E2E
NEXT_PUBLIC_E2E_TESTS=1 npm run dev
PLAYWRIGHT_BASE_URL=https://localhost:3010 NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npx playwright test --config tests/playwright.config.ts

# Single spec / single test
npx playwright test --config tests/playwright.config.ts tests/test-ui.spec.ts
npx playwright test --config tests/playwright.config.ts -g "test name"

# Mobile regression projects (set PLAYWRIGHT_BASE_URL for your test server)
npx playwright test --config tests/playwright.config.ts --project=android-chromium
npx playwright test --config tests/playwright.config.ts --project=iphone-webkit
```

## License

MIT
