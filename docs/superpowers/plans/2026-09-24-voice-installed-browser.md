# Installed Sense Browser Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure actual installed Sense through controlled browser capture without weakening existing gates.

**Architecture:** Collect original/API and browser/API pairs on each platform. Validate source/upload identities, replay captured bytes with the pinned ONNX baseline, and report primary end-to-end gates separately from same-byte diagnostics.

**Tech Stack:** Playwright/TypeScript, Python unittest, existing Node installer, GitHub Actions.

---

Spec4e80528 approved for inline execution. No subagents or local validation.
Run every test/build/server/audio/model command below in Actions only.

## Completed execution checkpoint

Spec4e80528, plan/red24034ce. Run36003951932 failed as expected for the missing
report module. Reporte40bd7b passed36004124645. Capture test-first6968c5a failed
36004316002 for the missing helper. Implementationfb80f5d passed report/types/
build and14fixture tests in36004719332 but its missing-UI fixture did not block
React's defaultValue path. Corrected fixture97977de observes the same production
code and injects the intended failure before React mounts.

Full run36007108166 at97977de37eb7eda0675a893eed516d90b11515fa completed400/400
API deliveries and200/200same-upload ONNX diagnostics. Eight report/evidence
contracts and15fixture checks passed (two explicitly native-fixture-only skips),
including both actual platform jobs. Linux and Windows browser paths passed
all frozen gates. Windows direct mixed/medium remained16.8889% versus16.6667%
ceiling; the report intentionally returned exit1 for this measured failure.
No infrastructure failure, partial corpus, selective retry or tuned correction.

Browser stop-to-composer short/long P95:Linux0.3462/1.7280s,
WindowsServer0.8443/4.3443s. Windows browser success does not supersede the failed
direct-input gate. Exact evidence/artifact IDs and interpretation limits are in
the spec and deployment ledger. The bounded experiment is complete; realWin11,
physical microphone, other-browser corpus and release qualification remain open.

## Files and contracts

| File | Responsibility |
| --- | --- |
| `scripts/voice_browser_report.py` | Pure source-stimulus gates and same-upload diagnostics |
| `scripts/voice_browser_evidence.py` | Artifact/provenance validation and report CLI |
| `scripts/voice_browser_baseline.py` | Fixed ONNX replay of recorded uploads |
| `scripts/test_voice_browser_report.py` | Synthetic matrix, failure and non-promotion contracts |
| `tests/helpers/voiceBrowserCapture.ts` | Test-only stream/stop/fetch/composer observations |
| `tests/voice-browser-capture.spec.ts` | Observational collector fixture contracts |
| `tests/voice-installed-browser.spec.ts` | Actual100-sample,200-attempt installed collector |
| `scripts/voice/installed-api-run.mjs` | Preserve direct mode; explicit browser collector mode |
| `.github/workflows/voice-installed-browser.yml` | Contracts, two collectors, baseline, report |

Each collected row retains the complete original sample fields plus `platform`,
`pipeline` (`direct`/`browser`), delivered `text`, separate `apiText`, `failure`,
`seconds` (null only when no valid stop exists), HTTP `status`, `apiElapsedMs`,
`uploadedAudioSha256`, `uploadedDuration`, `timing`, and `capture`.
Successful browser timing carries stopAt/workletStopAt/fetchAt/bodyAt/composerAt/
terminalAt and stopKind. `capture` carries source/recorder rates and source
completion. Millisecond timestamps use one browser monotonic clock.
Baseline rows retain platform/id, uploadedAudioSha256, text/failure, seconds and
an explicit unavailable-input status when no valid captured bytes exist.

## Task1: Red report contracts

- [x] Add a synthetic frozen100 fixture with60ASCEND/40AISHELL-4;50short,
  10medium and40long original durations. Build both platform/path matrices:

```python
rows = [{**sample, "platform": platform, "pipeline": pipeline,
         "text": sample["reference"], "apiText": sample["reference"],
         "failure": None, "seconds": 1.0, "status": 200, "apiElapsedMs": 500,
         "uploadedAudioSha256": sample["audio_sha256"], "uploadedDuration": sample["duration"],
         "timing": None, "capture": None}
        for platform in ("linux", "win32") for sample in samples
        for pipeline in ("direct", "browser")]
```

  Browser fixture rows then receive valid ordered timing and capture metadata.
  Assert400exact attempts,100deliveries in each cell,8quality groups per cell,
  unchanged original-duration grouping, and no release approval.
- [x] Reject missing/duplicate/unexpected tuples, source/ref/package changes,
  invalid hashes, invalid successful HTTP/text/UI metadata and negative/NaN
  timing. Preserve capture failures, UI failure with successful apiText and
  null stop latency. Require original-baseline failure even if captured-byte
  baseline performs worse. Retain explicit unavailable diagnostic tuples.
- [x] Register Python contracts on push; commit/push and inspect red:

```bash
python -m unittest discover -s scripts -p test_voice_browser_report.py -v
```

  Expected first failure: missing voice_browser_report module.

## Task2: Report implementation and evidence boundaries

- [x] Implement `browser_report(samples, rows, original, baseline)` with exact
  product coverage and separate source/upload identities:

