# Sense Feature Exchange Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Locate observed cross-platform differences relative to the existing native feature-input boundary.

**Architecture:** Build a pinned-source frontend extractor on each platform, validate and exchange its PCM/features, then replay both producers through unchanged installed engines. Require same-platform and historical controls before interpreting producer/consumer interventions.

**Tech Stack:** Python unittest, standalone C++17, Node installer, GitHub Actions Ubuntu/Windows.

---

Written spec375b989 approved for inline execution. All commands below execute in
Actions, never locally. No subagents, new product interfaces or resource caps.

## Execution checkpoint

The new session verified the prior written-spec approval and preserved both
uncommitted implementation files before continuing. No old process was resumed.
Red contract run36000009792 at6546cd6 failed for the missing data module.
Run36000736020 at914af74 passed the data/report cases and failed for the missing
process runner. Implementationba9cd71 passed run36001140133; expanded raw-output
and aggregate-provenance contracts ate8f10c7 passed run36001243394.
Real extraction/exchange run36001303004 ate8f10c7 passed Linux extraction but
stopped before any replay: Windows Git Bash tar could not create unrelated
upstream symlinks. The workflow now extracts only the four required source/
license members, preserving their bytes. Corrected run36001871106 at
a07d091d1e755081e4e1d0433090823a5132455b passed all six jobs: nine contracts,
both native extractor builds, three lifecycle contracts on each consumer, and
216/216 native deliveries. All repetition, own-replay and historical controls
passed. PCM bytes match on all12 samples; features differ on all12. Exactly
test-00949 and test-01056 follow the feature producer on either consumer, while
identical feature bytes give identical text across consumers. The other10
transcripts are unchanged. This completes the bounded experiment, not Windows
quality or product qualification. Final artifact identities and causal limits
are recorded in the spec and scripts/VOICE-DEPLOYMENT.txt.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| `scripts/voice_feature_data.py` | Strict pinned block extraction, C++ generator, WAV/feature/PCM validation |
| `scripts/voice_feature_process.py` | CI-only bounded native argument runner, process groups/Windows Job helper |
| `scripts/voice_feature_report.py` | Exact216 matrix, controls and conditional interpretation |
| `scripts/voice_feature_exchange.py` | Preparation, extraction, installed replay and report CLI |
| `scripts/test_voice_feature_exchange.py` | Data/source/report contracts with synthetic inputs |
| `scripts/test_voice_feature_process.py` | Bounded process success/failure/timeout/overflow and descendant cleanup |
| `.github/workflows/voice-feature-exchange.yml` | Contracts, two producer jobs, two consumer jobs, aggregate |

## Task 1: Red contracts

- [x] Add binary validation tests using canonical WAV16k mono16-bit and:

```python
frames = 16000
t = (((frames - 400) // 160 + 1) + 5) // 6
feature = struct.pack("<ii", t, 560) + struct.pack("<f", 1.0) * (t * 560)
validate_feature(feature, frames)
```

  Reject huge/negative dimensions before allocation, wrong width, trailing or
  missing bytes, NaN/Infinity and invalid PCM lengths. WAV checks exact canonical
  header, RIFF/data sizes, finite bounds and frame count.
- [x] Source extraction tests require exactly one start/end anchor, preserve the
  original block verbatim and reject missing/duplicate anchors.
- [x] Synthetic12x3x3x2 attempts exercise missing/duplicate tuples, changed hashes,
  negative/nonfinite timing, failed/empty output, unstable repeats, historical
  mismatch and own-feature replay mismatch. Require explicit classifications
  for frontend-sufficient, downstream, mixed, unchanged and invalid-controls.
- [x] Register push contracts, commit/push and inspect expected missing-module
  failure with `gh run view RUN -R xujxu/agents-chat --log-failed`.

## Task 2: Data validation and extractor

- [x] Implement `extract_block(source)` using unique byte anchors from pinned
  upstream `static const int FS=16000` through `struct cfg {`. Require the block
  ends in the original `T_out=Tl; return out;` function closure.
- [x] Generate standalone source with original header includes and feature
  block, plus a main accepting `WAV PCM FEATURE`. Require x64 little-endian
  IEEE754float32,400<=N<=480000, finite samples/features and complete writes.
  Write PCM f32 and feature int32T/int32F560/f32 payload without formula changes.
