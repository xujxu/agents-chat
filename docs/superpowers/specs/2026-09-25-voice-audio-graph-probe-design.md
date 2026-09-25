# Controlled voice audio-graph boundary probe

## Authority and objective

On 2026-09-25 the user approved option 1: passive observation at existing
audio-graph boundaries, followed by a written specification. Implementation
requires approval of this document and an implementation plan.

The completed retained-waveform investigation found only one reliable global
alignment among eight samples and no jointly reliable segment comparisons.
Its result remains unchanged: run `36094215228`, implementation `9c62b34`,
results documentation `4e0aea6`. Neither a browser defect nor an ASR root cause
was established.

This experiment uses deterministic, non-speech stimuli to identify the earliest
observable interval with a level, channel-content or timing difference.
It is not a new corpus measurement, quality qualification, latency acceptance
run or attempted fix.

Alternatives considered:

1. Observe existing buffers and messages: least graph disturbance, but cannot
   distinguish all operations between observations. Selected.
2. Add channel-resolved worklet taps: finer localization, but changes graph
   topology and rendering load. Deferred, not authorized here.
3. Force a sample-rate factorial experiment: compares alternative configurations,
   but changes the historical recording conditions. Deferred.

## Scope and invariants

All stimulus generation, browser execution, builds, type checks, hashing, signal
analysis and tests run in GitHub Actions. Local work is editing, Git, Actions
metadata inspection and reading small reports. Do not start a local server.
Use inline implementation, not subagents.

Do not change product recorder/worklet/encoder code, capture parameters, the
historical capture helper, browser-case definitions or implementation
fingerprints. Preserve PROD, cpg, the old sampler, old results and all acceptance
gates. No models, recognizer packages, corpus downloads, inference, gain
compensation, time warping, corrected audio or new product resource limits.

Use Ubuntu 24.04 with the existing desktop Chromium and iPhone WebKit project
settings. Retain actual browser versions, executable identity where available,
Playwright version, host details and descriptor settings. These two cases compare
complete browser configurations, not engine alone. Linux WebKit with an iPhone
descriptor is not physical iPhone/Safari; no Windows measurement is included.

## Existing path and observable boundaries

The existing helper supplies a synthetic getUserMedia stream through:

`16 kHz WAV -> decode in requested-48 kHz source context -> buffer source ->
MediaStream destination -> recorder MediaStream source -> recorder worklet ->
mono chunks -> offline 16 kHz render -> PCM16 WAV -> upload`

The production recorder creates its default-rate context before getUserMedia,
averages the channels received by its worklet, limits to 30 seconds, and uses an
OfflineAudioContext for final conversion. Do not force the recorder rate to
44.1 or 48 kHz; record the actual rates.

Observe these boundaries with a new, independently scoped test helper:

| Boundary | Evidence |
| --- | --- |
| A: supplied WAV | Exact bytes, format, channels, rate, samples and stimulus identity |
| B: decoded source buffer | Actual per-channel float32 PCM and rate, source node buffer identity |
| C: original worklet output | Ordered `samples` message copies, lengths, terminal message and recorder rate |
| D: offline render input | Actual mono buffer passed to the offline player, rate and length |
| E: offline render output | Actual rendered mono float32 buffer, rate and length |
| F: uploaded WAV | Blob bytes plus independent HTTP receiver bytes |

Also retain source/recorder context states, track IDs/settings, exposed node
channelCount/channelCountMode/channelInterpretation, source start/end, manual
stop, cleanup and message arrival times. A configured channelCount or track
setting is not proof of the number of channels delivered inside the worklet.

No new audio nodes, connections, processor implementations or worklet messages
are allowed. Observe the original worklet port with an additional event listener,
never replacing its production onmessage handler. Copy PCM without mutating or
transferring product buffers. Forward native constructor/method arguments and
return values, including original promises. Attach observation callbacks without
substituting success or swallowing native failures.

The offline input snapshot must be taken from the actual player buffer before
its original start call, not synthesized from the observed chunks. Preserve the
original rendering promise and inspect its resolved buffer. Exclude the
synthetic source context from recorder/offline hooks by object identity.
Unrecognized contexts, duplicate starts, missing buffers and hook failures are
explicit instrumentation errors.

Reuse the unchanged source helper and UI fixtures; install the extra hooks before
page scripts run. The new helper must compose with existing native forwarding
without changing the old helper. If a required boundary cannot be observed
without changing the audio path, stop with a documented blocker rather than
silently adding a tap or a product hook.

## Fixed stimuli and execution schedule

