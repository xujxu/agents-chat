# Real service deployment voice E2E

## Scope and prior approval

The user approved A -> B: experimental candidate acquisition, then real
Linux systemd / Windows Scheduled Task new-install and upgrade E2E, including
explicit no-tunnel propagation with unchanged defaults. A passed at `02d5720`
in Actions `36106345674`; results were retained in `0c07568`.

B proves the production deployment entrypoints control the actual service
which serves browser recording, native inference and draft append. It must not
replace service operations with command mocks or start Next from a test runner.
Accuracy research remains paused. No chat sends, agent replies, permanent
package publication, physical microphones, real Safari hardware, Azure AD
changes or public tunnel authentication are included.

Use GitHub-hosted disposable ubuntu-24.04 and windows-2022 VMs. They provide
real system managers without touching shared development or production hosts.
Mock-only tests cannot close this gap; self-hosted production runners introduce
unnecessary credentials and destructive isolation risks. Existing isolated
mock regressions remain useful for error cases but are not service acceptance.

## Small production change: Windows no-tunnel deployment

`start.ps1 -NoTunnel` already builds/serves on port 3000 without a tunnel.
Expose this through `deploy.ps1`, `install-scheduled-task.ps1` and
`service-watchdog.ps1`, not a test-only start command.

For a new task, omitted `-NoTunnel` keeps the current tunnel-enabled default.
For an existing task, omitted selection preserves its installed no-tunnel mode.
Explicit `-NoTunnel` selects local mode; explicit `-NoTunnel:$false` selects
tunnel mode. Detect the standalone switch in task arguments, not a substring
that could be part of a path. Validate the effective action mode when deciding
whether task registration must be refreshed.

Preserve principal identity, logon/trigger selection and all voice parameters
across upgrade re-entry. Pass the effective mode from task registration to the
watchdog and then to `start.ps1`. Watchdog/startup never configures voice or
downloads a model. Existing foreground start remains unchanged.

`setup.ps1` currently provisions Dev Tunnel and is not a service installer.
Its existing voice flag forwarding is covered separately; this E2E uses
`deploy.ps1` as the fresh service installation and upgrade entrypoint. Do not
claim external tunnel provisioning is exercised.

Linux uses the actual `agents-chat.service` template and normal `deploy.sh` /
`upgrade.sh`. Use its actual fixed port 3010 and Windows' actual port 3000.
Do not change production ports or resource policy merely for tests.

## Isolation and prerequisites

Create four independent matrix jobs: each OS times fresh-selected or
upgrade-enable. Each job has its own checkout and VM; record measured source
commit, run ID, scenario and service identity.

Before invoking a deployment, require Actions and a GitHub-hosted runner.
Reject a preexisting target service/task, `/etc/agents-chat.env` override,
unexpected project configuration or occupied target app port. Do not stop
unrecognized existing processes to make a fixture fit.

Provide a private `.env.local` with disposable local auth credentials and
loopback NEXTAUTH_URL. No Azure, agent or tunnel credentials are needed.
Install browsers and source input in Actions; model packages must be acquired
by the actual deployment's configuration CLI using the experimental switch.

Use Linux root via sudo as the current deployment contract specifies. Windows
uses the runner account with real Scheduled Task registration and S4U/AtStartup
for noninteractive execution. Verify the registered principal, executable,
arguments and working directory. If hosted task activation is unavailable,
record a failed/blocked result; do not substitute a direct Next process or
silently change the account to LocalSystem.

## Fixed scenario matrix

Each scenario uses both fixed ASCEND samples and the existing project matrix:
Linux desktop Chromium, Android Chromium descriptor and iPhone WebKit
descriptor; Windows real Edge channel. One worker, zero test retries.

| Scenario | Milestone | Required behavior |
| --- | --- | --- |
| fresh-selected | selected | First real deployment selects experimental Sense, downloads, installs and starts the service; both samples append to the draft |
| fresh-selected | keep | Upgrade via actual entrypoint with default voice selection preserves installed voice/configuration; both samples still append |
| fresh-selected | disabled | Real deployment disables voice and restarts service; capability disabled and microphone absent |
| upgrade-enable | initial | Fresh deployment without voice selection leaves voice disabled; service responds and microphone absent |
| upgrade-enable | enabled | Actual upgrade entrypoint explicitly selects experimental Sense; download/install/restart; both samples append |
| upgrade-enable | keep | Another default upgrade preserves installed voice; both samples still append |
| upgrade-enable | disabled | Real deployment disables/restarts; capability disabled and microphone absent |

This yields exactly 44 browser records and 32 real ASR attempts across all four
jobs: fresh-selected 5 records/project, upgrade-enable 6 records/project.
Source hashes remain those in the existing lifecycle. No accuracy filtering
or new source selection. Disabled/default milestones must not require a token.

