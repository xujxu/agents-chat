# Installed voice lifecycle E2E smoke

## Authority and priority

On 2026-09-25 the user paused accuracy investigation and selected the boundary
"install/enable through real recognized composer text", excluding agent send,
reply and conversation persistence. The user approved a dedicated real-model
lifecycle smoke, covering Linux Chromium/Android Chromium/iPhone WebKit and
Windows Server Edge, followed by this written specification.

Do not continue waveform/phase investigation or rerun frozen100. Historical
quality, delivery and latency failures remain unchanged; this smoke is a
separate functional result, not an acceptance override.

Alternatives considered: rerunning installed corpus acceptance repeats existing
work and couples the flow to quality gates; mock-only UI testing cannot prove
installation or real recognition. The selected dedicated smoke uses the actual
configuration CLI, verified candidate package, authenticated API, native model
and browser recorder.

## Scope and environment

All tests, package/audio downloads, hashing, builds, servers and inference run
only in GitHub Actions. Local activity is editing, Git, metadata/log inspection
and reading small output reports. Implementation is inline, without subagents.
Do not touch PROD, cpg or the old sampler.

Start with an isolated checkout/configuration directory and no active voice
configuration. Exercise `scripts/configure-voice.mjs`, not manual writes of
VOICE settings or a model-specific environment override that bypasses it.
This validates voice-component installation/configuration, not fresh OS
provisioning, Linux systemd deployment, Windows Scheduled Task setup or public
release download UX.

Use existing project settings:

| Host | Browser configuration |
| --- | --- |
| Ubuntu 24.04 x64 | desktop Chromium |
| Ubuntu 24.04 x64 | existing Android Chromium/Pixel 7 |
| Ubuntu 24.04 x64 | existing iPhone WebKit/iPhone 14 Pro Max |
| Windows Server 2022 x64 | actual installed Edge channel |

Use one worker, no retries, fresh browser contexts per scenario and explicit
run/project/scenario identity. Record actual browser/host versions separately
from descriptors. Emulation does not qualify physical phones, microphones/AEC,
Safari or Windows 11; these existing external blockers remain.

## Fixed real dependencies

Reuse already verified Sense candidate packages without rebuilding or switching
models in response to outcomes:

| Host | Package run | Artifact | Manifest SHA256 |
| --- | --- | --- | --- |
| Linux | 35968099304 | 10794617845 | ccf50b7ddaef5f9a0cddd58f87c4f08421902c630b2ca2a485bfebaae727f40c |
| Windows | 35987278609 | 10802394350 | ed605fe13aacaf21d0aceb18127d6bccb0a1099f561aa0ecef95952975cae905 |

Configure `sensevoice-small-q8`, standard resource policy, two threads, using the
actual CLI and pinned expected manifest hash. Verify repository/run/artifact
identity and expiry before use, then installed role hashes and persisted
configuration after import. Never derive the trusted expected hash solely from
downloaded untrusted bytes. These remain candidate artifacts, not release approval.

For a small deterministic input set, use ASCEND test IDs `test-00332` and
`test-00949` from source run `35858271102`, artifact `10748244312`,
archive SHA256
`8f81879b98c3a64c557a9c7772fbb5b988b408018e6313800c96efb3ebc5fda0`.
The first provides an existing mixed-language sample; the second deliberately
retains a known difficult sample instead of selecting only a good recognizer
outcome. Selection is now fixed, before new inference.

Verify original source metadata, file hashes and attribution using the existing
safe retained-evidence reader where applicable. Do not use stored transcripts
as model outputs. Both samples are manual-stop, under the existing 30 second cap.
Source artifact expires 2026-10-07; expiry or missing packages explicitly blocks
the smoke, with no silent input substitution. Preserve attribution in artifacts.

## Lifecycle and user-visible assertions

Each host runs the complete lifecycle in a fresh isolated environment:

1. **Initially disabled.** Start the app with fixture login credentials but no
   voice overrides. Authenticate through the real login/session path. Assert
   the real capability endpoint reports disabled and the composer microphone
   is absent on every applicable browser project.
2. **Install and enable.** Stop the owned application process, run the real
   configuration CLI against the verified package, and restart. Check the
   persisted model/standard policy/two-thread settings and installed file
   hashes. Do not log the complete environment or private configuration.
3. **Enabled capability.** Log in with a fresh browser context. Real GET
   `/api/voice` reports enabled and the expected provider/model and limit.
   The microphone appears and is usable. No capability response mock.
4. **Real speech to draft.** For each of the two fixed samples, supply WAV
   playback through the existing synthetic getUserMedia source, while retaining
   the native recorder/worklet/offline conversion path. Seed a nonempty draft,
   begin recording, wait for source completion and stop through the UI.
   Native POST goes to the same-origin real `/api/voice`, under the real session,
   invoking the installed native model. Do not intercept/fulfill/rewrite this
   POST, send stored text or precompute transcription outside the path.
