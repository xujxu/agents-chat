# Controlled Audio Graph Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run and retain a fixed 36-recording, no-ASR passive boundary probe.

**Architecture:** Keep historical/product code unchanged. Independent browser
hooks copy original buffers; a fixture receiver checks the actual upload.
Python validates binary evidence and computes predeclared descriptive metrics.

**Tech Stack:** Playwright/TypeScript, Next.js fixture server, Python 3.12,
NumPy 2.2.6, GitHub Actions Ubuntu 24.04.

---

The user approved the specification and inline execution. The execution skills
named in the standard header are unavailable in this session; use inline
checkpoints, no subagents. No local validation commands are authorized.
Specification: `docs/superpowers/specs/2026-09-25-voice-audio-graph-probe-design.md`.

## File boundaries

- `tests/helpers/voiceGraphStimuli.ts`: deterministic WAV generation and schedule.
- `tests/helpers/voiceGraphProbe.ts`: browser-only passive hooks, typed snapshots.
- `tests/helpers/voiceGraphCollector.ts`: HTTP fixture, evidence serialization,
  environment/code identity and attempt cleanup.
- `tests/voice-audio-graph.spec.ts`: generator/hook/browser contracts and fixed
  schedule, enabled for measurement only with `VOICE_GRAPH_MEASURE=1`.
- `tests/playwright.voice-graph.config.ts`: reuse existing Chromium/iPhone
  project settings; narrow specs; one worker and zero retries.
- `scripts/voice_graph_metrics.py`: raw statistics, frequency fits, weighted
  envelope, reliable markers and exact PCM quantization.
- `scripts/voice_graph_evidence.py`: fixed attempt coverage and hash/shape checks.
- `scripts/voice_graph_report.py`: analysis, paired reports and CLI failure status.
- `scripts/test_voice_graph_metrics.py` and
  `scripts/test_voice_graph_evidence.py`: synthetic contracts.
- `.github/workflows/voice-audio-graph.yml`: red/green contracts, build/typecheck,
  browser regressions, manual measurement and retained artifacts.
- Approved spec, this plan and `scripts/VOICE-DEPLOYMENT.txt`: results only.

## Task 1: Test-first numerical/evidence contracts

- [x] Add synthetic tests importing the absent metrics/evidence modules.
  Establish weighted 44.1 kHz bins, known sinusoid amplitude/DC, marker offset,
  uncertainty and independent signed quantization before implementation:

```python
def test_pcm_rounding(self):
    values = np.array([-1, -.5, 0, .5, 1], dtype=np.float32)
    self.assertEqual(quantize(values).tolist(), [-32768, -16384, 0, 16384, 32767])

def test_fractional_envelope(self):
    result = envelope(np.ones(4410), 44100)
    np.testing.assert_allclose(result, np.ones(100), atol=1e-12)
```

- [x] Add push-triggered workflow contracts:

```yaml
- uses: actions/setup-python@v5
  with:
    python-version: '3.12'
- run: pip install numpy==2.2.6
- run: python -m unittest discover -s scripts -p 'test_voice_graph_*.py' -v
```

- [x] Commit/push; inspect the exact missing-module red result through
  `gh run list -R xujxu/agents-chat --workflow voice-audio-graph.yml`.
  No local Python execution.

## Task 2: Pure analysis and strict evidence

- [x] Implement exact PCM quantization without using the product encoder:

```python
def quantize(values):
    values = finite(values)
    bounded = np.clip(values, -1, 1)
    return np.floor(bounded * np.where(bounded < 0, 32768, 32767) + .5).astype("<i2")
```

- [x] Implement 1 ms envelopes using an integral over squared piecewise-constant
  sample intervals, evaluated at each bin edge. For tone fit, form a matrix of
  sin/cos columns at the fixed frequencies plus ones, then use
  `np.linalg.lstsq(..., rcond=None)` on stage seconds 3-5.
- [x] Implement positive normalized marker correlation with the approved
  +/-1000-bin search, >10-bin alternative exclusion, .8/.05 flags and explicit
  missing/zero/boundary reasons. Retain each reliable interval separately.
- [x] Read float32 planar little-endian arrays and canonical PCM16 WAVs,
  requiring matching SHA256, dimensions, byte counts and finite values.
  Enforce exact 36 identities, correct mode-specific boundaries and fixed
  stimulus hashes across repeats/browsers.
- [x] Keep C-D comparison and E-F quantization mismatch as valid findings.
  Treat corrupt files, receiver disagreement and hook failures as evidence
  errors. Preserve report output before CLI exit 1.
- [x] Add negative contracts for traversal, hash corruption, duplicate IDs,
  missing records, nonfinite input and missing full-arm boundaries.

## Task 3: Browser stimuli and passive observation

- [x] Implement fixed generator with unsigned xorshift:

```typescript
let state = seed >>> 0;
function bit(): number {
  state = (state ^ (state << 13)) >>> 0;
  state = (state ^ (state >>> 17)) >>> 0;
  state = (state ^ (state << 5)) >>> 0;
  return state & 1;
}
```

- [x] Generate the exact mono tones, amplitude-coded markers and stereo tones
  from the specification. Write independent header/interleave/value assertions.
- [x] Install original source helper and extra hooks in one ordered init script
  sequence; avoid Playwright's unspecified order across separate init scripts
  by making the extra hook initializer explicit after navigation, before arming.
  Instrument prototype methods for decode, source start and offline render;
  wrap the existing AudioWorkletNode constructor without losing its old behavior.
