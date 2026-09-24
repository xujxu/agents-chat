# Installed Sense browser recording acceptance

## Status and authority

On2026-09-24 the user chose browser recording acceptance over further frontend
numerical localization and approved the design below for a written specification.
This document awaits written-spec approval before implementation.

The authoritative product requirements remain:
`2026-09-24-install-selected-voice-input-design.md`.
The completed installed-API and feature-exchange experiments remain evidence,
not browser acceptance or authorization to replace an engine.

## Motivation, alternatives and bounded scope

Installed direct-WAV API experiment35991326454 passed Linux Sense gates and
failed Windows Sense mixed/medium quality. Feature exchange36001871106 explains
two observed cross-platform transcript differences through frontend feature
values, without identifying a faulty math operation or qualifying a correction.
The actual installed model has not completed frozen-corpus browser capture.

Chosen approach: paired original-WAV/API and browser-recorded/API attempts on
each consumer host, followed by a frozen ONNX baseline on the exact recorded
bytes. Browser-only inference would be cheaper but would conflate capture and
recognizer effects. More numerical tracing would refine a cause without closing
the missing browser acceptance surface. No compiler/model selection is added.

This slice covers one model, SenseVoiceSmall official GGUF q8, desktop Chromium,
Linux x64 and Windows Server2022 x64. It does not qualify physical microphones,
AEC/noise suppression, actual Win11, Edge, WebKit or mobile full-corpus behavior.
Those remain separate gates. Existing relevant fixture regressions still run.
Whisper's compatibility status and prior failed gates remain unchanged.

No product recording algorithm, engine, helper, weights, defaults, thread count,
resource policy or acceptance threshold changes. No new user resource caps.
No PROD, live services, cpg or old sampler changes.

## Frozen inputs and package identities

Rebuild the same frozen100 with the existing preparation command and require
exact source sample identities, SHA256 values, references and selection. There
are60 ASCEND and40 AISHELL-4 samples. Keep existing normalization and original
duration bands: short<=5s, medium>5s and<15s, long>=15s.

| Input | Run | Artifact |
| --- | --- | --- |
| ASCEND source corpus | 35858271102 | 10748244312 |
| AISHELL-4 source corpus | 35863991538 | 10752270787 |
| Original short Sense ONNX scored baseline | 35858271102 | 10751002303 |
| Original long Sense ONNX scored baseline | 35870441019 | 10755950119 |
| Linux verified Sense package | 35968099304 | 10794617845 |
| Windows verified Sense package | 35987278609 | 10802394350 |
| Prior Linux installed API evidence | 35991326454 | 10804222694 |
| Prior Windows installed API evidence | 35991326454 | 10803903893 |

Install via the actual configuration CLI and verify persisted values and all
installed binary/model/helper role hashes against the package manifest and prior
installed identities. Explicit standard policy and2threads. Strip inherited
VOICE overrides. References never enter recognition arguments or browser audio
generation. No downloads or inference on the development host.

## Collector and pairing

Use focused test-only helpers and a new installed-browser corpus spec. Reuse
authentication/chat fixtures, canonical WAV validation and current installation/
service supervision patterns. Keep chat endpoints mocked if necessary, but
never mock voice capabilities, transcription, cancellation or responses.

For each platform, visit all100 sample IDs in sorted order exactly once. For
each sample, execute sequentially:

1. Original validated WAV through the authenticated API.
2. The same source waveform through the real recording UI and authenticated API.

This schedules200 attempts per platform,400 total. The direct path is a same-host
paired control, not another attempt to replace prior API qualification. Do not
compare Linux/Windows elapsed times as matched-hardware measurements.

The test-only `getUserMedia` implementation supplies a MediaStream from a
48000Hz Web Audio source context using the public source WAV. It must not replace
the product AudioContext, AudioWorklet, OfflineAudioContext, encoding or upload.
Start playback only after the real recording graph is ready. Record actual
source/recorder rates and playback/stop milestones. Preserve the product's30s
recording cap; do not extend it for the harness.

Observe, without changing payloads or responses:

- Stop-button intent and the recorder worklet stop request, including automatic
  stop. A test-only observer of the worklet port must forward all messages and
  arguments unchanged; it cannot manufacture samples or completion events.
- Actual Blob supplied to `fetch`, plus request/response metadata. Copying the
  Blob for evidence must not block dispatch of the real upload.
- Browser-observed composer value and UI error/idle transitions.

Only the actual request body may be saved as the captured WAV. Validate its
canonical mono16k PCM16 format, duration and size with the same application
validator. Retain its hash and length before same-byte baseline replay.
Do not crop, normalize amplitude, add post-hoc padding, substitute original
audio or select a better repeated capture.

Record source completion, duration and capture stop metadata. An unexpected
early stop, source cut off by the cap, missing payload or contradictory
milestones is an explicit capture-integrity failure, not proof of an engine
defect. Retain the failed attempt and any actual captured bytes. Do not exclude
it to claim100% delivery or silently reduce the reference transcript.

After each completed attempt require the UI to recover, admission to be released
and the next trial to start cleanly. Cancel owned work and await cleanup on
timeouts. Known per-attempt failures remain in the matrix; inability to recover,
invalid provenance or broken instrumentation stops execution as incomplete.
No per-sample retries. A harness correction requires a new identified run rather
than a selective replacement of unfavorable measurements.

## Timing and delivery semantics

Use browser monotonic timestamps for browser metrics, not subtraction between
browser, Node and server clocks.

The primary browser interval starts at the manual stop intent when available,
or the observed automatic worklet stop request, and ends when the expected text
is observed in the composer. Keep the worklet-stop timestamp in either case.
The interval includes recorder flush, resampling, encoding, upload, authentication,
inference and UI update; it excludes recording/speaking duration. Record which
stop origin was measured. An event-driven/polling observer must preserve normal
React updates and record its observation method.

Separately record fetch dispatch to response-body completion, the API's
`elapsedMs`, source/captured durations and recorder-stop to fetch overhead.
The direct control uses API-request wall time and separately API elapsedMs.
Neither HTTP-only nor API-only time may stand in for stop-to-composer latency.

A successful browser delivery requires HTTP200, a valid nonempty transcript,
exact text in the initially empty composer, recovered UI and valid capture
evidence. HTTP success with missing/incorrect UI text is a delivery failure.
Preserve API text separately from delivered text for diagnosis.

Every tuple has terminal status and explicit failure code. Timeouts, transport
errors, capture errors, HTTP422/500/502/503/504, empty text and UI failures are
accounted for. Unexpected auth/status/body shapes are instrumentation or setup
errors and mark evidence incomplete rather than successful model observations.
Do not emit raw engine logs, environment secrets or transcript content in CI
console output.

For failures occurring after stop, retain stop-to-terminal-failure time in the
all-attempt latency distribution, labelled as an attempted delivery, not a
successful transcript latency. When capture fails before a valid stop exists,
that latency is null/unavailable, never zero or recording-start elapsed time
disguised as stop latency. Delivery then fails, and latency eligibility is
explicitly incomplete. Also report successful-only timing as conditional
diagnostics; it cannot rescue delivery or latency acceptance.

## Two distinct accuracy comparisons

### Primary end-to-end gate

Use the existing original-source baseline, original references and duration
bands for both paths. This asks whether the whole browser transformation and
installed recognizer preserve the original task quality. It is an original-
stimulus comparison, NOT a claim that baseline and browser recognizer saw
identical PCM bytes.

Preserve the gates:100% valid nonempty delivery; each language/duration error
rate no more than baseline+0.02; aggregate short-input P95<=3s and long-input
P95<=5s. No medium latency threshold, rounding away failures, output-based
grouping or changed normalization. Score failed deliveries as full reference
deletions with the existing metrics. Group by original duration even if capture
has a longer leading/trailing interval.

Maintain distinct sourceAudioSha256 and uploadedAudioSha256 in evidence. Do not
rewrite captured identities to bypass an existing identical-input assertion.
Reuse scoring and threshold logic through an explicitly labelled end-to-end
comparison, retaining the source-to-upload provenance relation.

