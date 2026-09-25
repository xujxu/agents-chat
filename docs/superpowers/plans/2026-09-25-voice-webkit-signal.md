# Retained WebKit Signal Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Describe all eight retained source/upload waveform pairs using fixed-offset and segment-offset diagnostics, without new inference.

**Architecture:** A NumPy-only signal helper computes unaligned statistics and FFT/prefix-sum normalized correlation one pair at a time. A focused evidence entry point reuses historical artifact and browser integrity checks, joins the previous eight-row decomposition and writes a small attributed report. Actions runs synthetic contracts before a manual historical-data job.

**Tech Stack:** Python3.12, NumPy2.2.6, existing OpenCC0.1.7 and unittest, GitHub Actions.

---

Approved spec `0bc59dd`; user selected inline execution. The named execution
skill is unavailable; use the explicit inline checkpoints here, without agents.
All tests, hashing, waveform arithmetic and analysis execute only in Actions.
No local server, dependency installation, inference or audio transformation.

## File ownership and interfaces

- `scripts/voice_signal_metrics.py`: pure helpers `signal_stats(pcm)`,
  `alignment(x,y,minimum_lag=-16000,maximum_lag=16000,full_window=False)`,
  `compare_signals(source_pcm,upload_pcm)`. Input PCM arrays are signed16bit;
  alignment input arrays are float64 normalized by32768.
- `scripts/voice_webkit_signal.py`: fixed source/measurement/decomposition
  identities, strict selected-pair loader, report generation and Actions CLI.
- `scripts/test_voice_signal_metrics.py`: synthetic algorithm contracts.
- `scripts/test_voice_signal_evidence.py`: exact eight-row join and historical
  provenance contracts.
- `scripts/voice_webkit_evidence.py`: surgical extraction of the existing
  archive download mechanism into a reusable fixed-input helper. Preserve
  existing default arguments and all historical evidence checks.
- `.github/workflows/voice-webkit-signal.yml`: contracts plus manual analysis.
- Phase spec, preceding error-analysis spec and deployment ledger: conclusions.

Do not modify product code, measured implementation fingerprints, old scores or
the browser/error-analysis workflows.

## Task 1: Algorithm red contracts

- [ ] Add seeded synthetic tests before implementing the helper:

```python
source = np.random.default_rng(17).normal(0, .1, 80000)
upload = np.concatenate((np.zeros(1234), source, np.zeros(100)))
result = alignment(source, upload)
self.assertEqual(result["lag_samples"], 1234)
self.assertAlmostEqual(result["correlation"], 1)
```

Also test negative lag, negative gain plus DC, zero variance, periodic ambiguous
peaks, exact search endpoint, minimum overlap, independent noise/weak matching,
rail counts, zero dBFS representation,10ms threshold equality and remainders.
Test known inserted/deleted segments shifting late windows relative to early
windows, local full-window constraints and unchanged input arrays.

- [ ] Create contracts-only push workflow installing
`numpy==2.2.6 opencc-python-reimplemented==0.1.7` in Actions.

```sh
python -m unittest discover -s scripts -p 'test_voice_signal_*.py' -v
python -m unittest discover -s scripts -p 'test_voice_webkit_*.py' -v
python -m unittest discover -s scripts -p 'test_voice_browser_*.py' -v
```

- [ ] Commit/push and inspect the expected missing `voice_signal_metrics`
failure before implementing the helper.

## Task 2: Fixed numeric implementation

- [ ] Implement PCM validation and full-signal stats. Use float64 conversion,
nonoverlapping160sample RMS frames and fixed-60/-50/-40dBFS levels; include all
low-energy intervals, leading/trailing durations and discarded partial-frame
size. Return null dBFS for zero with an explicit flag. Preserve rail statistics.

```python
values = pcm.astype(np.float64) / 32768
frames = values[:len(values) // 160 * 160].reshape(-1, 160)
frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
```

- [ ] Implement full correlation using FFT with enough padding to avoid circular
aliasing, and vectorized prefix sums for each candidate overlap:

```python
start = np.maximum(0, -lags)
end = np.minimum(len(x), len(y) - lags)
count = end - start
cross = np.fft.irfft(np.fft.rfft(y, nfft) * np.conj(np.fft.rfft(x, nfft)), nfft)
dot = cross[lags % nfft]
covariance = dot - sum_x * sum_y / count
```

`nfft` is the next power of two at least`len(x)+len(y)-1`.
`sum_x`, `sum_y` and squared energies come from prefix-sum interval differences.
Discard insufficient-overlap/variance candidates before dividing. Full-window
mode requires count==len(x). Correlation clamp applies only to floating error;
gross out-of-range/nonfinite values fail explicitly.

- [ ] Select maximum absolute correlation with exact tie order(abs lag,lag).
Return raw signed peak and best alternative outside160samples, weakness<.8,
ambiguity gap<.05, search boundary and reliable status. No candidate returns
explicit unavailable metrics/reason, not zero.
- [ ] Calculate raw-amplitude overlap residual/RMS ratio and centered gain
estimate. Preserve unmatched source/upload prefixes/suffixes and full coverage.
Do not synthesize compared padding or normalize residual amplitudes.
- [ ] Implement1second windows centered at20/50/80%of source duration.
Translate local correlation lag to global coordinates using source window
start; clip candidate global lags to+-16000and global selected+-1600. Report
local energy/flags and conditional status; compute last-minus-first only if
every required match is reliable and above-60dBFS. Test correct translation
with inserted/deleted segments and no mutation of inputs.

## Task 3: Strict evidence joins and output

- [ ] Reuse existing archive digest verification/extraction and
`load_platform(..., SOURCE_RUN, SOURCE_COMMIT, CASE)` unchanged. Allow the shared
downloader to receive an explicit fixed mapping/commit map while preserving its
existing defaults; extend metadata contracts for nondefault historical commits.
- [ ] Add `load_pairs(inputs)` yielding selected metadata and validated source/
upload PCM arrays one sample at a time. Require exact eight IDs, original
manifest identities, historical error-analysis status/source/analysis identity,
source/upload hashes and canonical WAV lengths/durations.
Use existing bounded WAV parser/read helpers and existing source selection
rules; reject missing, extra, duplicate or corrupted data.
- [ ] Test the pair join with synthetic manifests/PCM and patched historical
browser loader, plus existing unpatched browser artifact corruption contracts.
Include changed original audio, changed upload identity, missing/duplicate IDs,
wrong source run and wrong decomposition commit.
- [ ] Emit`summary.json`,`samples.json`,`REPORT.md`,`ASCEND-ATTRIBUTION.txt`.
Include source/decomposition/new-analysis provenance, original signed error
contributions, method constants and NumPy/Python versions. Keep transcripts and
audio out of output. Fail input/algorithm errors explicitly with a failure JSON.
Weak/ambiguous matches are completed diagnostic outcomes, not failures hidden
by retries.

## Task 4: Actions execution and persistent evidence

- [ ] Add manual analysis job depending on all contracts:

```sh
python scripts/voice_webkit_signal.py inputs signal-report
```

Only three pinned artifacts from the spec are downloaded. No model, browser,
server, transcription or build command. Process one pair at a time; upload
derived reports30days even on failure. Record exact archive/file digests.
- [ ] Push, inspect all contracts, and dispatch the manual job. Inspect actual
eight-pair coverage, unaligned metrics, sign conventions, selected lags, flags,
local windows and explicit uncertainty. Never widen bounds after seeing data.
- [ ] Record numerical findings, uncertainty and the smallest justified
follow-up in the approved signal spec, prior error-analysis spec and
`scripts/VOICE-DEPLOYMENT.txt`. Preserve all failed acceptance gates.
- [ ] Commit/push evidence with the required coauthor trailer, stop progress
reminder and close tracking. No product or causal fix is claimed.

## Self-review

All fixed input IDs/digests and eight controls remain intact. Numeric policy
matches the approved spec, including signed lags, full-signal metrics before
overlap metrics, explicit invalid/uncertain outcomes and no transformed audio.
Synthetic algorithm contracts and historical provenance contracts are separate.
