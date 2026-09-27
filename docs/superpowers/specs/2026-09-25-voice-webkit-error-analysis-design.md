# Existing-evidence WebKit mixed/medium error analysis

## Authority and bounded objective

The user approved continuing with existing-evidence analysis after the completed
Edge/WebKit measurement. This written specification requires review before
implementation. The parent measurement is
`2026-09-25-voice-browser-matrix-design.md`.

Explain which of the eight original-duration mixed/medium samples contribute to
the observed WebKit error-rate failure, using retained transcripts and scores.
Do not claim to identify an acoustic or numerical root cause from observational
comparisons alone. Do not modify the product, inference, references, selection,
scoring normalization, thresholds or completed acceptance results.

Chosen approach: join and rescore existing evidence with the existing scorer.
Merely rereading the aggregate cannot identify sample contributions. New
recording or inference experiments would add cost and new variability before
the retained same-upload evidence has been examined; they are not part of this
phase. Windows transport diagnosis and its earlier direct accuracy failure are
separate tasks.

## Fixed evidence

The measurement source run is `36085430283`, code
`7b680acb264b466868cff05a6f8dd9b40d856dcc`, not the new analysis run/commit.

| Evidence | Run | Artifact |
| --- | --- | --- |
| Linux WebKit collection | 36085430283 | 10844047138 |
| Same-upload ONNX baseline | 36085430283 | 10844915649 |
| Completed matrix report | 36085430283 | 10845090269 |
| Original short ONNX baseline | 35858271102 | 10751002303 |

Fixed new-measurement archive digests:

- WebKit: `sha256:0d2db5c932f787681047f425f984156c3c327e1428078eef0b1c42cf5fa6b9ff`.
- Same-upload baseline: `sha256:88cef00dabb62b5f4de6b1dcec7352ec66a6a0a7047d52e824de4cbb72914e3d`.
- Matrix report: `sha256:5dc240fda7861a20ce471c7746bf9cf22337cbc220222af0c83070b6b945acea`.

Verify artifact ownership/run/ID and downloaded archive digests against GitHub
metadata before extraction. Original baseline provenance remains that used by
the completed measurement; record its API-reported digest and selected file
hash, then require exact agreement with retained original-baseline scores.
Missing, expired or mismatched evidence is a blocker, never a reason to replace
an input or rerun a sample.

Use the original frozen100 source manifest and select all samples satisfying
`category == "mixed"` and `5 < duration < 15`. Require exactly eight unique
samples, all from ASCEND, with exact source identity across the joined files.
Do not select only the samples whose transcripts became worse.

Validate the historical WebKit case, package roles, capture hashes, source/upload
manifests, completion and implementation fingerprints using the existing
evidence checks with the historical run/commit. Keep every measured implementation
file unchanged so historical fingerprints remain verifiable; never weaken
verification to accommodate the analysis revision.
The new report records its own run/commit separately.

## Four retained paths per selected sample

| Label | Input | Recognizer/evidence |
| --- | --- | --- |
| Original ONNX | Original source WAV | Existing original baseline, `variant == "sense"` |
| Original native | Original source WAV | WebKit case's paired installed Linux direct/API attempt |
| Captured ONNX | Exact retained WebKit upload | Existing diagnostic baseline keyed by case/sample/upload hash |
| Captured native | Same retained WebKit upload | Existing WebKit browser/API attempt and composer outcome |

The two original paths must share the original audio hash; the two captured
paths must share the upload hash. Never substitute the original hash for the
upload hash. Validate same-upload baseline completion, pinned archive identities,
arguments, case list and historical run/commit. Require the complete retained
baseline matrix before narrowing to the eight WebKit rows.

The original ONNX run is historical, not a simultaneous same-host experiment.
The native GGUF and ONNX implementations are not interchangeable numerical
engines. Equal-input output differences are observations about these fixed
paths, not proof of a particular compiler, quantizer or math-library defect.

## Scoring and report

Reuse `voice_corpus_report.evaluate`, `voice_accuracy_metrics.tokens` and the
existing minimum-edit scoring/tie-break policy. Do not introduce a new
normalization, alternate reference or edit-alignment algorithm.

For each sample retain:

