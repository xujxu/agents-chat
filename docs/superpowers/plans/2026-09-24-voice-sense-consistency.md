# Installed Sense Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose repeatability and layer/thread/platform output differences for existing Sense packages without changing qualification policy.

**Architecture:** Select a deterministic 12-sample subset of the existing frozen100 corpus. On each Actions host, configure the actual package at 2/1/4 threads and run three repetitions through supervised stdout, transcriber and authenticated API. Strict reporting accounts for all 324 attempts per host and compares historical evidence without selecting a new model/configuration.

**Tech Stack:** Python unittest, Node ESM, TypeScript, Playwright, Next.js, GitHub Actions.

---

Approved spec: `docs/superpowers/specs/2026-09-24-voice-sense-consistency-design.md`.
Continue inline, without subagents. Every validation/build/inference command below
runs in Actions, never on this machine. Preserve PROD/cpg/sampler.

## File map

| File | Responsibility |
| --- | --- |
| `scripts/test_voice_consistency_report.py` | Selection, completeness, invalid evidence, instability and paired-comparison contracts |
| `scripts/voice_consistency_report.py` | Fixed selection, platform evidence validation, aggregate comparisons and CLI |
| `tests/helpers/voiceConsistency.ts` | Persisted configuration, file hashes, native/transcriber collection and private cleanup |
| `tests/voice-consistency.spec.ts` | Sequential three-surface collection with real authenticated API |
| `scripts/voice/consistency-run.mjs` | Actual configurator, per-thread app lifetime and provenance |
| `.github/workflows/voice-consistency.yml` | Red/green contracts, two platform jobs and aggregate evidence |

## Task 1: Red report contracts

- [x] Define synthetic frozen100 with exactly eight mixed/medium rows and the
  four control strata. Call `select_samples(manifest)` and require 12 unique
  rows, order invariance and all eight target IDs. Mutate a duplicate and a
  missing stratum and require `ValueError`.
- [x] Define synthetic 324-row evidence with these exact tuple dimensions:

```python
for threads in (2, 1, 4):
    for repetition in (1, 2, 3):
        for sample in selected:
            for surface in ("native", "transcriber", "api"):
                rows.append({**sample, "platform": "linux", "threads": threads,
                             "repetition": repetition, "surface": surface,
                             "text": "hello", "failure": None, "seconds": .1,
                             "identity": identity, "status": 200 if surface == "api" else None,
                             "apiElapsedMs": 90 if surface == "api" else None,
                             "stdoutBase64": "aGVsbG8K" if surface == "native" else None,
                             "stdoutSha256": hashlib.sha256(b"hello\n").hexdigest()
                             if surface == "native" else None})
```

  `identity` has `manifest`, `binary`, `model`, `helper` hashes; helper is null on
  Linux. Test missing/duplicate tuples, changed audio/package identity, negative/
  nonfinite timing, invalid native bytes/hash, empty success, failed delivery,
  within-surface instability and all-failed comparisons remaining unavailable.
- [x] Register contracts workflow on branch push, commit tests and push. Inspect:

```bash
gh run list -R xujxu/agents-chat --workflow voice-consistency.yml --limit 3
gh run view RUN -R xujxu/agents-chat --log-failed
```

  Expected failure: `ModuleNotFoundError: voice_consistency_report`.

## Task 2: Selection and strict reporting

- [x] Implement `select_samples(manifest)` with target count eight, control
  strata and SHA256 ranking from the spec. Require frozen100 identity and dataset
  counts. CLI `select corpus diagnostics` writes `diagnostics/samples.json`
  before execution, retaining original audio paths in `corpus/audio/`.

```python
rank = lambda row: (hashlib.sha256(
    ("sense-consistency-v1:" + row["id"]).encode()).hexdigest(), row["id"])
```

- [x] Implement `platform_report(samples, rows, identity)` and reject any tuple
  outside the complete Cartesian product. Match every sample reference/category/
  duration/split/dataset/audio hash and every package identity. Require supported
  platform, valid finite timings, bounded canonical base64 and matching stdout
  SHA256/text on successful native attempts. Failures have no text.
- [x] Return explicit `attempts`, `delivered`, failed tuple list, repeatability,
  per-repetition layer pairs and thread pairs. Every comparison records either
  equality of successful text or an unavailable state due to a failed attempt:

```python
equal = None if left["failure"] or right["failure"] else left["text"] == right["text"]
```

  No equality-of-null shortcuts, error-rate scoring or new recommendation.
- [x] Add aggregate CLI to read both platform artifacts, validate their complete
  tuple sets and original selected identity, then compare matching tuples across
  platforms. Validate historical API count/identity/manifest before comparisons
  at thread2. Write JSON and Markdown before returning a failed-delivery exit1.
  Incomplete evidence raises instead of manufacturing a complete report.

## Task 3: Three-surface collector

