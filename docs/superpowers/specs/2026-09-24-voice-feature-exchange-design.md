# Sense feature-boundary exchange diagnostics

## Status and authority

On 2026-09-24 the user chose feature exchange before compiler or strict-floating-
point comparisons. This written specification awaits approval before implementation.
The parent design and completed consistency experiment remain authoritative:

- `2026-09-24-install-selected-voice-input-design.md`
- `2026-09-24-voice-sense-consistency-design.md`

## Evidence motivating this slice

Run `35996836383` completed 648 attempts. Two of twelve samples differ across
Linux/Windows, consistently across repeats, 1/2/4 threads and native/transcriber/
API paths. Windows AMD reproduces earlier Windows Intel outputs. This establishes
stable native-path differences on this subset, not a compiler or CPU cause.

The pinned FunASR source at `3ff9259aade4f7e4360645df28cad8f81959ee91` exposes a
useful existing boundary. `runtime/llama.cpp/sensevoice/funasr-sensevoice/
funasr-sensevoice.cpp` supports `-a WAV` or `-f FBANK`. The latter consumes a
binary header with int32 frame count and feature width, followed by float32
log-mel/LFR features. Width is 560. It does not apply CMVN. Query embeddings,
scaling, positional encoding, graph computation and decoding remain downstream.

The original frontend uses miniaudio for mono16k float samples, then scalar
Hamming window, FFT, log-mel and LFR operations. Its `cosf`, `sinf`, `logf`,
reductions and compiler behavior may differ across hosts; that is a hypothesis,
not an identified defect.

## Goal, alternatives and exclusions

Determine whether decoded PCM or feature tensors differ, and whether transcript
differences follow the feature producer when the existing consumer engine is held
fixed. Conversely determine whether differences remain when both engines receive
identical feature bytes.

Chosen approach: compile only a small diagnostic frontend extractor and reuse
existing verified native engines through their existing `-f` input.
Compiler replacement would change many downstream factors at once. Strict-float
toggles would establish sensitivity but not locate the affected stage.

Do not rebuild or replace the existing model engines/helpers, change formulas,
weights, default settings or acceptance gates, choose a build by accuracy on the
explored corpus, publish packages, or change production code. No API/browser
measurement, Windows11 qualification or end-user feature-input interface is added.

## Fixed inputs and selection

Reuse these unexpired pinned artifacts:

| Input | Run | Artifact |
| --- | --- | --- |
| Frozen selected samples and Linux historical attempts | `35996836383` | `10806103628` |
| Windows historical attempts | `35996836383` | `10806823293` |
| ASCEND source WAVs | `35858271102` | `10748244312` |
| AISHELL-4 source WAVs | `35863991538` | `10752270787` |
| Linux Sense verified package | `35968099304` | `10794617845` |
| Windows Sense verified package | `35987278609` | `10802394350` |

Prepare frozen100 using the existing command and reproduce the deterministic
selection with `select_samples`. Require exact equality with the retained
twelve-sample selection. Do not add or remove samples after observing output.
Verify all original waveform SHA256 values before extraction and replay.
References accompany evidence but never enter native arguments or computation.

## Extraction jobs

Run one Linux and one Windows Server extraction job in GitHub Actions.
Fetch the pinned upstream source and retain its archive checksum. Extract the
constant/function block from `FS=16000` through the end of `compute_fbank` using
strict unique source anchors. Preserve that block byte-for-byte and include
unchanged pinned `funasr_audio.h` and `miniaudio.h`. Any anchor drift is fatal.
Do not transcribe the frontend into Python or silently substitute another FFT.

A minimal standalone C++ main loads the checked WAV via
`funasr_load_audio_16k_mono`, writes decoded PCM float bytes, invokes the original
`compute_fbank`, and writes its feature vector. No model weights are needed.
The wrapper verifies frame count, positive dimensions, finite values and complete
binary writes; failures stop extraction with nonzero exit.

Build Linux with GCC12 on Ubuntu22.04 as in the original package's toolchain
family, Release `-O3 -DNDEBUG`, C++17 and no native tuning. Build Windows with
the installed Visual Studio2022 x64 MSVC, Release `/O2 /DNDEBUG /MT`, C++17,
`NOMINMAX`, `_USE_MATH_DEFINES` and the existing UTF8 manifest. Do not introduce
fast-math/strict-float toggles. Record exact compiler version, command, platform,
source hashes and extracted-block hash. The standalone compilation is not
claimed to be bit-identical to the original full translation unit.

That limitation is handled by mandatory replay controls below: if extracted
features do not reproduce the installed engine's native audio-path transcript,
this experiment cannot attribute that path's difference to the frontend.

## Feature format and preflight