- [x] Copy B from the actual decoded buffer; C from additional port listeners;
  D from actual offline source start; E from the original rendering promise.
  Use Float32Array copies; never transfer product buffers.
- [x] Retain ordered forwarding events and native failures. Add
  browser contracts for exact promise identity and native invalid start errors.
  Observe rather than replace production message handlers.
- [x] Serialize each channel as bounded base64 little-endian bytes; remove
  large buffers from JSON metadata and release the page at the end.

## Task 4: Fixture collection, regression and schedule

- [x] Create an independent Node HTTP receiver using explicit CORS and a
  960044-byte limit. Route POST to it, GET to the fixture capability response.
  Return literal fixture text and require exact upload-byte/composer checks.
- [x] Each attempt uses a fresh browser context with project settings through the
  Playwright page fixture, installs chat/source fixtures, logs in, arms input,
  starts the real voice UI, plays source and stops at duration+100 ms.
  Preserve attempt JSON in `finally` including error and snapshot when present.
- [x] Full mode collects A-F; minimal collects only A/F. Write unique attempt
  directories by project/stimulus/repetition/mode, never overwrite old attempts.
- [x] Define sequential predeclared minimal/full, full/minimal, minimal/full pairs,
  with each recording its own test and fresh page. Playwright continues other
  tests on failure; report identifies absent records explicitly.
- [x] Add probe browser contract recording separate from the 36 measurements.
  Use the same runtime hooks and verify C-D equality, E-F equality downstream.
  Keep contract evidence out of the measured schedule.
- [x] Derive narrow projects from existing config:

```typescript
export default defineConfig({
  ...base, fullyParallel: false, retries: 0, workers: 1,
  projects: base.projects!.filter(p =>
    ['desktop-chromium', 'iphone-webkit'].includes(p.name!)).map(p => ({
      ...p, testIgnore: [],
      testMatch: ['**/voice-audio-graph.spec.ts', '**/voice-input.spec.ts',
        '**/voice-browser-capture.spec.ts'],
    })),
});
```

## Task 5: Actions-only validation and measurement

- [x] Expand the workflow after the intended red result. Contracts run on push;
  browser validation depends on them. Use Node 24.20.0, `npm ci`, pinned Python
  dependencies and `playwright install --with-deps chromium webkit`.
- [x] Run build and full app typecheck, plus explicit strict typecheck of the
  test config/spec (the app's tsconfig excludes tests).
- [x] Start the Next fixture in Actions on 3011 with existing isolated fixture
  credentials. Readiness checks process liveness and `/api/auth/providers`;
  EXIT trap kills only the captured server PID. Never upload private server logs.
- [x] Run contracts/voice regressions before the fixed schedule. On manual
  dispatch, enable `VOICE_GRAPH_MEASURE=1` and run only probe recordings.
  Write evidence even on failure and run analysis with `if: always()` only when
  collection was attempted. Upload evidence and separate small reports.
- [x] Inspect Actions failures; fix only proven infrastructure defects.
  Do not retry selected stimuli, alter thresholds or add graph taps.
  After green checks:

```bash
gh workflow run voice-audio-graph.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
gh run list -R xujxu/agents-chat --workflow voice-audio-graph.yml --limit 5
```

## Task 6: Persistent results

- [x] Download only summary/attempt/report JSON/Markdown locally. Review all
  36 attempts, all flags and all 18 pairs. Separate evidence success from acoustic
  differences and observer uncertainty.
- [x] Append run/commit/artifact IDs/digests/expiration and bounded conclusions
  to the approved spec and deployment ledger; mark this plan's completed steps.
- [x] Commit/push with the Copilot trailer, verify clean worktree, stop reminder
  #7 and complete session todos. No product acceptance promotion.

## Self-review

Coverage: tasks 1-2 cover fixed metrics/evidence, task 3 covers forwarding and
non-mutation, task 4 covers fixture and fixed matrix, task 5 covers Actions-only
validation, task 6 covers durable evidence. No stage adds a tap or changes rates.
The extra hooks activate after the old init script has executed but before
recording; this resolves constructor composition ordering without editing the
historical helper.

## Execution checkpoints

- `3f2e15d`: plan and red contracts; Actions `36095410734` failed solely because
  the two intended implementation modules did not yet exist.
- `d541c86`: initial implementation; Actions `36099042121` passed.
- `7d94ab8`: decoded-buffer identity, track metadata, event/provenance checks,
  partial evidence retention and expanded synthetic contracts.
- `004535c`: explicit corrupt/missing-report handling and readable stage table.
  Actions `36099253859` passed numerical contracts, inherited signal contracts,
  build, app/test type checks and Chromium/WebKit voice regressions.
- Manual fixed measurement dispatched as `36099685493` at `004535c`.
  It failed preflight on an empty WebKit receiver body; no measured attempts ran.
- Retained-byte inspection `36100233494` confirmed a 272926-byte Blob versus
  zero received bytes. Fixture-only `8e15b60` removes POST protocol URL rewriting,
  forwards the original Blob directly to loopback, blocks real API POST and
  retains byte-equality checks. No historical helper or product edits.
- `36100708842` at `8e15b60` passed preflight and all 36 fixed attempts.
  Small report reviewed: 18 complete pairs; all C-D/E-F exact checks pass.
  Larger tone-fit/residual and marker differences are already at B-C; paired
  variability precludes a claim of observer non-interference.
- Detailed results/artifact hashes are in the spec and deployment ledger.
  No root-cause or historical-ASR acceptance promotion.
