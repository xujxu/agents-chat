# Real Service Voice Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify real service-owned voice new installation, upgrade, preservation and disablement on both platforms.

**Architecture:** Keep production entrypoints authoritative; a four-job Actions harness creates isolated Git upgrade fixtures and invokes platform drivers. Reuse voice browser assertions with per-milestone record directories. Pure contracts require service ownership, restart, installed identity and cleanup evidence.

**Tech Stack:** Node 24, PowerShell 5, Bash/systemd, Git, existing Playwright, Actions.

---

Inline execution approved by the user. Named execution subskills are unavailable;
use explicit red/green/run checkpoints here, not subagents. Every test, build,
dependency install, service activation and model download runs only in Actions.

## Files and interfaces

- `scripts/voice/service-contract.mjs`: `milestones(scenario)`,
  `validateServiceHost(host, run, commit)`, fixed expected record counts.
- `scripts/voice/service-run.mjs`: Git fixture, sequential deployment/browser
  milestones, token scope, installed hashing, failure-inclusive output.
- `scripts/voice/service-linux.mjs`: root-only manager probe/cleanup executable.
- `scripts/voice/windows/service-driver.ps1`: actual task probe/cleanup executable.
- `scripts/voice/service-report.mjs`: exact four-host aggregation.
- `scripts/voice/windows/task-mode.ps1`: standalone argument parsing and effective
  no-tunnel mode; used by real deploy and mode contracts.
- Modify deploy/task/watchdog: mode propagation; remove inherited acquisition
  tokens before app launch; repair tightly coupled process-tree parameter naming.
- `tests/voice-service.test.mjs`, `tests/voice-service-mode.ps1`: red contracts.
- `tests/voice-lifecycle.spec.ts`: optional record output root, unchanged defaults.
- `.github/workflows/voice-service.yml`: contracts and manually dispatched matrix.
- `scripts/VOICE-DEPLOYMENT.txt`: measured evidence and limits.

## Task 1: Red acceptance contracts

- [ ] Create Node contracts before implementations:

```js
import { milestones, validateServiceHost } from '../scripts/voice/service-contract.mjs';
assert.deepEqual(milestones('fresh-selected'), ['selected', 'keep', 'disabled']);
assert.deepEqual(milestones('upgrade-enable'), ['initial', 'enabled', 'keep', 'disabled']);
assert.throws(() => validateServiceHost({}, 'run', 'commit'));
```

- [ ] Add source wiring assertions and executable PowerShell contracts for
  omitted new-task/default, existing no-tunnel preservation, explicit false and
  paths containing the word NoTunnel (not switches).
- [ ] Push contracts and workflow; run in Actions:

```sh
node --test tests/voice-service.test.mjs
```

Expected missing `service-contract.mjs`; retain run ID.
- [ ] Commit with Copilot trailer.

## Task 2: Production mode propagation

- [ ] Define mode helper:

```powershell
function Get-TaskNoTunnelMode {
    param($Task, [bool]$Explicit, [bool]$Requested)
    if ($Explicit) { return $Requested }
    if (-not $Task) { return $false }
    return [bool](@($Task.Actions | Where-Object {
        $_.Arguments -match '(?i)(?:^|\s)-NoTunnel(?=\s|$)'
    }).Count)
}
```

  Quote/path handling is tested; reject unsupported ambiguous action forms
  rather than guessing.
- [ ] Add `NoTunnel` switch to deploy/task/watchdog. Determine effective mode
  from PSBoundParameters and current task; pass it at registration and validate
  it along with existing action identity.
- [ ] Watchdog adds `-NoTunnel` to child argument array only when true.
  Strip acquisition token environment variables before launching app children.
  Linux unit uses `UnsetEnvironment` for the same four token names.
- [ ] Test actual helper and mocked registration/re-entry, plus existing setup,
  scheduled-task and startup regressions in Actions. Preserve explicit/default
  behavior and existing principal. Commit.

## Task 3: Drivers and orchestration

- [ ] Platform driver interface:

