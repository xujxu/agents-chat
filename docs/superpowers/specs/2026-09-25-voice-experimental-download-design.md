# Explicit experimental voice package acquisition

## Authority and delivery sequence

On 2026-09-25 the user approved option 1: explicit experimental automatic
selection from trusted Actions candidates, then real service deployment E2E.
They approved separate sequential subprojects A (this specification) and B
(actual systemd/Scheduled Task new-install/upgrade E2E).
Accuracy research stays paused. This is not approval to publish packages or
declare candidate quality/redistribution acceptance.

Current installation and real voice API-to-draft flow passed
`36103664749` at `2e1b640`; it required a local package and trusted manifest hash.
This change removes that manual acquisition step only when explicitly opted in.
Public permanent downloads, new model builds, redistribution approval and B's
system-service execution are not part of A.

## User interface and trust boundary

Add `--experimental-download` to `scripts/configure-voice.mjs`,
`--voice-experimental-download` to Linux deploy/upgrade forwarding and
`-VoiceExperimentalDownload` to Windows setup/deploy.
The shared Windows helper uses a corresponding `-ExperimentalDownload` switch.
Explicit local `--package-dir`/`--manifest-sha256` remains unchanged.

Interactive users can pass the switch and choose Sense from the existing menu.
Noninteractive users must also explicitly choose `sensevoice-small-q8`.
Without the switch, missing local package parameters continue to fail clearly;
there is no implicit network request or automatic enabling.
Default keep and explicit disabled never fetch an artifact or require credentials.
Do not download packages on rollback.

Reject combining experimental download with either local package argument for
an enabling action. Reject automatic Whisper acquisition: only the already
verified Sense entries are included. Preserve existing offline Whisper support.
Unsupported OS/architecture fails before network traffic.

Show candidate status, repository/source and artifact expiry before transfer.
The mechanism requires `gh` and an existing authenticated read-only GitHub
context with access to the repository's Actions artifacts. Use `gh auth status`
or an equivalent authenticated API failure for a clear credential instruction.
Do not request, prompt for, print or persist tokens. Never give `gh` an implicit
repository; every API path is `repos/xujxu/agents-chat/...`.

No public Release is created, no package is uploaded, no latest tag or mutable
remote catalogue is trusted. The checked-in catalogue is authoritative; updates
require a reviewed code change. Archives remain short-lived Actions artifacts.
If they expire, stop with an explicit explanation rather than silently rebuilding
or selecting another run.

## Fixed catalogue

Only x64 and model `sensevoice-small-q8`:

| Field | Linux | Windows |
| --- | --- | --- |
| platform | linux | win32 |
| run | 35968099304 | 35987278609 |
| artifact | 10794617845 | 10802394350 |
| name | voice-install-sensevoice-small-q8 | voice-windows-candidate-sensevoice-small-q8-86fa6716eceaf4254fb020664338fcadcce37868 |
| source commit | a2f15bff3c05b94433855ce9d16056cac1296133 | 86fa6716eceaf4254fb020664338fcadcce37868 |
| archive SHA256 | e2be50235ba3f584833750c444c313dd3aa4231c65a6eb1c222e18c06e0e7295 | 2796a7666cf36f1f9597af1978af1df1feeec648bbca1036a226cb99ddebe3ab |
| manifest SHA256 | ccf50b7ddaef5f9a0cddd58f87c4f08421902c630b2ca2a485bfebaae727f40c | ed605fe13aacaf21d0aceb18127d6bccb0a1099f561aa0ecef95952975cae905 |

Repository numeric ID is 1260147964. Metadata must match repository identity,
run, source commit, artifact ID/name/digest, nonexpired state and a parseable
future expiry. Validate the archive byte count against API metadata and enforce
a maximum 512 MiB compressed size. Manifest and files are still checked by the
existing platform importer, including CPU/runtime requirements and licenses.

Package artifacts currently expire 2026-10-24. This is an experimental access
window, not a durable release channel.

## Acquisition and safe staging

Use a focused acquisition helper and catalogue under `scripts/voice/`; share
them across the Node CLI and deployment wrappers. Do not duplicate downloader
implementations in Bash/PowerShell. Do not import waveform analysis modules.

Use the installed `gh` CLI to download by exact artifact ID to a private temporary
directory. Bound metadata output and time (60 seconds); bound transfer to
300 seconds and 512 MiB. Metadata fetch and archive transfer failures are explicit,
sanitized errors; do not dump arbitrary subprocess stdout/stderr or credentials.
No shell command construction with tokens or response content.

