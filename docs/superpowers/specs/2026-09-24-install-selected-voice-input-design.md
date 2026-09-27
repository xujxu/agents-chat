# Install-selected local voice input on Linux and Windows 11

## Status and authority

### Current functional scope and deferred release (2026-09-26)

The subsequent user-approved functional scope is complete on hosted Linux and
Windows Server: optional installation, upgrades/keep/disable, actual
systemd/Scheduled Task lifecycle, and browser recording through real local ASR
into the existing draft. Actions `36141303634` at `8f4edba` passed four service
scenarios, 44 browser records and 32 real ASR attempts. No message is sent.
Explicit pinned experimental acquisition also passed (`36106345674`); candidates
expire on 2026-10-24 and are not permanent public downloads.

The user paused accuracy research and, on 2026-09-26, stopped licensing review
and deferred Windows voice package public distribution. The unresolved Windows
static-runtime redistribution question remains unconfirmed. No component
replacement or public package publication is authorized. Historical failed
quality gates below remain failures; real Windows 11, physical microphones and
real Safari/iOS/Android remain outside the hosted functional evidence.

The following checkpoints preserve the evolving implementation history. Their
earlier statements about missing installation/download support are superseded
by this current functional checkpoint, not by a claim of full product acceptance.

This document consolidates the previously approved voice-input design and adds
the Windows 11 scope requested on 2026-09-24. The user selected **native Windows
11 on Intel/AMD x64** as the initial Windows target; ARM64 is outside this slice.
The user approved the written design after commit `98e06ce`. Windows runtime
integration and verified real-model package import are now implemented.
Private configuration/rollback, explicit Windows candidate activation and
installation/upgrade integration are implemented with Windows Server Actions
coverage. Installed Linux Sense now passes frozen100 authenticated direct-WAV
API gates. Windows Server Sense fails one accuracy gate; Whisper fails quality
and latency on both platforms. Controlled Chromium frozen100 browser capture
now passes on Linux and Windows Server, without superseding the Windows direct
quality failure. The subsequent Edge/WebKit measurement is complete: Edge's
browser path passes, but mobile-emulated WebKit fails mixed/medium accuracy;
the Windows direct control also has one transport failure. Overall acceptance
still fails. Actual Win11, physical microphones, real Safari/iOS/Android and
final release acceptance remain pending.

The feature's earlier design decisions and experiments were recorded in
`scripts/VOICE-DEPLOYMENT.txt` rather than this repository's normal specification
directory. That was a documentation omission. This specification is now the
product design reference; the script-side documents remain historical evidence.
Do not rewrite old experiment failures as successes or treat this retrospective
document as proof that Windows code or final acceptance already exists.

As of commit `14c7f47`:

| Surface | Actual state |
| --- | --- |
| Browser recording, authenticated API, provider configuration | Implemented; Linux Actions coverage |
| Sense GGUF and Whisper native adapters | Linux implementation; fixture regressions and real API smoke passed |
| Interactive setup, upgrade preservation, disable, verified package import, rollback | Linux foundation implemented and verified |
| Portable native packages | Linux candidate artifacts, not public release-approved packages |
| Windows native execution, model installation and upgrade integration | Not implemented; currently rejected or reported unsupported |
| Automatic trusted public downloads | Not implemented; explicit local package and trusted manifest hash required |
| Full acceptance of final platform-specific installed packages | Pending |

The Linux-only restriction above describes that historical implementation, not the final
feature scope. Windows 11 support is required for completing this feature.

### Subsequent Edge and mobile WebKit measurement checkpoint