### Same-upload-byte baseline diagnostic

On Actions Linux, run the original pinned Sense ONNX baseline on each recorded
upload from both platforms, keyed by producer platform and sample ID. This is
up to200 baseline attempts; if capture failed without valid bytes, retain an
explicit unavailable baseline tuple. Do not fabricate an input or call that a
successful baseline. Baseline failure or missing evidence invalidates that
diagnostic comparison and remains visible.

Use sherpa-onnx1.13.8 and the original2024-07-17 int8 Sense model with existing
frozen arguments:CPU,2threads,auto language,ITN enabled,no VAD/hotwords.
The pinned archive checksums are:

- Runtime: `d0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc`
- Model: `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`

Retain engine/model/token hashes and exact arguments. Use sequential owned
process groups, bounded output, a120s deadline and awaited tree cleanup.
Do not expose a baseline service or install it as the user's selected model.
This stage is an accuracy diagnostic, not a new CPU/RAM recommendation or
cross-platform speed comparison.

Compare installed browser outputs to ONNX output on those exact bytes, and
record baseline error change from original to captured input. These observations
help separate capture sensitivity and recognizer behavior; they do not prove
that any individual error has one cause. Never use a degraded captured baseline
to loosen the primary original-stimulus gate or promote the Windows package.

## Reports, evidence and failure status

Retain the exact400 attempt matrix and a200-attempt/100-source completion marker
for each platform; incomplete collection must fail explicitly. Retain baseline tuple coverage
separately, including unavailable inputs and failed baseline processes.

Reports must include per-platform/per-path delivery, all failures, language/
duration errors, unchanged baseline gates, stop-to-composer and HTTP/API timing,
sample capture validity, original/upload hash pairs, and paired text/error
changes. Show success-only paired comparisons only with their excluded counts.
No automatic winning model/path, combined-platform P95, best-run ranking or
release approval.

Write reports before returning a measured gate-failure status. Missing or
inconsistent evidence is an infrastructure/incomplete-evidence status distinct
from measured failure; partial artifacts remain available. Windows's existing
direct quality failure is expected to remain reported even if the browser path
incidentally changes its transcription.

Artifacts retain original selection/attribution, actual captured WAVs, attempted
outcomes and milestone metadata, package manifests, implementation hashes and
host/browser provenance. Record browser version, OS, CPU/logical cores, available
physical/core/quota/memory data and explicit unknowns. Fresh native processes
may encounter warm filesystem caches. Do not upload weights, private configs,
receipts, credentials, unreviewed server logs or public release assets.
Use30day retention; record exact run/commit/artifact IDs and limits in this
specification and `scripts/VOICE-DEPLOYMENT.txt`.

## Test-first verification and completion

All tests, builds, typechecks, servers, audio and inference run only in Actions.

Before expensive corpus jobs, add failing contracts for exact selection/tuples,
identity and package mismatch, captured-byte baseline joins, preserved source
duration grouping, invalid/negative/nonfinite timing, missing stop timestamps,
failure-inclusive scores, all-attempt versus success-only P95, and non-promotion
when only the diagnostic baseline improves. Cover measured failures with retained
reports and incomplete evidence with explicit errors.

Add Playwright fixture checks for the observational capture helper, uploaded
bytes, stop/upload/composer milestones, automatic stop, API failure, UI failure,
capture truncation, timeout and cancellation/cleanup. Reuse existing lifecycle
and recorder coverage instead of altering product code for diagnostics.
Strictly typecheck the new collector/helpers explicitly because application
tsconfig excludes tests. Build and run relevant existing voice API/recording
regressions in Actions before actual paired inference.

The full paired collection and baseline diagnostics complete this bounded slice
even if measured gates fail, provided failures and evidence are complete and
truthfully reported. Do not tune capture scheduling, model options or reference
text to improve observed scores. Actual Win11/physical microphone, other
browser matrices, redistribution and permanent distribution remain open.
