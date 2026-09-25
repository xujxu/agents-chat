# Installed Sense Edge and WebKit acceptance

## Authority and scope

The user selected Edge/WebKit coverage and approved this design on2026-09-25.
After reviewing existing mobile coverage, the user approved retaining the two
measurement cases while reusing the existing mobile configuration and tests.
Written-spec approval is required before implementation.
The parent requirements remain `2026-09-24-install-selected-voice-input-design.md`
and the measurement definitions in `2026-09-24-voice-installed-browser-design.md`.

Chromium run36007108166 at97977de completed400paired API attempts and200same-byte
ONNX diagnostics. Both browser paths passed; Windows direct mixed/medium failed.
Preserve those results unchanged. Do not rerun Chromium corpus collection or
combine its latency distributions with this new experiment.

Repository runner inspection on2026-09-25 found zero self-hosted runners.
ActualWin11/physical microphone qualification remains blocked by environment.
No runner installation, local validation, production deployment or public
package publication is authorized by this slice.

## Existing coverage and the specific evidence gap

The repository already has mobile E2E coverage. This phase does not establish a
new iPhone/WebKit test suite or claim that mobile checks were missing.

| Existing surface | Coverage | Verified Actions evidence |
| --- | --- | --- |
| `tests/playwright.config.ts` | `android-chromium` with Pixel7 and `iphone-webkit` with iPhone14ProMax; selected mobile layout, composer viewport, typography, reading, persistence and voice specs | Configuration reused by the workflows below |
| `.github/workflows/playwright.yml` | Separate Android Chromium and iPhone WebKit checks on Ubuntu | Run35849926730 at638c553c: both jobs passed |
| `.github/workflows/voice-input.yml` | WebKit voice capture and cancellation using `tests/voice-input.spec.ts` | Run35850016943 atb0a4292b: the WebKit step passed |

Existing voice tests exercise browser recording, WAV upload, composer insertion,
cancellation/late-response isolation and automatic stopping. They use synthetic
microphone audio and controlled transcription responses or a native backend
fixture. Their success is useful regression evidence, but does not measure the
installed Sense package against the frozen100 speech corpus, original-reference
accuracy ceilings and stop-to-composer P95 thresholds.

The new evidence is that specific installed-model measurement on Edge and
mobile-emulated WebKit. Reuse existing device settings and regression specs;
extend only diagnostic selection, observation and evidence identity where
required. Do not duplicate mobile UX tests or broaden unrelated CI suites.
Running existing voice regressions as a prerequisite checks the current
measurement revision; it is not a new mobile-coverage deliverable.

Android Chromium remains covered by existing E2E checks. Its full installed-Sense
corpus measurement is outside this bounded two-case phase, and must not be
reported as completed. Neither existing nor new Linux WebKit evidence qualifies
released Safari or physical iPhone/iOS behavior.

## Choices and fixed matrix

Chosen: extend the existing diagnostic collector with explicit browser-case
identity and reuse its controls and existing mobile E2E configuration.
Using only existing E2E results would leave installed-model quality/latency
unmeasured; adding Android corpus collection would expand this bounded phase.
Further Windows numerical localization or distribution/licensing work remains
separate from this measurement gap.
Do not introduce a general configurable benchmark framework.

| Case ID | Host | Browser launch | Device settings | Meaning |
| --- | --- | --- | --- | --- |
| `win32-edge` | Windows Server2022 x64 | Chromium engine, channel `msedge` | Desktop Edge | Actual branded Edge on Server, not Win11 |
| `linux-webkit-mobile` | Ubuntu24.04 x64 | Playwright WebKit | Existing iPhone14ProMax descriptor | Mobile viewport/touch emulation, not physical iPhone or released Safari |

Use a focused diagnostic Playwright config or narrowly selected dedicated
projects so these corpus specs cannot accidentally join normal unrelated test
matrices. Preserve existing desktop/mobile projects and default Chromium runner
behavior. Reuse the existing `iphone-webkit` device settings and
`tests/voice-input.spec.ts`, rather than building parallel mobile regression
coverage. An explicit case selection must determine expected platform, project,
engine, channel and device configuration; unknown/mismatched selections fail.