Use the existing authenticated browser/real API/capability/draft assertions,
including one POST per sample, no automatic chat send, source completion, track
and context cleanup, idle state and nonempty actual transcript. Add only a
record-root parameter to avoid collisions across milestones; keep existing
direct-CLI lifecycle output and default behavior unchanged.

## Honest upgrade evidence

Exercise real `git pull --ff-only` and script re-entry, not only `--no-pull`.
Create an isolated local bare Git fixture from the measured source checkout.
Advance its branch with a marker-only commit between deployments and assert
the deployed checkout actually fast-forwards to that commit. Use production
scripts unmodified, normal upstream tracking and real Git; record both fixture
SHAs separately from the measured implementation commit.

The marker proves upgrade/pull/re-entry plumbing while keeping package identity
and application code fixed. It is explicitly a synthetic upgrade fixture, not
proof of migration from every historical release. Existing re-entry regression
tests separately check that updated entrypoint logic is executed.
No remote branch/release is created for fixture commits.

Linux upgrades invoke `scripts/upgrade.sh`; Windows invokes `deploy.ps1`
without SkipGitPull after initial installation. Keep upgrades omit voice
selection and experimental acquisition entirely.

Record voice-key/package identity before/after keep; preserve unrelated
configuration. Verify installed manifest and all native role hashes after
enable/keep. Verify service restart using manager activation/process evidence,
not merely an already-responsive HTTP endpoint.

## Service/process evidence and cleanup

Linux evidence includes unit path, user/group, ExecStart, working directory,
active state, main PID and cgroup membership. Confirm the listening app process
belongs to the service cgroup and changes appropriately across restart.
Windows evidence includes task principal/logon/action, fresh task/watchdog
activation evidence, owned watchdog/start/app ancestry and the listening PID.
Do not accept a stale log or an unrelated process on the port as readiness.

Use try/finally and an Actions always cleanup step. Track an ownership receipt
only after this run registers its service/task. Before removing anything,
recheck project paths and recorded ownership; refuse mismatches.
Stop/remove only this run's service/task and its proven descendants, never a
name-based global kill. Require target port closed and owned resources absent
after cleanup. Cleanup errors make acceptance fail and remain in the report.
Leave unrelated runner processes and preexisting resources alone.

Record native request-temp cleanup in the actual service context. Linux
PrivateTmp differs from the runner's namespace: inspect the service process
mount namespace or root view with appropriate permissions, rather than claim
that an empty runner /tmp proves cleanup. Windows checks its actual task-user
temporary directory. Package files remain installed between milestones.

## Credential handling and failure policy

Acquisition credentials are step/process scoped, never stored in project config,
task arguments, units, recovery receipts or uploaded logs. Separate download
credential handling from server/browser environments. Inspect the effective
unit/task and application environment where supported; do not claim Windows
remote process-environment inspection without evidence. At minimum verify no
machine/user persisted GitHub token, no token in created configuration/actions,
and use a transient per-invocation sentinel to test inherited-token isolation.
If runtime isolation cannot be established, leave that acceptance item failed,
not silently passed. Erase no preexisting user authentication.

On activation failure retain sanitized stage/error and existing rollback outcome.
Do not weaken readiness, remove safety checks, add runtime resource caps,
retry individual successful samples or fall back to mocked services.
Changes to production recovery behavior are limited to bugs demonstrably
blocking this approved service path and require focused regressions.

No raw env dumps or private server/auth logs in public artifacts. Retain
structured allowlisted service/process metadata, phase outcomes, screenshots,
existing voice records and a failure-inclusive aggregate report.

## Actions-only implementation and acceptance

First add failing contracts for mode forwarding/preservation, fixed scenario
counts, stale/missing service evidence, mismatched commits/packages and cleanup.
Run them in Actions, implement minimal changes and run existing Windows
task/start/setup regressions plus build/type checks and voice UI/API coverage
appropriate to touched behavior. Tests and inference never run locally.

Add a dedicated manually dispatched service-deployment workflow and focused
platform drivers. Common orchestration/evidence helpers live under
`scripts/voice/`; avoid expanding the existing direct-server lifecycle runner
into a service framework. Share pure assertions and browser spec instead.

Aggregate all four jobs; missing/duplicate milestones, lifecycle skips,
incorrect counts, wrong service ownership, cleanup failures or failed records
produce a nonzero report. Do not calculate CER/MER or latency qualification.
Persist run URL, measured source commit, fixture commits, artifact IDs/digests/
expiry and actual browser/OS versions in the deployment ledger.

B is complete only when the real service matrix passes and evidence is
committed/pushed. Linux/Windows Server CI is not physical Win11/mobile Safari
acceptance; loopback microphones do not establish remote HTTPS readiness.
Expired candidate/source artifacts remain explicit external blockers.