Verify SHA256 before opening/extracting the archive. Use an existing available
archive library if suitable, otherwise add a narrowly scoped maintained ZIP
reader dependency. Do not rely on platform shell unzip behavior. Read entries
lazily with bounded memory.

Enforce 512 MiB total uncompressed bytes, bounded entry count (4096), regular
files/directories only, and reject symlinks, duplicates/case-insensitive collisions,
absolute paths, `..`, backslashes, colons, NUL, and Windows reserved/trailing
dot/space names. Validate declared versus actual byte counts. Write only beneath
the temporary extraction root; never follow preexisting links or overwrite files.
No executable is run from the download stage.

Only after complete download and trusted manifest verification may the existing
importer copy package files into its normal destination, verify every file and
return installation configuration. Existing configuration transaction, rollback,
concurrent-setup lock and Windows ACL behavior remain the authority.
Finish or failure removes only the helper's own resolved temporary directory.
Keep/disabled/rollback leave acquisition staging untouched because none is created.
No persistent download cache is required.

## Credentials and deployment subprocesses

Acquisition uses the invoking user's existing `gh` login or `GH_TOKEN`/
`GITHUB_TOKEN` environment. Linux sudo users must arrange access for the identity
running the installer; documentation must not recommend putting tokens in
`.env.local`, service units or command-line arguments.

Do not add tokens to configuration, recovery receipts, reports or service
definitions. Scope CI tokens only to the acquisition/deploy invocation.
Any CI service activation must ensure transient token variables are absent from
the task/service environment; this is also a required check in B.
No new permissions beyond repository artifact read are required.

## Error and compatibility policy

Failures such as unauthenticated gh, unavailable/expired artifact, stale catalogue,
bad hash, archive traversal, extraction-size mismatch, unsupported platform or
import validation must return nonzero with a useful sanitized explanation.
Do not fall back to another model, artifact, download channel or mocked package.
Do not enable voice on failed acquisition. Preserve preexisting unrelated config.

This patch does not change the recorder, API, provider, ASR settings, quality
thresholds, CPU/memory policy, defaults or service identity.
Upgrade without explicit voice changes remains keep and performs no download.
Existing explicit offline packages continue working without gh.

## Test-first Actions-only verification

All package downloads, ZIP construction/extraction, hashes, tests, builds and
real inference execute only in Actions. Local work is editing/Git and small
metadata/report inspection. No local server or validation.

Contracts cover fixed catalogue selection; gh command arguments; wrong repo,
run, commit, ID/name/digest/size/expiry; failed/empty metadata; missing credential
tool; truncated/corrupt archive; unsafe entries/duplicates/symlinks/Windows names;
size/count limits and cleanup; flags through every wrapper; keep/disabled/rollback
without network; offline option compatibility; atomic configuration preservation.
Use injectable process/metadata boundaries in tests, not product environment
backdoors that change the trusted catalogue.

Extend the existing lifecycle runner with an explicit acquisition mode. In this
mode prepare only fixed speech source input ahead of time; the real
configuration CLI must acquire the candidate package, using the new switch.
Do not pre-download the package or manufacture local package args for it.
Verify installed role hashes against the downloaded trusted installed manifest,
record the selected catalogue identity and ensure secrets are absent from
service child environments.

On both Linux and Windows, run the same initial-disabled -> acquire/install ->
enabled real speech -> disable/restart lifecycle. Reuse the four browser projects,
two fixed samples and eight real-ASR functional checks from
`2026-09-25-voice-lifecycle-e2e-design.md`. No scoring or frozen100 rerun.
Previous offline lifecycle results remain intact; new results clearly identify
experimental acquisition mode.

Documentation must include explicit CLI/Bash/PowerShell examples, gh
authentication expectations, candidate/expiry limitations, offline fallback by
explicit user choice and HTTPS requirement for remote browser microphones.
Do not call HTTP loopback E2E evidence remote physical microphone acceptance.

## Completion and handoff to B

A is complete when contracts, wrapper forwarding, real automatic acquisition
and both host voice lifecycles pass, artifacts are retained and results are
committed/pushed. If real acquisition is blocked, retain the error and do not
claim automatic selection works.

Then proceed to B's separate written design: actual Linux systemd and Windows
Scheduled Task new-install/upgrade execution, explicit no-tunnel propagation
with unchanged defaults, service-owned processes and cleanup, and token isolation.
No production service or existing local task may be touched. Publishing a
permanent/public release remains a separate approval and redistribution matter.
