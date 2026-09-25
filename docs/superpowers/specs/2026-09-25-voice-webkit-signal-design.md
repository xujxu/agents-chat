# Retained WebKit waveform integrity diagnostics

## Authority and scope

On2026-09-25 the user approved option2: fixed-offset alignment with segment
offset diagnostics on existing audio. Written-spec approval is required before
implementation. This follows the completed error decomposition in
`2026-09-25-voice-webkit-error-analysis-design.md`.

Analyze all8mixed/medium samples, including improved and unchanged outcomes.
The goal is to describe signal differences and unresolved uncertainty, not to
repair recognition or replace the failed acceptance result.

Alternatives considered: level/duration-only inspection cannot distinguish an
ordinary recording start delay from mismatch; dynamic warping/resampling could
hide timing differences. Neither substitutes for the chosen fixed-offset
analysis. Do not change product code, recording parameters, inference, references,
corpus selection or acceptance thresholds.

No recording, inference, model download, playback server, audio gain correction,
time stretching or dynamic time warping is authorized. Diagnostic arithmetic
operates on in-memory copies only. Never write modified audio or submit it to a
recognizer. All waveform computation, hashing and tests run in GitHub Actions;
local work is editing, Git and reading small derived reports.
PROD, cpg and the old sampler remain untouched.

## Fixed inputs and identity

| Input | Run | Artifact | Archive SHA256 |
| --- | --- | --- | --- |
| ASCEND source corpus | 35858271102 | 10748244312 | 8f81879b98c3a64c557a9c7772fbb5b988b408018e6313800c96efb3ebc5fda0 |
| Linux WebKit collection | 36085430283 | 10844047138 | 0d2db5c932f787681047f425f984156c3c327e1428078eef0b1c42cf5fa6b9ff |
| Completed error decomposition | 36090984994 | 10845901259 | 52e23b1399a98828f7a409a713a6009cc1f9f8022f69cdc1f5541d5214a475de |

Source corpus commit: `1f773d5996f5d684ce1570705b6bb2344beee264`.
WebKit measurement commit: `7b680acb264b466868cff05a6f8dd9b40d856dcc`.
Error-analysis commit: `965574245761448173414b83ef454f4042442b5a`.
Keep these separate from the new signal-analysis run/commit.
Verify GitHub repository, run, artifact ID, commit, expiration and exact archive
digest before extraction. Reject unsafe/duplicate/symlink archive entries and
bound extraction. Only required source metadata, attribution and selected audio
need extraction; do not download recognizer packages or unrelated corpora.

The original source artifact expires2026-10-07, earlier than the two other
artifacts'2026-10-25 expiry. Missing/expired evidence blocks this phase. Do not
silently rebuild the corpus, replace input bytes or extend the task into a new
measurement. The derived artifact does not extend source retention.

Use original source identity and the frozen100 manifest, selecting
`category == "mixed"` and `5 < duration < 15`; require the same exact8IDs as the
completed decomposition:
`test-00332`, `test-00364`, `test-00554`, `test-00949`, `test-01049`,
`test-01050`, `test-01056`, `test-01058`.

Require each source SHA256, original duration and metadata to match both the
ASCEND source manifest and retained WebKit/decomposition identity. Upload SHA256
must match the WebKit attempt, upload manifest and decomposition row. Reuse
historical case/package/implementation/completion validation without changing
any measured implementation file or weakening fingerprints.

Read WAVs as canonical16kHz mono PCM16 with consistent RIFF/data lengths.
Validate finite, nonempty samples and original/upload durations against stored
values. Use float64 arithmetic with PCM scale32768, preserving original byte
hashes. Invalid WAV, source mismatch, incomplete sample coverage or stale
provenance is an evidence failure, not an acoustic finding.

## Unaligned measurements

Report these independently for original and uploaded WAV:

- Sample count/duration and uploaded-minus-original duration.
- Signed minimum/maximum PCM, absolute peak, RMS and arithmetic mean/DC offset;
  report RMS and peak in dBFS where defined. Zero signal has null dBFS plus an
  explicit zero-signal flag, not an invalid JSON infinity.
- Counts/fractions of exact negative/positive PCM rails(-32768/+32767), and
  separately near-full-scale samples with absolute normalized value>=0.99.
  Label these rail/near-rail statistics, not proof of clipping.
- Nonoverlapping10ms(160sample) frame RMS. Count low-energy frames at the fixed
  -60,-50and-40dBFS levels and report leading/trailing runs and all interior
  intervals at each level. Exclude an incomplete final frame from these frame
  counts and report its size explicitly.

Thresholds above are descriptive diagnostics fixed before reading the waveforms,
not speech detection, acceptance criteria or adjustable tuning parameters.
Low energy is not automatically silence, missing speech or an ASR error.
Retain all full-signal results even if later alignment is weak.

## Fixed-offset alignment

Both stored inputs are already16kHz. Do not resample either.
Let source `x` and upload `y` satisfy `y[i + lag]` versus `x[i]`; positive lag
means the uploaded signal occurs later. Search every integer lag in
[-16000,+16000]samples(-1to+1second).