- [x] Implement focused helper using existing named exports:
  `decodeEnvironment`, `voiceValues`, `voiceConfiguration`, `runVoiceProcess`,
  `decodeVoiceText`, `transcribeVoice`, `createWindowsVoiceDirectory`.
  Read the actual `.env.local` configuration; assert Sense/standard/requested
  threads. Compute installed file hashes once per thread phase, compare declared
  manifest role hashes, and include stable identity with every attempt.
- [x] Native helper creates a private platform-specific directory, writes the
  checked original bytes, calls `runVoiceProcess` with `AbortSignal.timeout(120000)`,
  retains successful raw stdout and decodes it. Always remove its owned directory
  in `finally`. Transcriber surface reuses `transcribeVoice` unchanged.
- [x] Actions-only Playwright spec loads selected samples, verifies SHA/WAV, logs
  in using the existing fixture and asserts real voice capabilities. For each
  repetition/sample run native, transcriber and API sequentially:

```ts
const response = await page.context().request.post('/api/voice', {
  headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local',
    'x-voice-request-id': randomUUID() },
  data: audio, timeout: 130000,
});
```

  Append each row immediately. Recognized voice errors and transport failures
  remain explicit attempts. Auth/configuration/malformed responses stop the
  collector. Check 108 attempts per thread and write its completion marker only
  at the end. Override screenshot/trace/video off; console contains IDs/status/
  durations, not transcripts. Save no browser storage state.

## Task 4: Isolated installed runner and Actions

- [x] Node orchestrator filters inherited VOICE_* keys and restores Linux binary
  execute permission after artifact extraction. Read trusted downloaded manifest
  hash. For each thread2/1/4, invoke actual configurator:

```text
node scripts/configure-voice.mjs --project-dir CHECKOUT
  --model sensevoice-small-q8 --package-dir PACKAGE
  --manifest-sha256 SHA --threads THREADS --non-interactive
```

  Start built Next.js on127.0.0.1:3011, readiness timeout90 attempts. Run the
  diagnostic spec with current expected threads; stop/wait owned app in finally.
  File logs stay local to the Actions workspace, outside the uploaded allowlist.
  Check no new request directories remain. Save bounded host/package metadata.
- [x] Two platform jobs reuse source artifacts specified in the spec and the
  existing corpus prepare command. Install dependencies, build, typecheck and
  execute only in Actions:

```bash
python scripts/voice_chain_report.py prepare short meeting corpus
python scripts/voice_consistency_report.py select corpus diagnostics
npm ci --no-audit --no-fund
npx playwright install --with-deps chromium
npm run build
npx tsc --noEmit --incremental false
node scripts/voice/consistency-run.mjs package
```

  Jobs run under55-minute bounds with fail-fast false. Upload diagnostics only
  after any outcome; no weights, environment, receipts or auth data.
- [x] Aggregate job runs even when a platform fails (unless cancelled), downloads
  both evidence artifacts and pinned historical API reports, writes comparisons
  and uploads the final report even on delivery failure. Missing evidence fails
  explicitly. Retention30days.

## Task 5: Execute, interpret and persist

- [x] Push implementation; contract workflow must turn green. Dispatch:

```bash
gh workflow run voice-consistency.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

- [x] Inspect bounded failure logs for infrastructure errors; fix and repeat
  remotely if needed. Never change the fixed selection or package identity to
  improve results. Preserve complete failed-delivery reports.
- [x] Record exact counts, differing/unstable tuples, historical agreements,
  host differences and causal limits. Update this plan, spec and
  `scripts/VOICE-DEPLOYMENT.txt`; commit/push. Stop progress reminder.
  A diagnostic result is not a Windows quality pass or feature completion.

## Execution record

- Red `f0e8e0f` / `35993962964`: expected missing report module.
- Implementation `af2d012` / `35996206590`: report contracts pass; both collectors
  abort before inference because Playwright transforms installer ESM imports.
- Fix `6f55377` / `35996836383`: native Node ESM loader reads persisted config;
  both platforms and aggregate complete successfully. All648 attempts delivered.
- Aggregate artifact `10807156055`; Linux `10806103628`, Windows `10806823293`.
  Within-platform repetition/layer/thread comparisons all equal; cross-platform
  270equal/54different, exactly two samples across every setting. Both platform
  historical comparisons all equal. Full interpretation is in the spec/ledger.

Application tsconfig excludes tests. Workflow follow-up `6d7d08f` explicitly
typechecks the diagnostic spec and helper separately without repeating inference.
Its initial command omitted the application's ESNext library declarations;
`1529212` restores them. Actions `35998236233` passes the targeted strict
collector typecheck and all five reporting contracts. No inference code changed.
The experiment concludes stable native-path differences on this subset, not a
proven compiler/CPU cause and not a successful Windows accuracy qualification.