Require x64 little-endian IEEE754 float32 on both producers. Each feature file:
little-endian int32 T, int32 F=560, then exactly T*560 little-endian float32 values.
For a canonical16k WAV with N PCM frames:
`raw_frames = floor((N - 400)/160) + 1`, `T = ceil(raw_frames/6)`.
Require N>=400, N<=480000, positive T, exact byte length and finite values.
PCM output is exactly N little-endian float32 values without a header.

Use validated WAV frame count, not untrusted feature header multiplication, to
bound expected lengths before parsing or passing files to the existing native
`-f` reader. Reject trailing/truncated data, NaN/Infinity, mismatched dimensions,
identity changes and hash mismatches. The old engine feature reader is not
treated as safe for arbitrary external files; only these preflight-checked,
same-run diagnostic files may be passed to it.

Artifacts retain the selected manifests, original selected WAVs and attribution,
PCM/features with hashes and dimensions, generated extractor source, build
commands/tool versions and executable hash. Do not upload model weights, whole
source archives, environment secrets or unreviewed public release assets.

## Consumer matrix and process ownership

After both extraction jobs complete, run one Linux and one Windows Server
consumer job. Each downloads both producers' features, checks their complete
sample identities and original WAV bytes, verifies its existing package with
the actual importer/configurator, and uses only its checked binary/model/helper.
Both feature sources run on the same consumer host and binary.

Fix threads at2, standard policy, no VAD, language hint or SRT. For each of three
repetitions and each sample in sorted ID order run:

1. Existing engine `-a` on original WAV.
2. Same engine `-f` on Linux-produced features.
3. Same engine `-f` on Windows-produced features.

There are 12*3*3=108 attempts per consumer and 216 total. Fresh sequential
subprocesses, with no new CPU/RAM caps. Compare same-platform feature replay
against native audio and both against historical thread2 native text.

Use a CI-only bounded argument runner: Linux process groups and Windows's
existing Job helper, 120-second deadline, 32KiB stdout and 64KiB stderr,
strict UTF8/nonempty text, cancellation and awaited tree cleanup. On Windows
keep the helper control pipe open during inference, close it to cancel and
retain the existing bounded teardown escalation. Do not run the Windows engine
without its helper or alter the application API to admit feature uploads.
The Windows helper's diagnostic channel retains its existing256-byte bound and
timeout sentinel semantics; the64KiB limit applies to native Linux stderr.

Persist every attempted tuple `(consumer, sample, repetition, input_source)`.
Known native failures are explicit failed attempts. Invalid package/input/
provenance or orchestration errors stop execution and mark evidence incomplete.
Do not substitute WAV inference if feature replay fails.

## Reporting and causal controls

Report exact completion, delivery and repeatability separately from equality:

- Producer PCM hashes and numerical differences.
- Producer feature hashes, changed element count, maximum absolute and RMS
  difference, dimensions and finite-value checks. No invented tolerance pass.
- Same-consumer native WAV versus same-platform feature text (control).
- Current native WAV versus retained historical thread2 native text.
- Same-consumer Linux versus Windows features (producer intervention).
- Cross-consumer text on the identical Linux feature bytes and separately the
  identical Windows feature bytes (consumer intervention).

For each sample/consumer, attribution requires successful stable repetitions,
agreement with historical native text and equality of own-feature/native text.
If a control fails, retain every observation but label interpretation invalid
for that sample; do not silently use only successful controls to make a global
cause claim. Emit an explicit control-failure status after report creation.
Failures never compare as equal nulls. Exact PCM/feature/text equality and
numerical differences are distinct observations.

Interpretation remains conditional:

- Producer change alters output on a fixed consumer: frontend feature bytes
  influence output for that sample, provided controls pass.
- Both consumers agree on each fixed feature source, while outputs follow its
  producer: evidence supports the frontend as sufficient to explain this
  observed transcript difference, not a specific math function or compiler bug.
- Consumers differ on identical features: a downstream difference remains,
  including positional encoding/graph/CTC/detokenization; not automatically ggml.
- Both effects or failed controls: report mixed or inconclusive evidence.

No reference scoring, best-build ranking, latency approval or model promotion.
The original Windows mixed/medium quality failure remains until independently
qualified changes pass all required gates.

## Verification and completion

Test-first contracts cover strict source extraction, exact selection, canonical
feature/PCM sizes, finite values, hash/identity changes, complete attempt matrix,
failed deliveries, repeat instability, historical mismatch, own-replay control
failure and each conditional interpretation above. Native extractor build/smoke
and bounded runner lifecycle checks execute only in Actions before real replay.
Retain reports on measured failure; incomplete evidence is a surfaced error.

Record exact run/commit/artifact IDs and causal limits in this spec and
`scripts/VOICE-DEPLOYMENT.txt`. Stop at the bounded result rather than selecting
another compiler/option until transcripts improve. Any product change requires
a separately justified design and full qualification, not this diagnostic subset.

All builds, audio processing, inference and verification remain in Actions.
PROD, cpg's1.5GiB limit, the old sampler and live services remain unchanged.