At each lag compare only the real intersection:
`start=max(0,-lag)`, `end=min(len(x),len(y)-lag)`.
Require overlap>=80%of the shorter WAV; never synthesize zero padding as
compared signal. Compute zero-mean normalized cross-correlation on that overlap.
Use FFT-based correlation plus prefix sums/energies or an equivalent bounded
algorithm rather than an O(samples*lags) allocation/loop. Numerical FFT padding
is permitted only as an implementation of correlation, never as signal content.
Clamp roundoff-only excursions to[-1,1]; zero-variance candidates are invalid.

Select the candidate with greatest absolute correlation, retaining its sign to
expose possible polarity differences. For exact ties, choose smallest absolute
lag, then smaller signed lag. Record selected lag, signed/absolute correlation,
overlap samples and source/upload coverage fractions.

Also report the strongest alternative lag outside+-160samples(10ms)of the
selected lag and the absolute-peak difference. Keep the raw values.
Diagnostic flags:

- `weak`: best absolute correlation<0.80.
- `ambiguous`: alternative exists and peak difference<0.05.
- `search_boundary`: selected lag is either search endpoint.
- `insufficient_energy`: no valid nonzero-variance candidate.

Weak, ambiguous, boundary or unavailable alignment is explicit and cannot be
presented as a reliable match. These fixed flags are conservative diagnostic
labels, not new product gates; do not widen the search after seeing outcomes.

For an available alignment, report overlap residual RMS and
`residual_rms / source_overlap_rms`, plus zero-mean least-squares gain estimate
`sum(x_centered*y_centered)/sum(x_centered**2)`.
The primary residual uses unscaled original amplitudes. Do not optimize gain
to make the residual appear smaller, substitute an aligned interval's metric
for full-signal metrics, or discard low-energy segments.
Record unmatched source/upload prefix and suffix sample counts.

## Segment offset consistency

Use three fixed1second source windows centered at20%,50%and80%of original
duration. For each, search lag within+-1600samples(100ms)of the global selected
lag, clipped to the original global search range. Require the entire source
window and corresponding upload window to exist without padding.

Use the same zero-mean correlation, peak selection, alternative separation,
weak/ambiguous rules and raw metrics as global alignment. Mark a local window
`low_energy` if source or selected upload window RMS is at or below-60dBFS.
Missing/full-window, variance or global-alignment failures remain explicit.
If the global alignment is unreliable, local outputs, when computable, are
conditional diagnostics, not independently validated matches.

Report each local offset and its difference from the global offset. Compute
last-minus-first offset only if all three global/local matches are reliable
and not low energy. Otherwise emit null with an explicit reason.
This measures offset consistency; it is not a clock-drift root-cause verdict.
No linear or dynamic time correction is applied.

## Reports and interpretation

Produce a small `summary.json`, `samples.json` and readable `REPORT.md`, plus
ASCEND attribution. Include method constants and actual numeric-library
versions, source/analysis identities and file/artifact hashes.
No audio, model weights, private logs or corpus transcripts are committed or
uploaded as new analysis output.

For each sample, show its previously measured signed error contribution as
context alongside full-signal and alignment metrics. Do not compute a new ASR
score, fit thresholds to contributions, claim statistical significance from8
samples or treat this inspected diagnostic set as an untouched holdout.

Report global/local alignment uncertainty and all8outcomes, not only the largest
regression. Distinguish:

- Verified format/identity/control facts.
- Measured waveform/timing/level differences.
- Unresolved physical/implementation causes and the limits of alignment.

Completed browser source playback does not prove unchanged recorded speech.
Conversely a different residual, sample rate, low-energy interval or transcript
does not by itself prove a recorder/resampler defect. Do not attribute the
Windows transport failure, cross-platform numerical differences or real-device
behavior to these measurements.

An uncertain alignment is a valid completed diagnostic outcome. Invalid evidence
or failed algorithm contracts instead produces explicit failure status and
nonzero exit; no partial successful report. Never replace unknowns with zeros.

## Test-first validation and completion

Synthetic Actions-only contracts must establish exact lag/sign conventions,
positive/negative offsets, amplitude/polarity/DC changes, low-energy/zero variance,
periodic ambiguous peaks, bounded search/overlap, known dropped/repeated segments,
local offset shifts, complete-window constraints, frame-threshold edges,
rail counts and unchanged input arrays.
Test missing/duplicate samples, changed audio/manifest hashes and historical
versus new provenance separately. Preserve existing browser/error-analysis
contracts. Use bounded one-sample-at-a-time processing, no mandatory product
CPU/RAM caps or new local validation workloads.

After contracts pass, manually run this fixed diagnostic in Actions. Retain
derived reports30days; record exact run/commit/artifact/digest and findings in
this specification, the preceding error-analysis spec and deployment ledger.
Stop progress reminders at completion or a genuine blocker.

Completion is a verified description of all8retained signal pairs with explicit
uncertainty. Any subsequent corrective experiment, new recording/inference,
product change or wider browser/device validation needs a separate decision.
All original accuracy/delivery failures and thresholds remain unchanged.