Generate canonical 16 kHz PCM16 WAVs, all 8 seconds long, with 0.5 seconds of
leading/trailing zero padding. PCM conversion uses the existing signed scaling
and rounding rule. Preserve generator version, parameters and byte SHA256.
These are synthetic diagnostics, not speech or acceptance inputs.

1. **mono-tones**: sum of 250, 1000 and 3000 Hz sinusoids, amplitude 0.04 each,
   zero initial phases; active from 0.5 through 7.5 seconds.
2. **mono-markers**: three distinct 200 ms bursts starting at 1, 4 and 7 seconds.
   Each burst has 40 consecutive 5 ms chips. Carrier is 1000 Hz; each chip's
   amplitude is 0.04 or 0.12 from successive low bits of xorshift32 output.
   Reset unsigned state to 1, 2 and 3 respectively for the three bursts.
   For each output, apply left13, unsigned-right17, left5 XOR shifts, retaining
   uint32 state after each operation. Use the updated state's low bit.
   Everything outside the bursts is zero.
3. **stereo-tones**: left channel is 500 Hz at 0.10 amplitude; right is 1500 Hz at
   0.06 amplitude, zero initial phases, active from 0.5 through 7.5 seconds.
   Distinct frequencies make channel contributions observable without claiming
   access to pre-average worklet input channels.

Use independent generator contract tests for PCM conversion and marker identity,
not only the production encoder as its own oracle. Silence and deliberately
invalid/missing evidence are contract fixtures, not extra measured recordings.

For each browser and each stimulus, run three fixed pairs in this order:
minimal/full, full/minimal, minimal/full. This is 18 recordings per browser,
36 total, with retries disabled and no sample selection based on results.
Each recording starts in a fresh page/context and uses the original source
helper's start-after-recorder-ready mechanism.

The **minimal** arm retains the existing upload/source/cleanup observer and
independent receiver, without the new intermediate PCM hooks. The **full** arm
adds B-E observation. Thus this comparison measures the incremental observer,
not a completely uninstrumented microphone path.
Require A and F in both arms and B-E only in the full arm. Absent intermediate
boundaries in the minimal arm are explicitly not collected, not evidence errors.

Play the full source, request manual stop after its 8 second duration plus the
existing 100 ms margin, and require observed source completion. Record actual
timing; do not assert exact wall-clock sleep length or trim uploaded audio.
Use the existing voice UI with a fixture capability response. Send POST bytes
to an Actions-local HTTP receiver returning explicit fixture text, without any
recognizer. Require exact Blob/receiver byte equality and composer delivery.
Label returned text as fixture data, never an ASR result.

Continue the predeclared schedule after a per-recording failure where safe,
retaining each failure without retry. If browser setup is unavailable, record
the affected attempts as not run; never substitute another browser. Missing
attempts or boundaries prevent a complete diagnostic report.

## Analysis rules fixed before execution

### Identity and exact same-grid checks

Check shape, rate, sample count, finite PCM, ordered events and cleanup before
interpreting signals. Compare concatenated C chunks with D sample-for-sample;
their float32 values must agree exactly. Check the product's output-length rule:
`min(16000 * 30, ceil(D.length * 16000 / D.rate))`.
Independently quantize E and require exact F PCM agreement, canonical WAV
headers and equality with independently received bytes.

Retain mismatches as measured boundary inconsistencies with first differing
index/count; do not repair them. The complete report separates these findings
from invalid/missing evidence. A mismatch with sound provenance is a diagnostic
finding, not a reason to omit the attempt.

### Raw and frequency measurements

For A-F where PCM exists, report per-channel rate, count, duration, min/max,
peak, RMS, DC and rail statistics. Reuse applicable existing pure numerical
helpers without changing their historical policy. A zero-valued signal has null
RMS/peak dBFS with an explicit zero-energy flag, not infinite JSON values.

For tone stimuli, fit sine/cosine pairs plus a constant on the central interval
3-5 seconds of each stage, using that stage's actual sample rate and sample
positions. Record amplitude at all expected frequencies, DC and unfitted
residual RMS. Unknown initial phase is a fitted diagnostic quantity, not a
time correction. Require the full interval; preserve failures explicitly.
Do not equate whole-file RMS changes with amplitude attenuation, since leading
or trailing silence may differ.

For stereo input, show B left/right separately and the theoretical arithmetic
mean spectrum alongside C. Do not assume default graph channel mixing equals
that prediction. A different contribution locates a discrepancy only in B-C.

### Marker timing

For mono-markers, derive a 1 ms RMS envelope for each stage on its own time grid.
Use sample intervals and duration-weighted squared values at bin boundaries,
so a 44.1 kHz grid does not round every bin to 44 samples. Exclude and report
any partial final bin. This is an analysis feature, not modified capture audio.