```python
expected = {(platform, sample["id"], pipeline)
            for platform in ("linux", "win32") for sample in samples
            for pipeline in ("direct", "browser")}
indexed = {(r["platform"], r["id"], r["pipeline"]): r for r in rows}
if len(indexed) != len(rows) or set(indexed) != expected:
    raise ValueError("Incomplete, duplicate or unexpected browser matrix")
```

  Reuse `evaluate`, `band` and `p95`. Compute failure-inclusive original-source
  bucket scores,100%delivery,+0.02quality and aggregate3/5second limits.
  Null stop latencies make that band's primary timing incomplete, never zero.
  Report successful-only timing and same-byte baseline as diagnostic only.
  No winner or promotion field may imply release approval.
- [x] Evidence CLI validates exact sample manifests, package role hashes,
  complete200-per-platform markers, captured WAV hash/format/size/duration and
  baseline input joins before reporting. Write JSON/Markdown before returning
  measured-failure exit1; invalid/missing provenance raises separately.
- [x] Push and require green Python contracts in Actions before real collection.

## Task3: Observational recorder helper and fixture coverage

- [x] Implement `installBrowserCapture(page)` using `page.addInitScript`.
  Supply48kMediaStream only at getUserMedia. Observe the genuine native worklet
  port without manufacturing events:

```typescript
const original = this.port.postMessage.bind(this.port);
this.port.postMessage = (message: unknown, transfer: Transferable[] = []) => {
  if (message === 'stop') recordWorkletStop(performance.now());
  original(message, transfer);
};
```

  `recordWorkletStop` updates the active capture's workletStopAt and, absent
  manual click intent, stopAt/stopKind. Manual stop is observed in a capture
  phase document click listener, before the React callback.
- [x] Start source playback after the real UI enters recording. Keep100ms
  post-source scheduling margin from the existing harness, without extending
  the product30s cap. Observe source completion at track cleanup; preserve
  incomplete/truncated capture as failure rather than replaying.
- [x] Dispatch original fetch first, then copy Blob bytes and clone response
  asynchronously. Observe composer via animation-frame reads; record its first
  nonempty value and timestamp. Preserve original response and argument behavior.
  Expose typed per-sample arm/play/snapshot helpers; keep private browser state
  bounded to one sample and dispose owned source contexts/tracks.
- [x] Fixture tests exercise success and exact payload, stop/HTTP/UI ordering,
  auto-stop, API500, missing UI text, timeout and cleanup. Use real product
  recorder but stub fixture transcription only in these fixture tests.
  Check all source tracks and contexts close; clear each trial before the next.

## Task4: Installed paired collector and supervision

- [x] Add `voice-installed-browser.spec.ts` gated by
  `INSTALLED_BROWSER_ACCEPTANCE=1`. Validate100original identities and real
  Sense capabilities. For sorted IDs, direct post first, then browser UI.
  Initialize an empty composer and persist each terminal tuple immediately:

```typescript
await appendFile('installed-browser-evidence/results.jsonl',
  JSON.stringify(row) + '\n');
```

  Record400total attempts across platforms with no retries, exact captured WAVs
  under `captured/<id>.wav`, per-sample source/upload metadata, and completion
  only after all200local tuples. On capture/API/UI failure retain failure,
  recovered UI and cleanup evidence; unrecoverable instrumentation stops.
- [x] Extend the existing runner with an explicitly validated optional
  `browser` mode. Existing two-argument direct behavior stays unchanged.
  Browser mode selects the new spec/env/evidence folder and larger real-time
  deadline. Keep server logs outside uploaded evidence. Preserve actual
  installation, readiness, owned server cleanup and temp-directory leak checks.
  Add actual installed-role hash and browser/version provenance.
- [x] Explicitly typecheck excluded test collectors and run focused fixture
  regressions and build in Actions:

```bash
npx tsc --noEmit --strict --skipLibCheck --esModuleInterop --target ES2017 --lib dom,dom.iterable,esnext --module esnext --moduleResolution bundler --jsx react-jsx tests/voice-installed-browser.spec.ts tests/voice-browser-capture.spec.ts
npm run build
```

## Task5: Baseline replay and Actions execution

- [x] Reuse frozen runtime/model archive URLs and hashes from the spec; no
  altered language/hotwords/VAD. For every browser tuple, verify the actual
  captured file and then run the same arguments as `command("sense", sample)`
  in `voice_accuracy_benchmark.py`, with2threads and120s owned-tree deadline.
  Parse one valid native text result with bounded output. Emit unavailable
  input or explicit inference failure for every missing/failed diagnostic.
  Retain baseline role hashes, source upload hash, command and environment.
- [x] Workflow: fast push contracts; manual expensive jobs only. Two platform
  collectors reuse pinned corpora/baselines/packages. Each installs app/Chromium,
  runs fixture/type/build coverage, then real paired100. Linux baseline job
  downloads both captured artifacts and accounts for200diagnostic tuples.
  Aggregate writes primary gates independently of captured baseline success.
  Upload whitelist excludes configs/weights/logs/secrets; retention30days.
- [x] Commit/push and dispatch after green contracts:

```bash
gh workflow run voice-installed-browser.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

  Inspect Actions logs/artifacts only. Measured failure is a valid completed
  experiment, not grounds for tuning. Infrastructure fixes retain failed run
  identities and do not selectively replace samples.
- [x] Persist run/commit/artifact IDs, numerical gates, limits and open Win11/
  physical-microphone/browser/release gates in the spec and deployment ledger.
  Commit/push final evidence and stop the progress reminder.