Record actual host OS separately from browser engine/version, requested channel,
project/case, user-agent and emulation settings. For Edge require `msedge` launch,
record the resolved installed browser executable identity/version where the
runner exposes it, and verify Edge branding. No fallback to bundled Chromium.
For WebKit record the Playwright/browser versions and Linux host; do not infer
an Apple device or OS from the emulated user-agent.

## Inputs and unchanged product path

Reuse the same frozen60ASCEND/40AISHELL-4 source corpus, references, selection,
normalization, original-duration bands and baseline artifacts:

| Input | Run | Artifact |
| --- | --- | --- |
| ASCEND source | 35858271102 | 10748244312 |
| AISHELL-4 source | 35863991538 | 10752270787 |
| Original short ONNX baseline | 35858271102 | 10751002303 |
| Original long ONNX baseline | 35870441019 | 10755950119 |
| Linux Sense package | 35968099304 | 10794617845 |
| Windows Sense package | 35987278609 | 10802394350 |

Install through the actual CLI; verify persisted standard policy,2threads and
unchanged binary/model/helper hashes. Strip inherited VOICE overrides. Do not
change engine, weights, provider arguments, resource quotas, recorder algorithms,
API behavior, composer UX or installation defaults.

The synthetic microphone source is the existing48000Hz public-corpus
MediaStream. Recording controls, AudioWorklet, resampling, encoding, authenticated
API and composer insertion remain real. Preserve playback readiness,100ms
post-source stop scheduling and the unmodified30s product recording limit.
No post-hoc cropping, padding, gain changes, accelerated playback or replacement
of captured WAVs. Reference text never enters inference.

For each case, sorted100source IDs receive original-WAV/API then browser/API
sequentially:200attempts per case,400total. New direct controls pair the new
browser path on the same host; they are not retries of historical gate failures.
No sample retries or output-conditioned case selection.

## Identity and evidence isolation

Retain explicit `caseId` on each attempt, source/upload manifest, completion
marker, host/browser metadata and diagnostic baseline row. `platform` remains
the actual host, not a substitute for browser identity. Artifact names and output
directories include the case. Collector completion binds case,100sources,
200attempts, model, execution run and commit.

Baseline and report joins use `(caseId, sampleId)` and verify uploaded hash;
attempt uniqueness uses `(caseId, sampleId, pipeline)`. Check exact two-case
coverage, source identities, package roles, implementation fingerprints and
same-run provenance before scoring. Reject extra/duplicate/missing cases,
wrong channel/device/host, stale Chromium artifacts and changed captured bytes.
Never silently reinterpret missing case metadata as an Edge/WebKit case.

Preserve the old Chromium evidence reader/default command semantics or isolate
the new case-aware orchestration from it. Shared scoring helpers may be reused,
but their invariants and existing contracts must remain intact. Host paths,
browser names and output prefixes must not be scattered independent switches.

## Compatibility gate before corpus collection

Each target browser first runs the existing observational capture fixtures and
relevant voice-input regressions, using the real recorder with controlled
transcription fixtures. Require evidence for:

- Exact upload-body preservation and valid WAV parsing.
- Manual and automatic stop observation without changing product timing.
- Stop/worklet/fetch/composer milestones and single-clock timing.
- Source completion/truncation detection and cleanup of owned contexts/tracks.
- API failure, transport failure and successful API without composer delivery.
- Cancellation and recovery without adopting a late response into another case.

Run explicit collector/config/helper typechecks because application tsconfig
excludes tests, plus app build/typecheck. Keep existing shared report contracts.
Unsupported recorder APIs, WebKit observation incompatibility, missing Edge or
launch failure are surfaced before corpus work. Do not drop a target, skip its
required assertions, substitute a browser or manufacture successful recordings.

A test-only observer adaptation may preserve native call arguments and events
to support another engine; document and cover it with fixtures. A genuine product
defect requiring algorithm/runtime/UI changes is outside this measurement-only
approval and requires a separate explained design decision. Retain the blocking
evidence rather than silently modifying product behavior.

## Measurement and interpretation

