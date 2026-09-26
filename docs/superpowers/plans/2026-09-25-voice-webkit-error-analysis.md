# WebKit Existing-evidence Error Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce and decompose the eight-sample WebKit quality failure without new recording or inference.

**Architecture:** A pure analysis helper joins four retained paths and reuses the existing scorer. A separate evidence entry point downloads four fixed artifacts, checks historical provenance and writes attributed reports. A focused Actions workflow runs test-first contracts and a manually dispatched read-only analysis.

**Tech Stack:** Python3.12 unittest, existing OpenCC/edit scoring, GitHub CLI and Actions.

---

Approved spec: `e4e1fea`. User selected inline execution; no subagents.
All tests, archive verification, WAV integrity checks and rescoring execute in
Actions. Local work is editing/Git and reading retained report output.
The named execution skill is unavailable in this environment; follow these
inline checkpoints without switching execution mode.

## Files and interfaces

- Create `scripts/voice_webkit_analysis.py`: `analyze(samples, attempts, originals,
  baseline, saved)` returns summary/sample details and validates retained score
  agreement. No network, filesystem, recorder or inference calls.
- Create `scripts/voice_webkit_evidence.py`: fixed input metadata, bounded archive
  downloader/extractor, historical validation and `run(inputs, output)` CLI.
- Create `scripts/test_voice_webkit_analysis.py`: pure comparison and invalid
  evidence contracts, using existing synthetic browser fixtures.
- Create `.github/workflows/voice-webkit-analysis.yml`: push contracts and
  manual analysis; only checkout, Python, OpenCC and fixed artifact downloads.
- Update the approved spec, parent browser-matrix spec and
  `scripts/VOICE-DEPLOYMENT.txt` with final evidence.

Do not change files in `voice_browser_cases.IMPLEMENTATION_FILES`, old scoring
helpers, or prior measurement workflows.

## Task 1: Red contracts

- [x] Create a synthetic frozen100 fixture from
  `test_voice_browser_report.fixture`; set samples50..57 to mixed,58tozh,59toen
  and synchronize their source fields in all rows. Assign case IDs by host.
  Generate the saved report with the unchanged `browser_report`.

```python
def test_exact_eight_four_paths(self):
    data = fixture()
    result = analyze(*data)
    self.assertEqual(len(result["samples"]), 8)
    self.assertEqual(set(result["summary"]["totals"]), {
        "original_onnx", "original_native", "captured_onnx", "captured_native"})
```

- [x] Add mutations for missing/duplicate/extra paths, source/reference mismatch,
  wrong-case/wrong-upload baseline joins and changed saved counts. Add a
  variable-reference-length case where micro-MER differs from mean sample MER,
  both negative and positive contributions, and a failed native delivery scored
  as reference deletions. Use a synthetic saved report recomputed before calling
  the new helper only when testing a legitimate changed outcome.
- [x] Add workflow contracts:

```yaml
- run: pip install opencc-python-reimplemented==0.1.7
- run: python -m unittest discover -s scripts -p 'test_voice_webkit_*.py' -v
- run: python -m unittest discover -s scripts -p 'test_voice_browser_*.py' -v
```

- [x] Commit/push plan/tests/workflow and inspect the red Actions run. Expected:
  missing `voice_webkit_analysis`, not an unrelated dependency failure.

## Task 2: Pure decomposition

- [x] Validate frozen100 identity, all200WebKit attempts and complete200baseline
  tuples. Select exactly8ASCEND mixed samples using original `5<duration<15`.
  Reject duplicate/missing IDs before indexing. Use existing `validate_attempt`
  and source identity fields. The other case is verified for complete baseline
  tuple coverage, not treated as an additional analysis group.

```python
selected = sorted(
    (s for s in samples if s["category"] == "mixed" and 5 < s["duration"] < 15),
    key=lambda s: s["id"],
)
if len(selected) != 8 or any(s["dataset"] != "ASCEND" for s in selected):
    raise ValueError("Expected eight original mixed/medium ASCEND samples")
```

- [x] Construct all four paths from the selected source record plus retained
  text/failure, then call `evaluate`. Save original text, `tokens(text)`, delivered
  tokens (empty on failure), original/upload hash and complete score dictionary.
  Never replace native delivered text with API text on failed UI delivery.
  Compare API score separately when retained by the prior diagnostics.
- [x] Compute the four signed contrasts:

```python
contrasts = {
    "primary": ("captured_native", "original_onnx"),
    "native_input": ("captured_native", "original_native"),
    "onnx_input": ("captured_onnx", "original_onnx"),
    "captured_backend": ("captured_native", "captured_onnx"),
}
for name, (minuend, subtrahend) in contrasts.items():
    delta = paths[minuend]["score"]["errors"] - paths[subtrahend]["score"]["errors"]
```

