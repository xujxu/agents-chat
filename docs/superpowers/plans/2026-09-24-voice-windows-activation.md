# Windows Voice Activation and Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect verified Windows packages and private configuration transactions to explicit configuration and interactive installation/upgrades without changing task identity or prompting from startup.

**Architecture:** Keep byte transactions in the existing ESM helper. Resolve the intended Windows service SID and inspect registry voice overrides before writes; grant that SID read access to environment files, not recovery receipts. PowerShell setup/deploy share a focused configuration wrapper, while startup only performs encoding-safe URL updates. Deploy re-enters updated code after pull and rolls back failed activation using the existing guarded receipt.

**Tech Stack:** Node ESM, Windows PowerShell 5.1/.NET, existing Scheduled Tasks, node:test/tsx and Actions.

---

## Approved boundaries

Continue inline, no subagents. Parent spec already approved. Preserve current
task principal, ports/tunnels, unattended keep, Linux legacy behavior and public
release gates. No model downloads outside Actions. Windows Server evidence is
not actual Win11 qualification.

Only inspect the specified service account; never change it to make voice work.
If its registry hive is unavailable, refuse explicit changes with actionable
guidance rather than guessing its environment. No registry writes/hive loading.
Fresh tasks default to the installer account, not a repository author's account.
Keep must not require service-account probing or rewrite configuration.

## File map

| Path | Change |
| --- | --- |
| `scripts/voice/windows/setup-context.ps1` | Resolve current/target SID; read target-user, volatile and machine VOICE overrides |
| `scripts/voice/windows/setup-context.mjs` | Bounded sanitized PowerShell probe, validated result and conflict checking |
| `scripts/voice/configuration-files.mjs` | Optional target read SID for environment writes |
| `scripts/voice/windows/private-directory.ps1` | Inheritable read/execute grant for explicit target SID |
| `scripts/configure-voice.mjs` | Windows importer selection, service context, receipt identity and rollback |
| `scripts/voice/windows/environment-url.mjs` | Preserve Unicode voice paths when startup/setup update NEXTAUTH_URL |
| `scripts/voice/windows/configure.ps1` | Shared interactive/default-keep invocation and recovery wrapper |
| `scripts/setup.ps1`, `scripts/deploy.ps1` | Invoke voice before activation; deploy re-entry, guarded failure recovery |
| `scripts/start.ps1` | Use safe URL writer, never voice selection |
| `scripts/install-scheduled-task.ps1` | Current-account fresh default; preserve existing principal from deploy |
| `scripts/package-release.mjs` | Bundle instructions for native Windows verified imports |
| `tests/voice-setup-activation.test.mjs` | Context conflicts, URL preservation, Windows CLI failures/permissions and PowerShell wrapper |
| `tests/voice-windows-import.test.ts` | Real package through CLI-persisted configuration and rollback |
| `.github/workflows/voice-setup.yml` | Cross-platform contracts and PowerShell deployment harness |
| `.github/workflows/voice-windows-packages.yml` | Actual model configuration and installed transcription |

## Task 1: Failing activation contracts

- [ ] Add pure conflict checks (Windows environment keys are case-insensitive):

```js
assert.throws(() => assertWindowsOverrides(
  { machine: { voice_enabled: '1' }, user: {}, volatile: {} }, 'disabled'), /machine/);
assert.doesNotThrow(() => assertWindowsOverrides(
  { machine: {}, user: { VOICE_ENABLED: '0' }, volatile: {} }, 'disabled'));
assert.throws(() => assertWindowsOverrides(
  { machine: {}, user: { VOICE_MODEL_PATH: 'old' }, volatile: {} }, 'sensevoice-small-q8'), /user/);
```

- [ ] Test URL updates against UTF8, BOM and UTF16LE inputs. Preserve all voice
  path values, reject invalid URL/newline input without replacing config, and do
  not rewrite already matching URL bytes. Run the real CLI with bad Windows
  package hash and require unchanged config/no receipt. Keep with a nonexistent
  service identity must remain a no-op.

- [ ] Push tests; inspect `voice-setup.yml` red failure for missing module. No
  local validation. Commit test-first and implementation separately.

## Task 2: Service context and persisted native activation

- [ ] Export:

```js
export function assertWindowsOverrides(context, model);
export async function windowsSetupContext(serviceUser);
```

  Invoke the .NET-only PowerShell script with a ten-second timeout and bounded
  stdout; use SystemRoot absolute executable and no application secrets.
  Resolve SID or NTAccount through Windows security APIs. Return currentSid,
  serviceSid, machine/user/volatile dictionaries. Read-only registry handles
  must be disposed. Different account requires a loaded HKEY_USERS SID root.
  Registry values are never printed in errors/logs. Reject malformed results.