5. **Delivery and cleanup.** Require HTTP success with a nonempty valid text
   response and exact equality between that response and the appended draft
   portion. The original draft remains, the recording controls return to idle,
   owned media resources close and no chat send occurs. Capture errors, invalid
   WAVs, missing/empty result, prefix loss, duplicate append, unsolicited send
   or leaked temporary files are failures.
6. **Disable again.** Stop the owned server, run the CLI with `--model disabled`,
   restart and use fresh pages. Real capability is disabled and microphone is
   absent on all host projects. Keep model files as existing disable semantics
   intend; disable is not uninstall.

There are eight fixed real-ASR browser attempts: two samples across four
projects. Lifecycle assertions are additional non-ASR cases. A failed attempt
is retained without retry or replacement; continue independent cases where
safe. A failed setup phase blocks its dependent phases rather than producing
fake passed/skipped completion.

The source helper's current arming function clears the composer, so set the
test draft after arming and before recording. The observed complete composer
will include that draft; compare the expected prefix plus actual response,
not the historical corpus collector's no-prefix equality.

Chat/agent-list fixtures may isolate unrelated ACP availability, and may record
requests to prove no automatic send. Authentication, capabilities, voice upload,
native recognition and composer updates must remain real. Clearly label which
unrelated endpoints are fixtures; this is not full chat E2E.

Browser input is synthetic playback of real speech, not physical microphone
capture. No mock recorder, oscillator-only success, forced alternative recorder
rate or gain compensation is permitted. No intermediate graph probe is needed.

## Functional criteria versus quality research

Success means all lifecycle assertions and all eight real-ASR delivery attempts
pass. Do not calculate CER/MER, compare against reference transcription,
introduce a new speech-accuracy tolerance or require an exact predicted phrase.
Nonempty does not mean accurate; label the distinction in reports.

Retain stop-to-composer and server timing only if already available from the
existing observer, explicitly as diagnostic data. Do not promote this small
smoke to P95 evidence or change the existing short/long latency gates.
Use finite test/process deadlines consistent with existing installed collectors,
not new product resource caps.

If a failure is a test-harness defect, preserve its run/evidence and fix only
that defect before another full run. Never selectively retry speech samples,
hide errors, loosen functional assertions or fake model results to get green.
Fix product issues only when this flow proves a tightly scoped functional bug;
such changes require the appropriate API/UI regressions and must not alter
quality policy or unrelated architecture.

## Implementation boundaries and reuse

Use a dedicated lifecycle runner, focused Playwright config/spec and workflow.
Reuse configuration parsing, verified package import, project settings,
existing source observer and authenticated test-login helpers where applicable.
Do not modify the historical corpus collectors or their fingerprints to turn
them into a smoke test.

The runner owns only its child server processes, phase state and explicit
fixture files. Strip inherited VOICE overrides before spawn, reject conflicting
project overrides, check readiness and terminate only owned process IDs.
Apply lifecycle configuration on restart, not an unsupported live toggle.
Ensure Windows process-tree handling follows existing launcher/runner patterns.
Baseline and post-run temporary-directory checks must use existing cleanup
mechanisms rather than broad deletion.

Use actual Edge, not a Chrome executable with an Edge user-agent. Reuse existing
mobile descriptor settings without editing general-purpose Playwright projects.
No new production code is expected unless a demonstrated functional failure
requires it.

## Evidence, failure handling and validation

Retain small machine-readable phase/attempt summaries with run/commit,
package/installed identities, source IDs/hashes, actual environment, real API
status/text, original draft, observed composer text and cleanup/send checks.
Capture browser screenshots at enabled/completed/disabled milestones where
useful; keep them in Actions artifacts, not committed source files. Do not
upload credentials, `.env.local`, private server logs or model weights.
Do not copy corpus audio into new artifacts merely for reporting.

Reports must distinguish completed, failed and blocked phases; missing expected
projects or attempts prevents overall success. Upload partial sanitized evidence
on failure and use nonzero exit status. Keep every real speech outcome.
Include artifact provenance, expiry and explicit fixture/real-device limitations.

Test-first contracts cover phase order, expected matrix/attempt count, configuration
activation/disable, no stale environment override, invalid package identity,
missing/error/empty API result, draft/API/composer mismatch, automatic-send
detection, blocked phases, cleanup and explicit partial reports.

Run focused existing setup/activation tests, API/voice UI regressions, strict
type checks and build in Actions before the manual real-package smoke. Do not
run the corpus benchmark or unrelated audio diagnostics. A workflow run that
only passes fixtures must never be reported as real-model E2E completion.

Completion requires a persistent report and committed result ledger, with all
eight real attempts and lifecycle states reviewed. Historical quality and
real-device qualification remain separate and unresolved.