For each contrast the first named path is the minuend and the second the
subtrahend; implement subtraction in that order. Contributions are
`100 * delta / bucket_reference_units`. Sum counts first for micro-rates.
Check contribution sums within1e-12; compare scores and unrounded bucket rates
to the saved report. Preserve baseline+0.02 and old failed qualification.
- [x] Write JSON-compatible summary/sample objects. Include capture metadata,
  historical case ID, observations and explicit no-causal/no-release limits.

## Task 3: Fixed evidence entry point

- [x] Download artifacts via `gh api` using exact repository/run/artifact IDs in
  the spec. Save metadata, verify run ownership, expiration and digest. Bound
  downloads with subprocess timeouts. Before ZIP extraction, reject unsafe,
  duplicate or symlink members and excessive uncompressed sizes.
- [x] Validate source with:

```python
load_platform(
    inputs / "webkit", "linux", "36085430283",
    "7b680acb264b466868cff05a6f8dd9b40d856dcc",
    case_id="linux-webkit-mobile",
)
```

Require baseline completion count200/cases/historical run+commit. Its environment
must match the archived matrix report, pinned archive hashes, CPU2threads,
120second deadline and original CPU/auto/ITN arguments. Require matrix report
complete400attempts and unchanged historical host/case identities.
Do not compare historical provenance against the new `GITHUB_SHA`.
- [x] Filter the original short `variant=="sense"` rows by all8selected IDs,
  retaining exact source identity and checking scored counts against the saved
  diagnostics. Feed the full baseline matrix and full WebKit attempts to the
  pure analyzer.
- [x] Write `summary.json`, `samples.json`, `REPORT.md`,
  `ASCEND-ATTRIBUTION.txt` and provenance including input artifact/file hashes
  plus separate analysis run/commit. Output failures explicitly with nonzero
  exit; do not emit successful subset summaries.
- [x] Add archive/provenance contracts before acceptance: wrong run/digest,
  unsafe ZIP path, stale implementation/source/upload identity (existing
  browser contracts), and malformed historical baseline completion/arguments.
  Push and inspect all focused contracts.

## Task 4: Actions analysis and persistent result

- [x] Add the manual workflow job, depending on contracts. Use Python3.12,
  OpenCC0.1.7 and `GH_TOKEN` with contents/actions read permissions.

```sh
python scripts/voice_webkit_evidence.py inputs webkit-report
```

Upload only `webkit-report/` with30day retention, even on analysis failure.
No npm/build/server/browser/model/inference command belongs in this workflow.
- [x] Dispatch against the approved implementation commit after contracts pass.
  Inspect exactly8sample records, four path totals, unrounded agreement,
  signed contributions, input hashes and separate historical/analysis identity.
  Fix analysis bugs from Actions evidence; never rerun the original measurement.
- [x] Read the retained report, distinguish observations from unresolved causes,
  and record evidence IDs/digests and the smallest justified follow-up in the
  spec, parent browser-matrix spec and deployment ledger.
- [x] Commit/push with:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

- [x] Stop the progress reminder and close tracking. Completion is verified
  analysis, not product qualification or a claimed root-cause fix.

## Self-review

All eight samples, improvements, failures and original durations are retained.
Four-path scores share one normalization and fixed denominator. Historical
artifacts are distinct from analysis provenance. No production or measured
implementation file changes, new inference, selected reruns or relaxed gates.

## Execution evidence

- Written spec `e4e1fea` approved; plan/test-first `9b67975` pushed before the
  reported session interruption. Run36090714673 confirmed the intended missing
  module. No worktree changes were lost.
- Implementation `965574245761448173414b83ef454f4042442b5a` passed contracts in
  run36090937196; manual analysis run36090984994 passed7new and14legacy contracts
  and the fixed evidence analysis.
- Artifact10845901259 (`webkit-error-analysis`) expires2026-10-25; digest
  `sha256:52e23b1399a98828f7a409a713a6009cc1f9f8022f69cdc1f5541d5214a475de`.
  Historical source identity remains36085430283/7b680ac.
- Over225reference units, original ONNX/native and captured ONNX/native have
  33/37/37/39errors. Net primary+6errors, including `test-00949`+5 and retained
  improvements `test-00554`/`test-01056`-1each. Scores/rates match saved evidence.
- Detailed observations, non-causal limits and the proposed all-eight retained
  WAV integrity investigation are in the phase spec and deployment ledger.
  No audio/inference experiment was executed, and product acceptance still fails.
