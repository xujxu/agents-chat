# Installed Voice API Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the exact installed Linux/Windows candidate packages through authenticated API on all frozen 100 samples, without changing quality or latency gates.

**Architecture:** Download trusted existing Actions package/corpus artifacts; invoke the actual configurator into the isolated checkout, then start the built app without voice environment overrides. Playwright authenticates and posts checksum-verified original WAVs sequentially. A strict report validates every identity and reuses existing normalization and decision functions against the same historical baseline as the engine qualification.

**Tech Stack:** Next.js, Playwright, Node ESM, Python/OpenCC, GitHub Actions matrix.

---

## Boundaries and prerequisites

Continue approved inline execution, no subagents. All execution in Actions.
No PROD/cpg/sampler changes, new resource caps, public release or automatic
downloads. Existing recommended Sense and compatibility Whisper both run.
No new model-selection or threshold decision is made.

On 2026-09-24 the repository runners API returned zero registered self-hosted
runners. Actual Windows 11 acceptance is blocked until an authorized runner is
provided. Hosted `windows-2022` is Server evidence only.

This slice measures direct WAV upload through authenticated API, not browser
capture timing. Existing browser regressions are not full-corpus browser
acceptance. No physical microphone claim. Failure-inclusive results and all
metadata are retained even when a candidate fails gates.

## File map

| File | Responsibility |
| --- | --- |
| `scripts/voice_installed_report.py` | Strict fixed100 evidence, frozen baseline comparison, failure-inclusive gates |
| `scripts/test_voice_installed_report.py` | Missing/duplicate/changed/invalid latency/failure scoring contracts |
| `tests/voice-installed-corpus.spec.ts` | Authenticated sequential API corpus collector, waveform validation |
| `scripts/voice/installed-api-run.mjs` | Real configuration, bounded app lifetime, host/package provenance, no secret artifacts |
| `.github/workflows/voice-installed-api.yml` | Contract job and four OS/model cells using existing immutable artifact IDs |

## Task 1: Red reporting contracts

- [x] Add tests for an exact100 synthetic manifest with ASCEND60/AISHELL-4 40.
  Require one output per ID, unchanged reference/category/duration/split/hash,
  valid finite nonnegative timings, failures scored as full reference deletions,
  and empty successes treated as delivery failure:

```python
report = installed_report(manifest, attempts, baseline)
self.assertTrue(report["candidates"][0]["eligible"])
with self.assertRaises(ValueError):
    installed_report(manifest, attempts[:-1], baseline)
attempts[0]["failure"] = "voice_timeout"
attempts[0]["text"] = None
self.assertIn("delivery_below_100_percent",
              installed_report(manifest, attempts, baseline)["candidates"][0]["violations"])
```

- [x] Push tests/workflow registration; expected red is missing report module.
  `gh run view RUN -R xujxu/agents-chat --log-failed` must confirm it.

## Task 2: Shared report and frozen baseline

- [x] Implement `installed_report(manifest, attempts, baseline)` using existing
  `validate_results`, `evaluate`, `decide` functions. Baseline is the existing
  original Sense ONNX reference used by `voice_server_profiles.gates`, not a
  new comparison selected from these results. Match all identity fields and
  require successful baseline outputs, then recompute scores from original text.

```python
scored = [{**row, "score": evaluate(row)["delivered_score"]} for row in attempts]
result = decide(scored, reference)
result["scope"] = "Installed package, authenticated direct-WAV API; no browser capture timing."
```

  Require exact100 with60ASCEND/40AISHELL-4 and unique IDs. Normalize blank text
  to explicit `empty_transcript`. Reject NaN/Infinity/negative seconds and mixed
  model variant evidence. Preserve full failure accounting; do not skip errors.

- [x] CLI reads corpus/attempts/short-baseline/long-baseline, writes summary JSON
  and a concise Markdown table of per-language-duration error and latency. Exit1
  for failed gates **after** report creation; malformed/incomplete evidence is a
  distinct surfaced error. Always retain `release_approved=False`.

## Task 3: Authenticated installed corpus runner

- [x] Test uses existing login fixture only for unrelated chat endpoints. Voice
  API remains unmocked. Require expected capability model/threads/standard policy:

```ts
const response = await page.context().request.post('/api/voice', {
  headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'admin@local',
    'x-voice-request-id': randomUUID() },
  data: audio, timeout: 130000,
});
```

  Check original audio SHA256 and `validateVoiceWav` before posting. No references,
  hotwords or forced-language hints enter inference. Measure HTTP wall-clock
  seconds and API `elapsedMs` separately. Store all100 results; valid API failures
  continue, transport exceptions become explicit failed attempts, malformed
  response/auth failures stop as infrastructure errors. Console shows ID/status/
  duration, not transcript. Write completion only after100 accounted attempts.

- [x] Orchestrator clears inherited VOICE_* harness keys, checks trusted downloaded
  manifest, invokes `configure-voice.mjs --project-dir CHECKOUT --model MODEL
  --package-dir PACKAGE --manifest-sha256 SHA --non-interactive`. Next.js loads
  the actual resulting `.env.local`; do not replace it with synthetic env flags.
  CLI/readiness failure aborts. Run browser test via Node Playwright CLI and
  kill/wait only this owned app child in finally. Save CPU model/logical count,
  RAM, OS/release, model/thread count and manifest digest. Describe effective
  external quotas and native peak RSS as unknown where not measured. Do not
  convert experimental allocation into product limits.

## Task 4: Actions matrix

- [x] Reuse corpus preparation:

```bash
python scripts/voice_chain_report.py prepare short meeting corpus
```

  ASCEND run35858271102/artifact10748244312; meeting35863991538/10752270787.
  Baselines35858271102/10751002303 and35870441019/10755950119.
  Linux packages35968099304/10794617845(Sense),10795017559(Whisper).
  Windows35987278609/10802394350(Sense),10803120161(Whisper).
  Artifacts must be unexpired. Trust is successful pinned run/artifact identity,
  not merely a digest from an arbitrary local package.

- [x] Four matrix cells: ubuntu-24.04/windows-2022 x Sense/Whisper. Node24.20.0,
  Python3.12/OpenCC0.1.7. Install dependencies/build app/Chromium only in Actions.
  Native binaries on Linux regain executable permission after artifact extraction.
  Preserve model bytes; no native rebuild. Default model threads (Sense2/Whisper1).
  Sequential requests, normal execution without new app quotas.

- [x] Upload only report/results/manifest/attribution/host provenance and bounded
  server log. Never `.env.local`, `.data/voice` receipts, browser storage state or
  entire project. Workflow gate failures are expected honest outcomes, not a
  reason to change thresholds or reclassify Whisper as recommended.

## Task 5: Execute and record

- [x] Push implementation and dispatch:

```bash
gh workflow run voice-installed-api.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

- [x] Inspect all four matrix reports, diagnose infrastructure separately from
  measured gate failures. Record run/commit/artifact identities and exact100
  delivery, short<=3s/long<=5s aggregate P95 and each group<=baseline+2pp.
  State browser corpus, actual Win11, license and permanent release gates still
  pending. Do not claim feature release completion from Server API results.

## Execution evidence and outcome

Test-first `0533b1b`, run `35990247734`: expected missing report module.
Implementation `7d81928`, first matrix `35990621467`: complete evidence from all
four cells. Final failure-accounting/timing code `0cd5ae2`, matrix
[`35991326454`](https://github.com/xujxu/agents-chat/actions/runs/35991326454):
report contracts, build/typecheck and all four installed collections completed.
Each model/platform delivered 100/100; three cells correctly fail measured gates.

| Platform/model | Short HTTP P95 | Long HTTP P95 | Gate result | Artifact |
| --- | ---: | ---: | --- | --- |
| Linux Sense | 0.400 s | 2.284 s | Pass | `10804222694` |
| Windows Server Sense | 0.875 s | 4.287 s | Mixed/medium accuracy fails | `10803903893` |
| Linux Whisper | 6.949 s | 9.826 s | Quality and latency fail | `10804772932` |
| Windows Server Whisper | 7.366 s | 13.384 s | Quality and latency fail | `10804813131` |

Windows Sense mixed/medium error 16.89% exceeds baseline 14.67% + 2 percentage
points. Linux Sense is 16.44%. Both runs produce the same qualification outcomes;
no threshold, normalization, reference, package or model recommendation changed.
Full per-group results and host provenance are in the report artifacts; the
formal spec and `scripts/VOICE-DEPLOYMENT.txt` record their interpretation.

This plan's measurement work is complete, not final feature acceptance.
Windows quality qualification remains open. Browser-corpus, actual Win11,
physical microphone/task behavior, redistribution permission and permanent
downloads remain separate gates. No authorized Win11 runner is available.
