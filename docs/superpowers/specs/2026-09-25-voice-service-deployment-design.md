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

## Completed execution evidence (2026-09-25)

The real service matrix passed in
https://github.com/xujxu/agents-chat/actions/runs/36141303634
at measured implementation `8f4edba2ddd6df786c3874f3f1a4c470a08206ba`.
All four jobs and the failure-inclusive aggregate passed: 14 deployment
milestones, 44 browser records and 32 real ASR-to-draft attempts, with no
browser retries or lifecycle skips. Each job removed its service/task and
confirmed the listening port closed.

| Host/scenario | Passed milestones | Browser records | Real ASR |
| --- | --- | --- | --- |
| Linux fresh-selected | selected, keep, disabled | 15 | 12 |
| Linux upgrade-enable | initial, enabled, keep, disabled | 18 | 12 |
| Windows fresh-selected | selected, keep, disabled | 5 | 4 |
| Windows upgrade-enable | initial, enabled, keep, disabled | 6 | 4 |

Linux used actual systemd on ubuntu-24.04, with listener cgroup ownership,
activation identity and request-temp inspection through the service root view.
Windows used actual S4U/AtStartup Scheduled Tasks on windows-2022 under the
runner account, with watchdog ancestry, activation identity and local
no-tunnel mode preserved across upgrade. Native manifest/role hashes and voice
configuration remained unchanged on keep; both disable paths hid the microphone.

Browsers were Chromium 147.0.7727.15 (desktop and Android descriptor),
WebKit 26.4 (iPhone descriptor) and actual Edge 154.0.4258.37.
Real login, same-origin voice POST, native candidate inference, exact API-text
append to the retained draft, no automatic chat send, recording cleanup and
idle UI assertions were reused without modifying accuracy acceptance.

### Upgrade and credential evidence boundaries

The actual entrypoints performed Git fast-forwards and re-entry against local
marker-only fixture commits. These are not application release migrations:

| Host/scenario | Enable fixture commit | Keep fixture commit |
| --- | --- | --- |
| Linux fresh-selected | measured implementation | 328f2ceb9f73ca29e7067c0839de76b40db13858 |
| Linux upgrade-enable | f77a1de9cbe5dcbe5defe8a9c53c9a9cbc3b8485 | e5fe1efafd5de1f3b51569041636719e88b29a57 |
| Windows fresh-selected | measured implementation | dc4d0f6c79fc4b6ddcbb44bde449164e6c1d084d |
| Windows upgrade-enable | 1fb7222f5bd39cb525cd9372b8a3ba8075d80b47 | 0da95d0ae1f7684e04d3b192b962be426953e298 |

Linux checked the listening process environment and unit UnsetEnvironment.
Windows checked no persisted User/Machine GitHub tokens and the watchdog's
token-removal launch path; the executable watchdog contract supplied transient
sentinel tokens and verified they were absent at child launch. This is not a
remote Windows process-environment/PEB inspection. No token was added to the
configuration or task arguments.

### Failure history and supporting runs

- Red `36139526145` at `5e90931`: missing service-contract implementation.
- `41dfef4`: Actions rejected job-level `runner.temp`; `ce268b3` moved cache
  initialization into a runner step.
- `36139992813`: Windows mode contract changed cwd into its temporary fixture,
  preventing cleanup. `4e6cea8` restored cwd; real deployments had not run.
- `36140169698`: all deployment/browser milestones passed and Linux cleaned up.
  Initial Windows cleanup failed; separate fallback cleanup succeeded.
  No raw captured driver stderr was retained, so the precise first cleanup
  exception is not established. `8f4edba` added graceful-stop/exit waiting,
  process-exit race handling and bounded sanitized driver diagnostics.
- Final `36141303634`: all four complete paths, including primary cleanup, passed.
  No failed earlier run was reclassified.

Existing setup regressions `36141303617`, Windows foundation `36141303577`
and service push contracts `36141303814` passed at the measured commit.
The earlier implementation's lifecycle UI/capture preflight `36139965174` passed.
Real deployments built the app, and the service workflow checked the reused
browser spec's strict types. A separate mock-provider API-negative suite was
not rerun; native authenticated voice requests were covered by the 32 attempts.

### Retained artifacts

All five result artifacts expire 2026-10-25. Source speech still expires
2026-10-07 and candidate packages 2026-10-24.

| Artifact | ID | SHA256 |
| --- | --- | --- |
| voice-service-report | 10867621949 | 67c41f475ec49df00775ec9c78688bc689d7050d17c00a05f37928e00a59b74e |
| voice-service-linux-fresh-selected | 10867376159 | 48dad8094d077d0f2ce68c9199860758f20e1b95f9dc4646f54fe446729fb491 |
| voice-service-linux-upgrade-enable | 10867511171 | 9c395bbefb4e845f5f492d3f78708e616e0996057f8a3d30dcec4189e7823a09 |
| voice-service-win32-fresh-selected | 10867326594 | 32fd9a4095bdb9c54c812bb2af18236d2b7657879ead26c272ee1047b274797b |
| voice-service-win32-upgrade-enable | 10867581432 | eac831cd2e0b5bfb89f2b2728e6050b0e544c68997061fee4ac80e45fb3e0aa9 |

This closes B's hosted functional service flow, not public-release approval,
all historical-version upgrades, tunnel provisioning, physical-device capture
or the paused quality gates. Experimental acquisition still needs authenticated
gh and live pinned artifacts; remote microphones still require HTTPS.