Use the A envelope of each complete 200 ms marker as its fixed template.
Independently search each stage within +/-1 second of that marker's nominal
start, in 1 ms steps, requiring a full real window without padded comparisons.
Use zero-mean normalized correlation, selecting the largest positive value;
ties choose smallest absolute nominal offset, then earlier time.
An alternative peak excludes +/-10 ms around the selected time.

Reliability flags are correlation below 0.80, best-minus-alternative below 0.05,
either endpoint of the actually available search interval, or zero variance.
Retain raw values and all flags. Never widen
the window or loosen the rules after inspecting outcomes. All flags clear is
required for a reliable marker position.

Report each marker's offset from nominal and the 1-to-2 and 2-to-3 interval
differences from the known 3 seconds. Only calculate an interval when both
markers are reliable; otherwise null plus reason. These within-buffer
differences do not subtract independent AudioContext/performance clocks and
do not establish a clock-drift mechanism.

Do not compare unlike sample-rate grids directly, resample captured arrays for
residual matching, or apply fitted gain/time corrections. Tone fitting and
marker-envelope extraction are descriptive features only.

### Incremental observer comparison and interpretation

For each minimal/full pair, show F sample count/duration, raw statistics,
tone amplitudes or reliable marker positions/intervals, source completion,
stop/upload timings and cleanup. Report signed paired differences and the
three individual pairs, not only an average or best attempt.

No post-hoc tolerance turns a small difference into proof of non-interference.
Repeated full-only failures or clear paired differences warn against attributing
intermediate observations to the original uninstrumented path. Even a visually
similar result cannot prove absence of observer effects.

Classify conclusions by observation interval: A-B decode/source preparation,
B-C MediaStream/implicit conversion/channel mixing/recording, C-D assembly,
D-E offline conversion, E-F encoding/upload. An earlier reliable difference
may bound localization; it does not identify an internal component automatically.
Missing or unreliable earlier observations must be stated, not skipped.

This experiment cannot explain historical speech errors causally, establish
real-microphone behavior/AEC, resolve Windows transport failures or promote any
previous failed gate. An inconclusive complete experiment is a valid outcome.

## Components, reports and failure behavior

Add dedicated probe stimulus/evidence types and helper files under
`tests/helpers/`, one focused Playwright probe spec and a separate probe config
derived from existing projects. Keep numerical report generation under
`scripts/` and use a dedicated Actions workflow. Do not expand the production
composition shell or modify historical measurement modules.

Process one recording at a time. Save binary float32 stage arrays with explicit
little-endian encoding, rate/channel/count metadata and hashes; do not dump PCM
as large JSON arrays or console output. Preserve synthetic input/output audio
and boundary arrays as a diagnostic artifact for 30 days. No model or corpus
audio is needed. Release page buffers before starting the next recording.

Produce a small summary JSON, per-attempt JSON and readable report with:
method constants, planned/observed attempt identities, source hashes, stage
hashes, instrumentation mode, run/commit, code fingerprints, actual environment,
all failures, paired comparisons and qualified interval-level conclusions.
Download only small reports locally. Artifact IDs/digests and expiration are
added to the durable result ledger after upload.

Invalid provenance, nonfinite arrays, missing/duplicate attempts, missing
required boundaries, hook errors, failed cleanup or receiver mismatch cause
explicit evidence failure and nonzero completion status. Preserve partial
artifacts and failure records, never a success-shaped partial report.
Valid observed acoustic differences or unreliable marker matches alone do not
fail the experiment infrastructure or imply product acceptance.

## Test-first validation and completion

Before browser measurement, Actions-only synthetic contracts cover generator
repeatability/channel layout; exact PCM/float32 representation; event ordering;
missing/duplicate/corrupt boundaries; same-grid equality and output length;
encoder agreement using independent known values; tone amplitude/phase/DC;
marker delay and interval changes; weak/ambiguous/boundary/zero-energy flags;
different sampling grids; null reasons; and preservation of input arrays.

Browser contracts verify original arguments/returns/promises are forwarded,
production onmessage still receives the original chunks, native errors remain
visible, the observer cannot mutate buffers, fixtures receive exact upload
bytes, no recognition service is contacted, and tracks/contexts close.
Run the existing narrow voice UI/capture regressions on both selected projects
and type checking/builds in Actions. Preserve old analysis contracts when
reusing their helpers. Run the full fixed probe only after these pass.

Complete by reviewing every scheduled attempt and diagnostic flag, publishing
the report and synthetic evidence artifacts, and committing/pushing a result
ledger with limits and unchanged failed acceptance outcomes. Do not silently
escalate to extra taps, forced rates, speech recapture or product fixes.