- Original identity, original/upload hashes and durations.
- Original reference, four raw transcripts, normalized token sequences,
  delivery/failure state and existing S/D/I/reference-unit/error counts.
- Error-count differences for captured-native minus original-ONNX,
  captured-native minus original-native, captured-ONNX minus original-ONNX,
  and captured-native minus captured-ONNX.
- Existing capture completion, source/recorder rates and stop origin as context,
  not new acoustic measurements.

Aggregate using total errors divided by total reference units, never a mean of
sample MERs. Show each sample's contribution in percentage points using that
same bucket denominator; improvements as well as regressions must be retained.
Check that contributions sum to the aggregate difference.

Reproduce the saved bucket rates, within numerical tolerance:
original ONNX14.6667%, Linux original native16.4444% and WebKit captured
native17.3333%. Compare unrounded values from retained JSON, not rounded
Markdown. Preserve the original baseline+0.02 ceiling and failed result.
Compute and label captured-ONNX bucket quality as a diagnostic only.
Require each reproduced score to agree with the existing matrix report wherever
that score is retained. A disagreement is an analysis/provenance failure, not
permission to revise the original acceptance outcome.

Output `summary.json`, `samples.json` and a readable `REPORT.md` containing all
eight sample IDs, counts/contributions and explicit observations. Include the
existing ASCEND attribution with the derived report. Do not commit raw corpus
transcripts or audio into the repository; commit conclusions and evidence IDs.

Report separately: the measured gate failure, per-sample contributions, observed
input/backend contrasts, unresolved causes and the smallest justified next
experiment. Do not infer clipping, resampling damage, missing speech, WebKit
defects or reference errors from a changed transcript alone.

## Execution, contracts and completion

All tests, joins, rescoring, hashing/validating captured WAVs and report generation
run in GitHub Actions. No test server, model download, inference, recording,
waveform transformation or new audio experiment is authorized.
Local work is source editing, Git operations and reading retained report output.
Keep PROD, cpg and the old sampler untouched.

Use focused test-first contracts for exact eight-sample selection, duplicate/
missing/source-mismatched paths, cross-case or wrong-upload joins, historical
versus analysis provenance, micro-aggregation and signed sample contributions,
failure-inclusive scoring and disagreement with saved scores.
Retain the existing browser evidence/scoring regression contracts.
Invalid input produces an explicit failure report and nonzero exit; no partial
passing result or silent fallback.

The analysis workflow downloads only the four fixed evidence artifacts and
produces a small attribution-bearing report artifact retained30days. It does not
rerun the expensive browser measurement or change its failed workflow status.
Record exact source/analysis run IDs, commits, artifact IDs/digests and conclusions
in this specification, the parent measurement spec and the deployment ledger.

Completion means verified decomposition of the existing failure and explicit
limits of inference. It does not require or authorize a product fix, model
promotion, threshold relaxation, repeated acceptance until passing, or claims
about real Safari/iPhone or an untouched holdout.

## Completed analysis: 2026-09-25

The user approved written specification `e4e1fea` and inline execution.
Plan/contracts `9b67975` produced the expected missing-analysis-module failure
in run36090714673. Implementation `9655742` passed focused contracts in
run36090937196. The interrupted session did not lose these commits.

Analysis run:
https://github.com/xujxu/agents-chat/actions/runs/36090984994
at `965574245761448173414b83ef454f4042442b5a`.
Seven new contracts and14existing browser evidence/scoring contracts passed.
All four downloaded archives passed identity/digest checks; historical WebKit
package, implementation, case, source/upload and baseline evidence passed.
Rescored sample diagnostics and unrounded bucket rates agree with the retained
measurement. No recording, inference, model download or product change.

The bucket has8samples and225reference units, with all four paths delivered
for all8samples:

| Retained path | Errors | S | D | I | MER |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original ONNX | 33 | 20 | 11 | 2 | 14.666667% |
| Original native | 37 | 19 | 14 | 4 | 16.444444% |
| Captured ONNX | 37 | 19 | 14 | 4 | 16.444444% |
| Captured native | 39 | 21 | 16 | 2 | 17.333333% |