Keep the prior primary timing definition: manual stop intent, or observed
automatic worklet stop request, to first observed expected composer text.
Include recorder flush/resample/encode/upload/auth/inference/UI; exclude speaking.
Record HTTP/body interval and API elapsedMs separately, without cross-clock
subtraction. Identify stop origin and actual source/recorder rates.

Preserve original-reference quality gates:100%valid nonempty delivery; every
language/original-duration error bucket <=original baseline+0.02; aggregate
short<=5s audio P95<=3s and long>=15s audio P95<=5s. No medium latency threshold.
Successful response without valid capture/exact composer text is not delivery.
Failed attempts count as reference deletions. Missing stop timing remains null/
incomplete, never zero. Success-only latency/pairs are conditional diagnostics.

Retain the fixed ONNX baseline on each newly captured upload, up to200executions.
Use the prior pinned runtime/model archives, hashes and CPU2thread/auto/ITN
arguments, bounded outputs,120s deadline and awaited owned-tree cleanup.
Every case/sample has a diagnostic tuple even when input is unavailable or
baseline inference fails. No original WAV substitution for absent recordings.
Do not infer a native WebKit/Edge ASR engine: both use the installed server model.

Primary quality still compares original stimulus/reference, not equal recognizer
PCM. The same-upload diagnostic compares exactly matching captured bytes and
cannot relax the primary gate, rank browser choices or promote the model.
Keep original/upload hashes distinct. Never use browser success to erase
Windows's original direct-WAV accuracy failure.

## Actions orchestration and completion

All builds, fixtures, test servers, audio processing, inference and reports run
in GitHub Actions. Only source editing and remote evidence inspection occur on
the development host. PROD, cpg and old sampler remain untouched.

Use push-triggered focused contracts and manual expensive measurement. Provision
real Edge in the Windows job and WebKit/system dependencies in Linux. Two
collector jobs run independently with fail-fast disabled; a blocked target
must not become a passing subset report. Reuse exact licensed corpus/model
downloads and package importer. No compulsory CPU/RAM caps.

The full run performs two case collectors, same-upload ONNX diagnostics on
Linux and a case-aware aggregate. Retain per-case reports even on measured
failure; incomplete evidence/compatibility failures have explicit status rather
than a fabricated gate result. No corpus work until the target's compatibility
checks pass. Report matched-case measurements only, not causal browser speed
rankings across unrelated hardware.

Upload only reviewed evidence: outcomes/milestones, original selection and
attribution, captured WAVs with hashes, package/implementation/host/browser
metadata, baseline identities, reports and sanitized failure diagnostics.
No model weights, private configuration, credentials, unreviewed service logs
or released install assets. Use30day artifact retention.

Test-first cases include case uniqueness/coverage, stale/wrong browser identity,
source and upload corruption, cross-case baseline joins, original-duration
grouping, failure-inclusive scores, invalid/null timing and unchanged thresholds.
Existing Chromium report contracts must remain green without rerunning its
completed400attempt corpus.

The bounded phase ends with complete case reports (including measured failures)
or a clearly evidenced compatibility/product blocker. Record exact run/commit/
artifact IDs and interpretation limits in this spec, the parent design and
`scripts/VOICE-DEPLOYMENT.txt`; stop progress reminders at completion/pause.
ActualWin11, physical microphones/AEC, released Safari/iOS/Android devices,
Windows direct quality remediation, redistribution and permanent trusted
downloads remain separate work.

## Completed measurement: 2026-09-25

Written revision `6d64296` was approved for inline execution. Test-first
run36083976647 demonstrated the missing case module while the eight legacy
contracts passed. Implementation `b340f99` and expanded contracts `c1f2d7c`
added case-aware selection, collection and evidence validation.

The existing iPhone/WebKit voice regressions were reused, not replaced.
Initial compatibility runs36084214690/36084280859 exposed assumptions in the
new capture fixtures: WebKit's Playwright request observer did not expose the
Blob body, and an exactly30second synthetic input could finish before automatic
stop. The fixtures now compare the observation to an independent loopback HTTP
receiver's actual bytes and use a32second generated input to verify the unchanged
30second recording cap. Follow-up run36084652722 exposed fixture CORS handling
and per-wrapper track-stop observation problems. `7b680ac` corrects those
test-only mechanisms, forwarding native track stop and tracking owned resources
by stable track ID. No production recorder, API, model or inference change.