Actions
[`36085430283`](https://github.com/xujxu/agents-chat/actions/runs/36085430283),
code `7b680acb264b466868cff05a6f8dd9b40d856dcc`, reused existing mobile settings
and voice regressions, adding installed-model corpus evidence rather than
claiming previously missing iPhone E2E coverage. Both target compatibility jobs,
14Python contracts and installed collectors passed;400attempts produced
399deliveries, including200/200browser deliveries. All200same-upload ONNX
diagnostics completed. The aggregate deliberately fails measured gates.

WindowsServer2022 actual Edge154.0.4258.37 browser path passes: short/long P95
0.680/3.404seconds, mixed/medium14.6667%. Its direct control delivers99/100:
`test-01049` has a transport error of unresolved cause; failure-inclusive
mixed/medium26.6667% exceeds the16.6667%ceiling.
Linux WebKit26.4 with the existing iPhone14ProMax descriptor delivers100/100
and has short/long P95 of0.497/1.705seconds, but mixed/medium17.3333% fails
the same ceiling. Linux direct remains passing. No selective retries or gate
changes were made. Earlier Chromium/Windows findings remain intact.

Artifacts10844652395(Edge),10844047138(WebKit),10844915649(baseline) and
10845090269(report) expire2026-10-25. Report digest:
`sha256:5dc240fda7861a20ce471c7746bf9cf22337cbc220222af0c83070b6b945acea`.
Full evidence and fixture-only adaptations:
`2026-09-25-voice-browser-matrix-design.md`.
WebKit simulation is not real Safari/iPhone qualification, Server is not Win11,
and same-upload diagnostics cannot override original-stimulus quality gates.

### Subsequent process-foundation checkpoint

Implementation `684cc30` adds the standalone Windows Job launcher, not Windows
voice availability. Actions
[`35972552477`](https://github.com/xujxu/agents-chat/actions/runs/35972552477)
passed the native lifecycle contracts on Windows Server 2022; artifact
`10796434034` retains binaries and provenance. At that checkpoint the application
still rejected Windows configuration; the next checkpoint supersedes that
restriction, not the pending real-model and Win11 acceptance gates.

### Subsequent runtime-integration checkpoint

Implementation `852fcc1` supports explicit Windows x64 native configuration,
the matching `VOICE_LAUNCHER_PATH`, lifecycle-only Job supervision, a sanitized
engine environment, private ACL request directories and bounded handle-based
Whisper result reads. Legacy Linux configurations retain their existing policy.

Windows Server 2022 Actions
[`35975644625`](https://github.com/xujxu/agents-chat/actions/runs/35975644625)
passed native lifecycle/runtime, build/typecheck and authenticated fixture
API/browser coverage. Artifact `10797918486` contains helpers, synthetic engines
and provenance, **not an installable speech model**.
Linux Actions
[`35974609962`](https://github.com/xujxu/agents-chat/actions/runs/35974609962)
passed the shared runtime's regressions and real pinned Sense API smoke.

Windows installation remains unsupported until compatible real packages,
dependency/license review and setup/deploy integration are completed.
Synthetic fixture results do not measure Windows speech accuracy/latency and
Windows Server is not an actual Win11 acceptance environment.

### Subsequent real Windows candidate checkpoint

Actions
[`35977946646`](https://github.com/xujxu/agents-chat/actions/runs/35977946646),
commit `37f6612`, built the pinned real Sense GGUF q8 and Whisper base-q5_1
engines on Windows Server 2022 x64. Both passed the application's transcriber
with the JFK sample at 1/2/4 threads from paths containing spaces and Chinese
characters. The engine manifest explicitly enables UTF-8; dependency inspection
found only approved system DLLs, with static MSVC runtime/ggml.

Artifacts `10799057231` (Sense) and `10799410956` (Whisper) contain real weights,
engine, helper, notices, provenance and a checksummed **candidate inventory**.
They are not installer-admitted manifests or public release packages.
The successful smoke closes the native-build/Unicode-path uncertainty, not
full-corpus quality/latency, installation/rollback, real Win11 or release approval.
No new recommendation is granted to compatibility Whisper.

Public distribution additionally requires explicit permission review for the
application-owned helper: no root application LICENSE was found in this
checkout. Retained upstream notices and Microsoft runtime documentation do not
resolve that separate obligation.

### Subsequent verified Windows import checkpoint

Implementation `1bc1299` adds Windows version 2 import manifests, verifies all
staged files before executing the included helper, and rejects incompatible
CPU/OS instruction support. The baseline-x64 helper reports physical memory,
logical CPUs, current-group affinity and Job membership without applying quotas.
Effective nested Job limits remain explicitly unknown.

Actions
[`35981880883`](https://github.com/xujxu/agents-chat/actions/runs/35981880883)
passed both real models' candidate and installed-import transcription contracts,
including Unicode paths, wrong manifest hash, truncated/same-size-corrupted and
symlink helpers, idempotence, tampered installed binaries and unchanged config.
Artifacts `10800701498` (Sense) and `10800204124` (Whisper) contain the new manifests
and matching host-probe helper; they expire on 2026-10-24 and are not permanent
downloads or release-approved packages.
Windows lifecycle/runtime regression `35981880643` also passed.
Linux setup `35981511559` at shared-schema implementation `0637dbc` passed all
eight contracts and both existing-package integrity jobs.

The importer only returns checked paths. It does not write configuration,
receipts or service settings, and the configuration CLI still gates Windows
enablement. Private configuration transactions, upgrade menus, actual Win11 and
full-corpus acceptance remain separate work. This supersedes the earlier
candidate-only inventory limitation, not the release or installation gates.

### Subsequent private configuration checkpoint

Implementation `fd80b9a`, Actions
[`35984193290`](https://github.com/xujxu/agents-chat/actions/runs/35984193290),
passes Windows configuration file/CLI and Linux installation regressions.
Keep and rollback preserve exact UTF8, UTF8-BOM and UTF16LE-BOM bytes. New receipts
store versioned base64 snapshots; legacy UTF8 receipts remain readable.
Concurrent edits, invalid snapshots and receipt/config path collisions fail
explicitly. Windows paths serialize with forward slashes and the launcher key
is removed when disabling or switching away.

Before writing secrets, Windows PowerShell 5.1/.NET creates an NTFS staging
directory with a private inheritable DACL. Only installer identity, SYSTEM and
Administrators receive grants; final environment and receipt ACLs are checked in
CI after same-volume rename. Directory/reparse targets are refused. No secrets
are supplied to the PowerShell child. Linux retains private mode 0600 files.

This is the file-transaction prerequisite, not Windows installation completion.
The CLI still rejects Windows model enablement. Deployment/task-account checks,
startup-script encoding preservation, upgrade prompts and activation rollback
remain to be integrated. CI is Windows Server 2022, not actual Windows 11.

### Subsequent Windows activation and upgrade checkpoint

Implementation `ccdc8b6` connects the verified Windows importer to the CLI and
checks current/target service identity plus machine/user/volatile voice
overrides. Keep remains a no-op without probing another account. Explicit changes
require the target registry hive to be loaded. Private environment writes grant
the target SID read access; recovery receipts remain restricted to the installer,
SYSTEM and administrators. Startup URL edits preserve existing DACLs and Unicode
voice paths without presenting a menu.

Windows setup/deploy now offer voice configuration on interactive invocation;
unattended upgrades preserve settings unless explicitly changed. Deploy re-enters
new code after pull, preserves the existing task principal, defaults new tasks to
the installing account, and attempts guarded configuration rollback/restart on
activation failure. Administrator edits cause rollback refusal and retain the
private receipt. Changed voice settings require readiness checks, not `-NoWait`.

Actions `35986352588` at setup fix `4d69789` passed Windows configuration and
isolated setup/deploy tests, PowerShell 5.1 parsing, Linux regressions and both
Linux real-package integrity jobs. Real Windows model run `35985984916` at
`ccdc8b6` passed both CLI-persisted model transcriptions and rollback.
Runtime run `35985987964` passed lifecycle, build/typecheck and fixture API/browser
coverage; artifact `10802337585` retains that evidence.
Final real-package run `35987278609` at `86fa671` additionally checks wrong
manifest hashes through the CLI, preserving configuration without creating an
activation receipt. Both models pass; final candidate artifacts are
`10802394350` (Sense) and `10803120161` (Whisper), expiring 2026-10-24.

The deployment harness mocks Scheduled Task/network/npm operations; actual
Win11 task execution and full installed-service corpus acceptance remain open.
This supersedes the earlier Windows CLI gate, not the requirements for trusted
explicit packages, redistribution approval or permanent downloads.

### Subsequent installed-package API checkpoint

Actions
[`35991326454`](https://github.com/xujxu/agents-chat/actions/runs/35991326454)
at `0cd5ae21377d3e7845f93f6b4a56c3709ff3eb98` used the existing verified packages,
the real configurator and persisted configuration, then authenticated API
requests for the same frozen 60 ASCEND and 40 AISHELL-4 samples. All four cells
delivered 100/100 nonempty transcripts. Build/typecheck and collection completed;
the overall red result reflects measured gates, not failed infrastructure.

| Installed package | Short HTTP P95 | Long HTTP P95 | Frozen gates | Evidence artifact |
| --- | ---: | ---: | --- | --- |
| Linux Sense, 2 threads | 0.400 s | 2.284 s | Pass | `10804222694` |
| Windows Server Sense, 2 threads | 0.875 s | 4.287 s | Mixed/medium quality fails | `10803903893` |
| Linux Whisper, 1 thread | 6.949 s | 9.826 s | Seven quality groups and both latency gates fail | `10804772932` |
| Windows Server Whisper, 1 thread | 7.366 s | 13.384 s | Seven quality groups and both latency gates fail | `10804813131` |

Short means <=5 seconds of audio, long >=15 seconds; unchanged aggregate P95
ceilings are 3 and 5 seconds respectively. Medium latency is reported without
a new threshold. Every language/duration group's error must remain no more than
2 percentage points above the original identical-input Sense ONNX baseline.
Windows Sense mixed/medium error is 16.89% versus baseline 14.67% (ceiling
16.67%); Linux is 16.44%. The preceding run `35990621467` had the same qualification
outcomes. Do not round this failure into a pass or tune against this explored
test set. The source of cross-platform output differences is not established.

These are hosted-runner measurements: 4 logical CPUs, approximately 16 GiB
reported physical RAM, fresh native process per request with potentially warm
file cache. Final Linux Sense used AMD EPYC 9V74, Linux Whisper EPYC 7763, and both
Windows cells Intel Xeon Platinum 8573C. They are not a matched-hardware OS speed
comparison or a minimum-resource prescription. Effective host quotas, physical
core counts and native peak RSS were not measured. API processing time is
reported separately from HTTP time, not substituted for the acceptance metric.

The artifacts expire 2026-10-24. They contain evidence, not permanent model
downloads. This checkpoint does not qualify browser recording/resampling,
physical microphones, actual Windows 11 or real Scheduled Task execution.
No registered self-hosted runner was available when checked on 2026-09-24.
Windows quality qualification, browser-corpus acceptance, actual Win11 testing,
helper/MSVC redistribution clearance and permanent downloads remain open.

### Subsequent installed Sense consistency checkpoint

Actions `35996836383` at `6f55377` completed 648 diagnostic attempts over twelve
fixed samples, 1/2/4 threads, three repetitions and native/transcriber/API
surfaces. All attempts delivered. Within each platform, outputs matched across
repeats, surfaces and threads, and default-thread API outputs matched the prior
run. Exactly two samples differed consistently across platforms (54 of324 matched
tuples), already at supervised native stdout.

This narrows the observed difference below HTTP/text composition; it does not
isolate compiler, OS, CPU or numerical causes. Windows ran on AMD in this run
and matched its earlier Intel outputs. There is no evidence here for changing
default threads, and Windows's accuracy gate remains failed.
See [the diagnostic specification](2026-09-24-voice-sense-consistency-design.md)
for exact comparisons, artifact identities and causal limits. No product
runtime code, model, threshold or release recommendation changed.

### Subsequent feature-exchange and installed-browser checkpoints

Feature exchange36001871106 at a07d091 completed216/216 attempts with all
repetition, historical and own-feature controls passing. Decoded PCM matches;
the two differing transcripts follow frontend feature values on either unchanged
consumer. This localizes sufficient input differences without identifying a
compiler/math defect or qualifying a replacement.
See `2026-09-24-voice-feature-exchange-design.md`.

Installed browser run36007108166 at97977de completed400/400paired API deliveries
and200/200same-upload ONNX baseline diagnostics. Both controlled Chromium browser
paths pass original-stimulus frozen quality/delivery/latency gates:
Linux stop-to-composer P95 short/long0.3462/1.7280s;
WindowsServer0.8443/4.3443s. Linux direct control also passes.
Windows direct mixed/medium remains16.8889% against16.6667%ceiling, so the
aggregate deliberately fails. Browser capture changes input bytes and does not
erase that direct-input defect in qualification. No model/threshold was tuned.
See `2026-09-24-voice-installed-browser-design.md` for artifact identities,
timing definitions, same-byte diagnostic scope and remaining realWin11/physical
microphone/other-browser/release gates.

## Goal

Let an administrator choose a local speech-to-text model when installing or
upgrading Agents Chat, and let authenticated users dictate into the composer.
The application must work natively on supported Linux x64 and Windows 11 x64
hosts, without a cloud transcription account, GPU, WSL, Docker, or additional
always-running model service as a prerequisite.

Model selection is deployment-wide. The browser speaks to one stable voice API,
not directly to a model executable. Installing voice is optional.

## Scope and non-goals

Include recording, bounded upload, transcription, cancellation, capability
discovery, installation/reconfiguration, upgrades, package integrity, licensing,
platform compatibility and truthful resource guidance.

Do not add per-chat model switching, automatic sending, streaming transcription,
speaker diarization, model fine-tuning, cloud fallback, arbitrary executable
downloads, multi-worker shared admission, or a permanently resident model.
Windows ARM64, native macOS packages and GPU profiles require separate work.
Windows Server CI evidence is useful but is not itself Windows 11 acceptance.

The local `cpg` workaround only concerns this development machine's Copilot CLI.
It is not a product dependency or a resource policy for other installations.
No change here authorizes deployment to PROD or alteration of that workaround.

## User-visible behavior

The microphone button appears only when the authenticated capability response
enables voice and the browser has the required capture APIs. Initial capability
state is unavailable, so no microphone-button flash precedes the response.

Choosing not to install voice, or explicitly disabling it during an upgrade,
persists `VOICE_ENABLED=0`. After configuration activation and page reload:

- The microphone control is absent, not greyed out.
- There is no missing-model or voice-error banner for intentional opt-out.
- No model process is started and no microphone permission is requested.
- Text entry, attachments and normal chat submission remain unchanged.

A separate explicit configuration failure may show an error; it must not be
silently presented as either working voice or intentional opt-out.

Recording requires HTTPS or localhost and microphone permission. It stops at
30 seconds. The browser produces 16 kHz mono 16-bit WAV, at most 960,044 bytes,
without FFmpeg. Transcribed text appends to the latest draft without replacing
edits or sending automatically. Cancellation, chat/account changes and existing
background/unmount behavior discard stale results.

Windows 11 users can access a Windows-hosted or Linux-hosted application using
supported browsers. Host runtime support and browser capture support are
different acceptance dimensions.

## Model catalogue and qualification

An installation identity is **model revision + quantization + engine build +
platform + execution settings**, not merely a model brand.

| Choice | Product role | Permission and qualification boundary |
| --- | --- | --- |
| Official SenseVoiceSmall GGUF q8 | First recommended integration candidate | Exact official weights declare Apache-2.0; pinned FunASR/llama.cpp code uses MIT. Linux engine and installed direct-API gates passed; Windows accuracy and final browser/release qualification remain open |
| Whisper base-q5_1 | Explicit compatibility option, not a quality/latency recommendation | MIT weights/code plus applicable runtime/dependency obligations; retain known gate failures |
| Disabled | Default for an unconfigured fresh installation | No model install, inference or microphone control |

FunASR-Nano U8U8, Qwen3-ASR 0.6B INT8 and other screened Whisper variants remain
outside the approved first catalogue because of measured failures or incomplete
qualification. The original SenseVoice ONNX permission question is not resolved
by the separate official GGUF declaration. Do not silently substitute weights.

The two native model identities are Windows build targets, not pre-approved
Windows options. A Windows package appears as enabled/installable only after its
required compatibility and lifecycle checks pass. Quality status stays visible.

Installation shows model/runtime license, artifact size, CPU architecture and
instruction requirements, thread setting, measured memory/latency and acceptance
status. Linux measurements are labelled Linux observations, not invented Windows
minimum requirements. Unknown measurements remain unknown.

## Architecture and ownership

Keep `app/page.tsx` and `ChatPageClient.tsx` as composition shells.

| Area | Responsibility |
| --- | --- |
| `app/features/composer/voice/` | Capture, capability state, controls, cancellation and draft behavior |
| `app/api/voice/route.ts` | Authenticate; validate origin, account, request and WAV; call focused helpers |
| `lib/voice/configuration.ts` | Typed catalogue, environment precedence, platform/config validation and safe capability metadata |
| `lib/voice/providers.ts` | Model-specific arguments and bounded strict UTF-8 result interpretation |
| `lib/voice/transcriber.ts` | Request temporary files, execution, deadline, result and cleanup |
| New focused `lib/voice/process.ts` | Platform launch/termination contract; isolate POSIX and Windows mechanics from model parsing |
| `lib/voice/jobs.ts` | One global active job per app process, early cancellation and deadline |
| `lib/voice/memory.ts` | Existing opt-in legacy Linux memory policy; not a Windows resource detector |
| `scripts/voice/` and `configure-voice.mjs` | Catalogue presentation, compatible package import, configuration transaction and rollback |
| Platform deployment/setup scripts | Invoke configurator at installation/upgrade, activate and recover |
| Actions workflows | Build pinned platform artifacts, retain notices and qualify actual installed behavior |

Reuse existing helpers where possible. Platform detection belongs in focused
helpers, not scattered `win32` conditionals through API or browser code.
Use named exports and explicit TypeScript boundary types. No new UI styling
framework or unrelated architecture rewrite is required.

### Request flow and protocol

1. Authenticated `GET /api/voice` reports `enabled`, `model`, `provider`, `threads`,
   `resourcePolicy` and `maxSeconds`. Disabled model/provider fields are null.
   Filesystem paths and raw configuration never appear in this response.
2. `POST` checks auth, origin/account ownership, request identity, content type,
   size and WAV structure, then reserves the single inference slot.
3. Write audio into a private request directory and launch the selected provider.
4. Read a bounded transcript, return text and timing, then remove temporary files.
5. `DELETE`, disconnection or deadline terminates the owned task and descendants.
   Release admission only after teardown; do not allow stale work to overlap the
   next request. Existing early-cancel semantics remain intact.

Sense uses its native CPU arguments and stdout. Whisper uses its established
arguments and text output file. Results must be nonempty, at most 32 KiB and valid
UTF-8 without NUL characters. Nonzero exit, missing output, invalid encoding or
oversized output is an explicit failure, not a successful empty transcript.

## Configuration and resource policy

Retain the shared environment contract:

```env
VOICE_ENABLED=1
VOICE_MODEL=sensevoice-small-q8
VOICE_BINARY_PATH=/absolute/path/to/platform-engine
VOICE_MODEL_PATH=/absolute/path/to/model
VOICE_THREADS=2
VOICE_RESOURCE_POLICY=standard
```

Paths above illustrate Linux syntax. Windows requires an absolute local Windows
path and a matching Windows executable, not a Linux path or WSL translation.

Explicit model configuration defaults to **standard**: ordinary on-demand native
processes with thread control, one active request, 120-second deadline, bounded
output and cancellation. There is no additional application CPU/RAM hard quota.
Existing OS/container/Job limits are respected and never escaped.
The pinned Sense thread adaptation currently accepts 1, 2 and 4; expose only
supported values. Defaults remain two threads for Sense and one for Whisper.

Existing Linux Whisper configurations without `VOICE_MODEL` retain
`legacy-low-memory`: one thread, historical 1 GiB address-space cap, 384 MiB
sampled peak RSS watchdog and existing host-headroom admission. This is migration
compatibility, not the new-install default. Reject that Linux-specific policy
on Windows rather than silently dropping its promised protections.
Windows had no previously supported voice deployment to migrate to that policy.

Installation checks compatibility, free staging disk and available resource
observations. Distinguish CPU affinity, logical CPU count, actual hard quota,
physical RAM and remaining constrained memory. An install-time observation is
not a resource reservation or guarantee about a differently configured service.
Use Windows-native resource APIs on Windows; never require `/proc` or assume
Node's host-wide memory figure represents every enclosing Job limit.

The measured 2 CPU/4 GiB Linux allocation is neither a compulsory cap nor a proven
minimum. Warn about low resources using clearly labelled guidance; reject only
known incompatibility, invalid configuration or unsatisfied package requirements.
Hard quotas are optional deployment policy, not required feature infrastructure.

## Native Windows 11 execution design

### Alternatives and selected direction

1. **Native Windows x64 engine and shared app/API**: recommended; fits the existing
   Windows deployment and standalone ZIP without requiring another OS layer.
2. WSL-hosted Linux engine: reuses artifacts but adds installation, filesystem
   and lifecycle complexity; not the Windows support definition for this feature.
3. Separate model service/container: potentially useful for later resident-model
   deployments, but introduces another service and changes measured behavior.

Do not make either alternative a hidden fallback when native execution fails.

### Platform process adapter

POSIX execution keeps its current process-group ownership, niceness and core-dump
handling. Windows must not attempt to run `nice`, `prlimit`, `kill(-pid)` or use
`X_OK` as proof that a native executable can load.

Use an owned Windows Job Object for task **lifecycle**, with kill-on-job-close,
not CPU-rate or memory-limit settings. A small audited native launcher is the
proposed implementation boundary, avoiding a global Node native-addon dependency.
It is a shipped executable, not a permanently running service.

The launcher creates the engine suspended with atomic Job assignment through
`PROC_THREAD_ATTRIBUTE_JOB_LIST`, then resumes it. Do not leave a
create-then-assign interval in which launcher death can orphan a suspended child.
If assignment or initialization fails, terminate any created child and
report an explicit failure. Never continue with an unowned process tree.
The Job must cover descendants and close on normal completion, timeout,
cancellation or launcher shutdown. A dedicated parent control pipe lets parent
closure trigger Job teardown; it is separate from transcript stdout.
A parent-disappearance test is required, not just ordinary cancellation.

Launch without a command shell, hide console windows, use Unicode Win32 APIs and
correct Windows argument quoting. Limit inherited handles. Supply only the
needed Windows runtime environment such as `SystemRoot`, temporary-directory and
explicit runtime search paths; do not forward unrelated application secrets.
Keep transcript stdout separate from launcher status and native diagnostics.

A Job Object is a standard Windows process-ownership mechanism here, **not a
reintroduction of mandatory resource limits**. Test operation inside an existing
Scheduled Task/runner Job; do not request breakaway to bypass administrator limits.
No additional administrator rights should be required just to transcribe.
Microsoft's [Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
describes group termination, inherited membership and nested Jobs separately
from optional CPU/memory limits. This is lifecycle supervision for trusted
shipped engines, not a sandbox for arbitrary executables.

## Installation, upgrades and opt-out

Every interactive fresh installation and upgrade offers:

1. Keep current settings (Enter/default; unconfigured installations stay disabled).
2. Configure Sense GGUF q8, when a qualified compatible package is available.
3. Configure Whisper compatibility mode, with its known limitations shown.
4. Disable voice and hide its microphone controls.

EOF or cancelling the menu preserves settings. Unattended execution does not
read stdin; default to keep, print state and an exact reconfiguration command.
Explicit command-line choices invoke the same transaction. Startup, watchdog
restarts and normal application launches never prompt.

For Windows, integrate with `setup.ps1`, `deploy.ps1` and the standalone ZIP.
Run configuration before stopping the working app/activating the replacement
where feasible. Scheduled Task logon/startup and `service-watchdog.ps1` must not
unexpectedly present menus or download models. Preserve existing task identity,
ports, tunnel configuration and unrelated environment values.

Upgrade must execute the newly downloaded setup logic. The new deployment entry
points must re-enter the new script after pulling, preserving explicit options.
For releases older than those entry points, document and test the bootstrap:
pull first, then invoke the new deployment script (`--no-pull` on Linux,
`-SkipGitPull` on Windows). A historical running script cannot be retroactively
given new behavior merely by updating its file.

### Configuration transaction and platform details

- Inspect effective voice keys without logging secrets. Respect process/service
  overrides and `.env.production.local`; Linux additionally accounts for
  `/etc/agents-chat.env`. Windows user/machine environment and the actual
  Scheduled Task account may differ from the interactive installer account.
- Keep performs no migration, download or enablement.
- Use an exclusive setup lock, verify staged assets, then switch configuration.
  Keep old assets until explicit later cleanup.
- Retain unrelated `.env.local` settings. On Windows, support UTF-8 with/without
  BOM and Windows PowerShell-produced Unicode environment files, CRLF, spaces
  and non-ASCII paths. Reject unsupported encodings explicitly.
- Current JSON-style backslash escaping is not automatically compatible with
  `start.ps1`'s simple dotenv reader. Use a shared supported quoting contract;
  installer, Next.js and PowerShell must resolve the same Windows path.
- Windows path checks reject drive-relative paths, device paths, alternate data
  streams, archive traversal, reparse-point escapes and case-insensitive
  duplicate destinations. Do not reuse POSIX-only path assumptions.
- Use platform-supported atomic replacement. Locked files/antivirus interference
  yield a bounded explicit failure; never delete the old config first.
- Private receipts can contain the previous entire environment file. Unix mode
  0600 is not a Windows ACL guarantee: restrict access to the deploying/service
  identity and trusted administrators with Windows ACLs and verify access.
- Activation failure restores only the prior voice configuration and attempts
  the platform's normal restart. Preserve an actionable recovery receipt when
  recovery fails. Refuse rollback if an administrator changed config meanwhile.
- Application health alone is not model health. The completed installer must
  verify the selected installed runtime can launch before declaring voice ready.
  Do not claim full quality acceptance from that startup/smoke check.

Standalone bundles include the configurator and helpers, require no development
dependency installation, and preserve `.env.local` and model data across upgrades.

## Artifacts, licensing and distribution

Build platform-specific runtime packages in Actions from pinned sources and the
documented Sense thread/error patch. Reuse exact verified model weights, but
never reuse Linux executable compatibility or license closure as proof for a
Windows executable.

The manifest must identify OS/architecture, native engine/build revision, model
hash, required CPU flags, minimum runtime/OS dependencies, executable/model paths,
file sizes/checksums and notices. Current Linux `minGlibc` validation must become
platform-specific; Windows declares Windows/runtime dependencies, not glibc.

Windows packages must include or explicitly require their selected C/C++ runtime
and any DLL dependencies, with redistribution notices checked. Decide compiler
and link mode during the pinned-build spike based on the actual dependency graph;
the manifest must record the resulting choice. No invented Windows measurements
or "MIT-only binary" label.

The existing local package-import transaction is the first delivery path.
Automatic downloads remain a release requirement: publish reviewed immutable
platform assets and a trusted catalogue with checksums, bound download sizes and
timeouts, verify before extraction/activation, and preserve settings on failure.
Do not use mutable latest links, arbitrary URLs or expiring Actions artifacts
as an automatic production update channel. Package publication is explicit and
does not authorize deployment to PROD.

The permission policy prefers MIT/Apache-2.0/BSD-style model/runtime permissions.
Retain actual third-party obligations, including runtime exceptions where
applicable. Open source does not mean no notice obligations or zero legal risk.
Do not ship experiment corpus audio as part of model installation.

## Error handling, security and privacy

Preserve authentication, account ownership, origin checks, request-ID validation,
WAV validation, bounded upload and one-process admission. Windows is not a
reason to bypass API checks or add an unauthenticated local model port.

Unknown model/policy, missing binary/DLL, package mismatch, unsupported CPU,
launch failure, timeout, invalid output and cancellation have explicit outcomes.
No fallback to another model, unbounded execution or success-shaped empty output.

Do not log audio, transcript, native stdout, auth configuration or recovery
receipt contents. Keep only model/build identity, durations, sizes, exit status,
error codes and clearly scoped resource observations.
No shell-interpolated user audio paths or uploaded model filenames are allowed.
Windows error reporting must not expose private filesystem paths in API bodies.
Clean temporary audio/results after success, failure and cancellation; distinguish
normal teardown guarantees from machine crashes and abrupt OS shutdown.

## Validation and acceptance

Follow the repository's test-first practice: add focused failing logic/API tests,
implement, then cover user-visible behavior with Playwright. Use existing
`node:test`/tsx and Playwright infrastructure; do not add a framework solely for
this feature. All builds, inference, audio processing and validation run in
GitHub Actions, not on this development host.

### Platform matrix

| Environment | Required coverage |
| --- | --- |
| Linux x64 | Existing legacy compatibility; standard Sense/Whisper lifecycle; install/upgrade/rollback; browser/API regressions |
| Windows hosted Actions runner | Native builds, manifest/dependency tests, Windows paths/ACLs, process Job lifecycle, PowerShell setup/deploy and API/browser smoke |
| Actual Windows 11 x64 via an Actions runner | Required before claiming Windows 11 qualification; Scheduled Task deployment, runtime behavior and browser permission/capture checks |
| Browser clients | Desktop Chromium/Edge on Windows, existing desktop/mobile Chromium and WebKit regression coverage |

Do not equate a `windows-latest` runner label or passing Windows Server tests
with an actual Windows 11 run. If a suitable Win11 Actions runner is unavailable,
report that acceptance gate as blocked; do not run validation locally as a
workaround. A physical microphone test is distinct from synthetic Playwright
audio and must be labelled as such.

### Required regressions

- Fresh opt-out and enabled-to-disabled upgrade hide controls without an error.
- Every interactive upgrade prompts; Enter/EOF/cancel preserves settings.
- Unattended upgrade never blocks; explicit keep/disable/switch is deterministic.
- Old installations without voice keys and legacy Linux configurations migrate
  only by explicit choice; unsupported legacy Windows policy fails clearly.
- Bad manifest, interrupted/corrupt download, disk exhaustion, concurrent setup,
  platform mismatch, locked config and conflicting overrides preserve old state.
- Windows quoting/encoding, spaces/non-ASCII paths, DLL lookup, ACL protection,
  environment precedence and Scheduled Task identity are exercised.
- Cancellation/timeout/disconnection kills descendants, releases admission and
  deletes temporary files. Parent death and nested-Job behavior are tested.
- Failed process assignment cannot leave a suspended/running orphan.
- Standard mode has no application CPU/RAM hard cap; legacy Linux guards still
  fail closed. Thread settings are not advertised as quota tests.
- Installed real packages, not only mocks, transcribe through authenticated API.
- Standalone Linux and Windows bundles include working reconfiguration tooling.

### Model and end-to-end gates

Reuse frozen 60 ASCEND + 40 AISHELL-4 samples, identities, transcripts and
normalization. Score failed requests as reference deletions. Preserve the
approved 100% nonempty delivery requirement, aggregate short-input P95 at most
3 seconds, long-input P95 at most 5 seconds, and each language/duration error
rate within +2 percentage points of the identical-input unconstrained baseline.
Do not invent a middle-duration latency threshold or tune against test outputs.

Re-run the actual installed package/service path on each release-target platform
before recommendation. Record CPU model/flags, logical versus physical cores,
threads, any external quota, memory accounting and cold-process/cache scope.
Report API and browser timing separately from engine timing and state what each
includes. Already inspected corpora are not untouched holdouts.
Windows or rebuilt portable packages do not inherit Linux engine acceptance.
Whisper remains a labelled compatibility option even if it runs successfully.

## Existing evidence and remaining work

| Evidence | Meaning |
| --- | --- |
| Actions `35953083215` | Sense GGUF frozen100 engine gates passed in both Linux profiles |
| Actions `35955970940` | Full Nano/Qwen experiment completed; neither passed all gates |
| Actions `35965252088` | Linux provider build/typecheck, fixture API/browser and real Sense API smoke passed |
| Actions `35968099304` | Linux portable candidate package build, verified import, native transcription and rollback passed |
| Actions `35968626725` | Package integrity, setup interaction, release inclusion and isolated deployment tests passed |
| Actions `35968629945` | Installer-driven disabled upgrade hides microphone/no error banner; Linux integration passes |
| Actions `35972552477` | Windows Server native lifecycle foundation passes; no Windows model/app/Win11 qualification |
| Actions `35975644625` | Windows Server native runtime, private files, fixture API/browser integration pass; real models and Win11 pending |
| Actions `35974609962` | Shared runtime preserves Linux contracts, browser/API behavior and real pinned Sense smoke |
| Actions `35977946646` | Both real Windows candidate engines transcribe via app helper at 1/2/4 threads from Unicode paths; installation/Win11/full-corpus gates remain |

Remaining implementation slices, in order:

1. Keep the approved spec and completed foundation/runtime plans under
   `docs/superpowers/`. Write separate bounded plans for package/installation
   integration and qualification/distribution before those code changes.
2. Build candidate Windows runtimes and implement Windows-safe package/config
   transactions; integrate setup/deploy/release entry points.
3. Complete installed-package accuracy/latency, actual Windows 11, API/browser
   and failure/rollback acceptance. Keep blocked gates explicit.
4. Finalize notices and permanent trusted distribution, enable automatic
   downloads and publish only approved platform catalogue entries.

No Windows support or public automatic installation is claimed complete by
writing this document. Existing Linux evidence and working behavior must remain
intact throughout the cross-platform implementation.