```text
preflight PROJECT -> JSON confirms no service/task/port/overrides
probe PROJECT -> JSON {manager,project,identity,pid,listenerPid,owned,
                      active,activation,credentialsAbsent,temporaryDirectories}
cleanup PROJECT -> JSON {removed,portClosed}
```

  Linux runs via sudo with Node absolute path; Windows via absolute Windows
  PowerShell. Probe fails unless listener belongs to service cgroup/task
  watchdog ancestry. Inspect only allowlisted fields. Require cleanup ownership.
- [ ] Prepare isolated clone and local bare remote at measured commit using Git
  arguments, not shell interpolation. Create marker-only fixture commits with
  local `git -c user.name=... -c user.email=... commit`; push only to local remote.
  Assert actual deployed HEAD changes after upgrade, record both fixture SHAs.
- [ ] Write private disposable env, copy prepared fixed speech metadata/audio
  into fixture checkout. Initial deployment:

```sh
sudo node-path-preserving-command bash scripts/deploy.sh --no-pull --non-interactive --voice sensevoice-small-q8 --voice-experimental-download
```

```powershell
& ./scripts/deploy.ps1 -SkipGitPull -NonInteractive -NoTunnel `
  -TaskLogonType S4U -TaskTriggerType AtStartup -WaitSeconds 300 `
  -VoiceModel sensevoice-small-q8 -VoiceExperimentalDownload
```

  Upgrade-enable initial omits voice flags. Subsequent Linux uses upgrade.sh;
  Windows omits SkipGitPull. Keep omits both voice/download flags and credentials.
- [ ] Before/after probe captures restart activation and native-temp baseline in
  actual service context. Verify unchanged unrelated config/voice hashes for
  keep, disabled state after disable, package role hashes after enabled.
- [ ] Browser invocation:

```js
await runNode(['node_modules/@playwright/test/cli.js', 'test', '--config',
  'tests/playwright.voice-lifecycle.config.ts', '--workers=1', '--retries=0'],
  { LIFECYCLE_PHASE: enabled ? 'enabled' : 'initial',
    LIFECYCLE_RECORD_ROOT: `service-evidence/${milestone}/records`,
    PLAYWRIGHT_BASE_URL: baseURL });
```

  Use disabled phase for disable. No app start in harness. Tokenless browser env.
- [ ] Cleanup finally and Actions always step recheck ownership. Aggregate
  missing, stale, duplicate, cleanup-failed or skipped evidence as failure.

## Task 4: Real Actions and durable result

- [ ] Dedicated matrix ubuntu/windows times fresh-selected/upgrade-enable;
  shared step downloads speech only, installs dependencies/browsers and invokes
  harness (production deployment does its own install/build).
- [ ] Run focused mode/contracts, existing UI/API regressions and type checks.
  Dispatch:

```sh
gh workflow run voice-service.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

- [ ] Inspect failures, retain evidence, fix only this path and rerun in Actions.
  Expected exact44 browser records/32 real ASR attempts across four jobs.
- [ ] Download small summary only; retain run, commit, artifact IDs/digests/expiry.
  Commit/push result docs. Mark task outcomes accurately and stop reminder.

## Self-review

Both installation choices, real Git re-entry, preservation, disablement,
ownership, temporary namespaces, credentials and cleanup map to Tasks2-4.
Fixture commits are synthetic, separate from implementation SHA. Public release,
historical-version migrations and physical-device accuracy remain out of scope.

## Execution outcome

- [x] Task 1: red `36139526145` at `5e90931` confirmed absent implementation.
- [x] Task 2: mode forwarding/preservation, sentinel token isolation and existing
  task/start/setup regressions passed. Watchdog process-tree helper no longer
  tries to bind the read-only PowerShell PID variable.
- [x] Task 3: actual manager drivers, Git fixture upgrades, fixed browser
  milestone records, installed identity and owned cleanup implemented.
- [x] Task 4: final `36141303634` at `8f4edba` passed four jobs, 44 browser
  records, 32 real ASR attempts and primary cleanup. Artifact identities,
  synthetic fixture commits, failure history and limitations retained in spec.

The unchecked lists above retain the original implementation recipe; this
outcome records completed tasks and actual evidence. No separate mock-provider
API-negative suite was rerun; the final service flow exercised the real native
authenticated API. Spec execution notes distinguish Windows launch-boundary
token checks from direct Linux process-environment inspection.