- [x] Generate CMake project: C++17, Release, MSVC static runtime, Windows UTF8
  manifest and NOMINMAX/_USE_MATH_DEFINES. Linux compiler GCC12 in Ubuntu22.04.
  Retain CMakeCache, verbose build log, compiler ID/version, source/block/header/
  binary/archive hashes; generated source may be retained, no upstream archive.
- [x] Implement bounded `validate_wav`, `validate_pcm`, `validate_feature` and
  `numeric_difference`. Validate exact lengths against trusted WAV frames,
  finite values and little-endian layout; compare hashes, changed count, max
  absolute and RMS differences without an invented tolerance threshold.

## Task 3: Supervised native runner

- [x] CI Python runner `run_native(binary, args, helper=None, timeout=120)`:
  Linux `start_new_session=True`, sanitized locale/PATH, group termination.
  Windows starts existing helper with deadline and binary args, sanitized
  SystemRoot/TEMP environment, control stdin PIPE. Keep stdin open until
  completion; close on timeout/overflow, wait6seconds then kill only owned helper.
  Concurrent bounded pipe readers drain stdout<=32768 and Linux stderr<=65536
  (Windows helper stderr<=256). Reject invalid UTF8, NUL/empty stdout and nonzero
  exit explicitly. Never log transcript or engine diagnostics.
- [x] On exit or cancellation, reap the child and ensure owned descendants are
  terminated before returning. Recognize Windows124 only with exact helper
  timeout sentinel. Parent timeout/overflow remain explicit failures.
- [x] Add subprocess contracts: UTF8 success, empty/invalid/oversize stdout,
  nonzero exit, timeout and child spawning a sleeping descendant. For Windows
  use verified existing helper downloaded in the consumer job. Fail cleanup
  contracts instead of proceeding to real replay.

## Task 4: Orchestration and report

- [x] `prepare` rebuilds frozen100 via existing script and compares the selected12
  exactly with retained diagnostic artifact. Copy only12WAVs plus attribution.
  `generate` creates extractor sources from pinned input. `extract` invokes it
  sequentially with bounded timeout, validates all files and writes manifest
  with PCM/feature hashes and trusted frame counts before upload.
- [x] Consumer validates BOTH entire producer artifacts before launching models,
  including identical selected identities/WAV bytes and all file hashes/sizes.
  Configures the original trusted package with actual CLI, threads2:

```text
node scripts/configure-voice.mjs --project-dir CHECKOUT --model sensevoice-small-q8
  --package-dir PACKAGE --manifest-sha256 SHA --threads 2 --non-interactive
```

  Read actual voice values using a bounded native Node ESM child; verify binary/
  model/helper role hashes. Do not pass inherited VOICE overrides to installer.
- [x] For repetitions1/2/3, sorted sample IDs, input sources `wav/linux/win32`,
  invoke existing engine with `-a` for WAV or `-f` for preflight features:

```python
args = ["-m", model, "-a" if source == "wav" else "-f", input_file,
        "--threads", "2", "--backend", "cpu"]
```

  Record attempt immediately with consumer, sample identity, package hashes,
  input hash, source, repetition, failure/text and elapsed seconds. Write108
  completion marker only after all attempts. No silent WAV fallback.
- [x] Aggregate checks exact216 tuples and matching producer/package/history
  identities. For each sample, require repeatability, own-feature/native
  equality and historical equality for both consumers before classification.
  Write JSON/Markdown and numerical comparisons before returning exit1 for any
  failed control or delivery. Missing evidence raises as infrastructure failure.
  Include the full invalid sample list; never imply global attribution from a
  control-passing subset. Raw numerical evidence is separate from text inference.

## Task 5: Workflow, execution and evidence

- [x] Contracts on push; expensive jobs only on workflow_dispatch. Producers
  Ubuntu24.04/Windows2022 fetch pinned source and corpora, generate, compile and
  extract. Linux docker Ubuntu22.04 installs GCC12/CMake only in Actions.
  Consumers wait for both producer artifacts, download their unchanged package
  and retained history, validate, run lifecycle contracts, replay108 attempts.
  Aggregate downloads both producers/consumers and history; reports even on
  measured failures. No weights/config/receipts/secrets in uploads, retention30d.
- [x] Commit/push, wait for red then green contracts, dispatch:

```bash
gh workflow run voice-feature-exchange.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

- [x] Inspect failed infrastructure remotely, fix and push if needed. Complete
  control failures are valid results, not grounds to adjust extraction formulas
  until text improves. Update spec/ledger/plan with exact IDs and limits, commit/
  push evidence, stop progress reminder. Windows quality gate remains open.