- [ ] Add `--service-user` to configure CLI; reject it on non-Windows. Keep
  returns before account probing. Explicit changes probe account/overrides
  before model execution, then select importer:

```js
const importer = process.platform === 'win32'
  ? importWindowsVoicePackage : installVoicePackage;
```

  Save target SID in the private receipt. Write environment with optional target
  read SID; receipts remain private to installer/admin/SYSTEM. Rollback uses the
  saved SID, exact-byte checksum and original snapshot; do not expand access to
  Everyone/Users. Grant read/execute only if SID differs from existing full grants.

- [ ] Through the existing real-model import test, call configure CLI with the
  candidate hash, read persisted environment using the shared decoder/parser,
  transcribe JFK via application configuration and restore previous raw bytes.
  Test disable removes launcher/model keys. No fixture may replace real model
  evidence.

## Task 3: Startup encoding and shared PowerShell menu

- [ ] URL helper takes exactly environment file and URL arguments, requires
  http(s), refuses controls/expansion characters, and edits only NEXTAUTH_URL:

```js
const original = await optionalRead(file);
if (original === null) throw new Error('Environment file is missing.');
const lines = decodeEnvironment(original).split(/\r?\n/);
```

  If matching active URL already exists once, leave raw bytes untouched.
  Otherwise rewrite matching/commented URL entries or append one, preserving
  all other text, then use checked private atomic write. Called under service
  identity at startup, so default ACL belongs to that identity. No menu, package
  lookup or model activation occurs here. Use strict UTF8/.NET BOM detection in
  PowerShell readers.

- [ ] Shared PowerShell function takes ProjectDir, Model, PackageDir,
  ManifestSha256, Threads, ServiceUser, Receipt, NonInteractive. If no explicit
  model and interactive console, display keep/Sense/Whisper/disabled every time:

```powershell
$answer = Read-Host 'Voice setup [1]'
$selection = switch ($answer.Trim()) {
    '' { 'keep' }; '1' { 'keep' }; '2' { 'sensevoice-small-q8' }
    '3' { 'whisper-base-q5_1' }; '4' { 'disabled' }
    default { throw 'Invalid voice selection.' }
}
```

  EOF preserves, interrupt aborts before activation. Explicit flags are forwarded
  as an argument array, not shell strings. Node is always passed
  `--non-interactive` because the wrapper owns this menu. Missing trusted package
  arguments fail rather than inventing a download.

## Task 4: Setup/deploy/standalone wiring

- [ ] Setup calls wrapper after its environment URL update and before completion.
  Add explicit VoiceModel/VoicePackageDir/VoiceManifestSha256/VoiceThreads and
  NonInteractive flags. Unattended voice defaults keep; this does not promise
  existing non-voice tunnel setup becomes fully unattended.

- [ ] Deploy reads existing task principal without changing it. After a
  successful pull, re-enter the new script using bound parameters and SkipGitPull:

```powershell
$resume = @{}; foreach ($key in $PSBoundParameters.Keys) { $resume[$key] = $PSBoundParameters[$key] }
$resume['SkipGitPull'] = $true
& (Join-Path $ProjectDir 'scripts\deploy.ps1') @resume
exit $LASTEXITCODE
```

  Configure before stopping task. Task re-registration forwards original UserId;
  fresh task uses current identity. Wrap activation in try/catch, remove the
  private receipt on success. On failure, guarded rollback restores config,
  attempts normal task restart, reports original failure and retains receipt if
  recovery fails. Do not claim recovery succeeded merely because restart was
  requested. NoWait cannot accompany a changed voice config because it bypasses
  health-gated activation; detect before stopping the old task.

- [ ] Standalone bundle keeps no-prompt startup and includes all ESM/PowerShell
  helpers. Document explicit reconfiguration after replacement. Old pre-feature
  deploy cannot gain new code while already running: document pull then invoke
  the new entry point as the first-migration bootstrap.

## Task 5: Actions evidence and handoff

- [ ] Run pure/CLI cases on Linux and Windows. Add an isolated PowerShell harness
  with fake Scheduled Task/network/npm operations, but actual configurator and
  files. Check keep/default, disable, repeated prompts, account preservation,
  health failure rollback, changed-config refusal, no startup prompts and re-entry.
  No production task/network/process operations are allowed in that harness.

- [ ] Dispatch real Windows candidates and Linux package regression:

```bash
gh workflow run voice-windows-packages.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
gh workflow run voice-setup.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

- [ ] Update spec/ledger with exact commit/run IDs and limitations. Actual Win11,
  installed full-corpus/API acceptance and permanent licensed public packages
  remain gates even when setup/deploy contracts are green.