Run36085061136 passed both target compatibility jobs and the14Python contracts.
Legacy Chromium regression run36085061185 passed without rerunning its corpus.

Full measurement:
https://github.com/xujxu/agents-chat/actions/runs/36085430283
at `7b680acb264b466868cff05a6f8dd9b40d856dcc`.
All14Python contracts, explicit collector/config typechecks, application builds
and typechecks passed. Each compatibility job and installed collector passed
15voice/observer fixtures with2explicit native-fixture-server-only skips.
Both actual installed collectors completed200attempts:400total,399deliveries.
All200browser attempts delivered with valid capture/UI evidence.
All200same-upload ONNX diagnostics completed, with no unavailable input.

| Case | Path | Delivery | Short P95 seconds | Long P95 seconds | Primary gates |
| --- | --- | ---: | ---: | ---: | --- |
| `win32-edge` | Direct WAV/API | 99/100 | 0.7601374 | 3.5804406 | Fail delivery and mixed/medium quality |
| `win32-edge` | Browser | 100/100 | 0.6800 | 3.4040 | Pass |
| `linux-webkit-mobile` | Direct WAV/API | 100/100 | 0.469156775 | 1.820615395 | Pass |
| `linux-webkit-mobile` | Browser | 100/100 | 0.4970 | 1.7050 | Fail mixed/medium quality |

The mixed/medium baseline is14.6667%, with an unchanged ceiling of16.6667%.
WebKit browser error is17.3333%; Windows direct error is26.6667%, including
the failed `test-01049` attempt as full reference deletions. That attempt has
`transport_error`, null HTTP status and0.0055659seconds; the retained category
does not identify a socket, server, native-engine or infrastructure root cause.
Its paired browser attempt succeeded. It was not retried or excluded.
Windows browser mixed/medium is14.6667%; Linux direct is16.4444%.

The aggregate exits1 deliberately for measured failures, not an incomplete
matrix or report infrastructure error. No threshold changes, selective repeats
or Windows qualification promotion. Same-upload diagnostics remain secondary;
they do not turn the original-stimulus WebKit quality failure into a pass.

Actual Edge is154.0.4258.37, with matching executable version and retained
SHA256 `f530bafcdb7e529bd21dd8be46e20c82b5c70fa0ffd770fe4c45a5c2c054c211`.
The Desktop Edge descriptor supplies an emulated147user-agent; do not infer the
installed version from it. WebKit reports26.4 under Playwright1.59.1, with the
existing iPhone14ProMax descriptor (430x740, scale3, mobile/touch).
Linux host: AMD EPYC9V45, kernel6.17.0-1022-azure.
Windows host: Server2022/10.0.20348, AMD EPYC9V74.
Both have4logical CPUs and about16GiB RAM; effective quotas/physical cores/native
peak RSS remain unknown. Cross-host timings are not causal browser comparisons.

Artifacts expire2026-10-25:

| Artifact | ID |
| --- | --- |
| `compatibility-win32-edge` | 10843349224 |
| `compatibility-linux-webkit-mobile` | 10843254794 |
| `installed-browser-win32-edge` | 10844652395 |
| `installed-browser-linux-webkit-mobile` | 10844047138 |
| `installed-matrix-baseline` | 10844915649 |
| `installed-matrix-report` | 10845090269 |

Report digest:
`sha256:5dc240fda7861a20ce471c7746bf9cf22337cbc220222af0c83070b6b945acea`.
Per-case artifacts retain source/upload manifests, actual captured WAVs,
milestones/outcomes, package/implementation fingerprints and browser/host
identities. The bounded measurement is complete, but product acceptance fails.
Windows direct quality/reliability and WebKit recorded-input quality remain
open, alongside actualWin11, physical microphones/AEC, real Safari/iOS/Android,
redistribution permission and permanent trusted downloads.