| Sample | Original ONNX errors | Original native errors | Captured ONNX errors | Captured native errors | Primary delta | Contribution pp |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| test-00332 | 0 | 1 | 0 | 1 | +1 | +0.444444 |
| test-00364 | 5 | 6 | 6 | 7 | +2 | +0.888889 |
| test-00554 | 4 | 4 | 3 | 3 | -1 | -0.444444 |
| test-00949 | 10 | 12 | 14 | 15 | +5 | +2.222222 |
| test-01049 | 7 | 7 | 7 | 7 | 0 | 0 |
| test-01050 | 3 | 3 | 3 | 3 | 0 | 0 |
| test-01056 | 2 | 2 | 2 | 1 | -1 | -0.444444 |
| test-01058 | 2 | 2 | 2 | 2 | 0 | 0 |

Primary means captured-native minus original-ONNX errors. Net+6errors produces
+2.666667percentage points; the unchanged allowed increase is2points.
The bucket therefore remains failed, at17.333333% versus16.666667%ceiling.
No sample is excluded, including the two improvements.

Observed contrasts:

- `test-00949` is the largest positive contributor (+5primary errors); both
  fixed recognizers produce more errors on its captured input than on original
  input: ONNX+4 and native+3. This is not solely a difference between backends.
- Original native already has4more aggregate errors than original ONNX.
  Captured native adds2net errors relative to original native; the entire
  primary+6difference cannot be attributed to newly recorded input alone.
- Captured ONNX is+4relative to original ONNX. On identical captured bytes,
  native is+2net errors relative to ONNX. These are observational contrasts
  involving fixed implementations, not independent additive physical causes.
- Original native and captured ONNX happen to have equal aggregate errors and
  S/D/I totals. Their per-sample counts differ; this is not equal transcripts
  or interchangeable recognition behavior.
- All8captures report completed source playback, manual stop, tracks stopped
  and source context closed. The source context is48000Hz and recorder44100Hz.
  These controls establish their stated events, not waveform fidelity, absence
  of lost/altered speech, or a resampler defect.

Smallest justified next investigation: validate and align the retained original
and uploaded WAVs for all8samples, including improvements and unchanged controls,
in Actions. Quantify timing offsets, duration/silence, level/clipping and aligned
signal differences before proposing any recorder or inference change. Do not
feed transformed audio to inference, retune on `test-00949`, or label44100Hz
alone a defect. This is a follow-up proposal, not an executed or approved audio
experiment. Further causal separation would require separately approved
controlled inputs. Windows transport root cause remains a separate open issue.

Report artifact `10845901259`, `webkit-error-analysis`, expires2026-10-25:
`sha256:52e23b1399a98828f7a409a713a6009cc1f9f8022f69cdc1f5541d5214a475de`.
It contains summary/sample JSON, the full8sample count table and raw/normalized
transcripts, hashes/capture context, four-path scores and ASCEND attribution.
Raw corpus text/audio is not committed to the repository.
Source run/commit remain36085430283/7b680ac, distinct from the analysis identity.
The original baseline artifact's verified digest is
`sha256:7f02f1a934411dcc01c869bab78c829d13de5311f886cc8525462b26aae12c01`;
its selected file SHA256 is
`e1885a092e759fa33c6640d9101929fae46c04e291ae9b7c07b5e38ecede64f2`.
That historical artifact expires2026-10-23; analysis output does not extend
source artifact retention. All prior acceptance failures remain unchanged.

### Subsequent retained waveform diagnostics

The proposed all-eight waveform inspection was separately approved as
`2026-09-25-voice-webkit-signal-design.md` (`0bc59dd`) and completed in
run36094215228, code`9c62b34`, without new capture or inference.
All hashes/identities verified. Only1/8global fixed-shift matches is reliable;
all8segment-offset differences remain null under the predefined rules.
`test-00949` has lower whole-file RMS and weak global/local matching, but
improved `test-00554` has an even larger whole-file RMS reduction and ambiguous
matching. Neither level nor offset candidates establish the MER root cause.

Artifact10847180649 expires2026-10-25; digest
`sha256:9a0bc4ecb15b7943398ecf2ee8ee518255c5a6f3103b0cf585a3041da07cd532`.
Detailed metrics, limitations and the proposed separately scoped no-ASR
controlled audio-graph experiment are in that specification. No recorder fix,
threshold tuning, transformed inference input or acceptance promotion.
