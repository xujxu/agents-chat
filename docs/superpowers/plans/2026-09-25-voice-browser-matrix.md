# Installed Sense Browser Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure installed Sense on actual Windows Edge and the existing mobile WebKit configuration without duplicating mobile E2E coverage.

**Architecture:** Keep legacy Chromium defaults and add an explicit two-case mode to the existing collector, scorer and baseline runner. A shared fixed JSON selection binds case, platform, project, engine, channel and device; evidence is joined by case rather than host. A focused Actions workflow gates each corpus collector on its real browser fixtures and retains incomplete or failed results.

**Tech Stack:** Node24, TypeScript, Playwright, Python3.12 unittest, GitHub Actions, unchanged native Sense and pinned ONNX.

---

Authority: approved specification `6d64296`, inline execution selected by the user.
All commands that build, test, typecheck, start servers, process audio or run
inference below execute in Actions, never on the development host.
Use the current worktree and branch; preserve PROD, cpg, old sampler and legacy
results. Do not invoke subagents. If the execution skill is unavailable, retain
this plan's explicit inline checkpoints rather than changing execution mode.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `scripts/voice/browser-cases.json` | Fixed two-case identity shared by Python and Node |
| `scripts/voice/browser-cases.ts` | Typed loading, case selection and evidence directory |
| `tests/playwright.voice-matrix.config.ts` | Narrow projects reusing existing iPhone settings and voice specs |
| `scripts/voice/installed-api-run.mjs` | Optional case-aware install/launch, fingerprints, compatibility/completion status |
| `tests/voice-installed-browser.spec.ts` | Case-bound observations, upload manifests and completion |
| `scripts/voice_browser_cases.py` | Fixed selection and metadata/fingerprint checks |
| `scripts/voice_browser_report.py` | Optional case-key scoring; unchanged thresholds and legacy mode |
| `scripts/voice_browser_evidence.py` | Optional case-aware retained-evidence validation and report |
| `scripts/voice_browser_baseline.py` | Same-upload replay with explicit case joins |
| `scripts/test_voice_browser_matrix.py` | Matrix identity, isolation and legacy regression contracts |
| `.github/workflows/voice-browser-matrix.yml` | Contracts, target compatibility, manual corpus/baseline/report |

Only change `tests/helpers/voiceBrowserCapture.ts` if target fixtures demonstrate
an observer incompatibility; preserve native recorder calls and cover the
adaptation with the existing capture fixtures. Product changes need a separate
decision and are not authorized here.

## Task 1: Test-first case identity

- [x] Add fixed-selection and isolation contracts before the implementation.

```python
from voice_browser_cases import CASES, validate_browser
from voice_browser_report import browser_report
from test_voice_browser_report import fixture

def matrix_fixture():
    samples, rows, original, baseline = fixture()
    by_platform = {case["platform"]: name for name, case in CASES.items()}
    for row in rows + baseline:
        row["caseId"] = by_platform[row["platform"]]
    return samples, rows, original, baseline

def test_case_join(self):
    data = matrix_fixture()
    report = browser_report(*data, cases=CASES)
    self.assertEqual({c["caseId"] for c in report["cells"]}, set(CASES))
    self.assertEqual(report["attempts"], 400)
    data[3][0]["caseId"] = "win32-edge"
    with self.assertRaises(ValueError):
        browser_report(*data, cases=CASES)
```

Cover missing/unknown/duplicate cases, wrong host/channel/device, legacy rows,
swapped baseline cases, changed upload hashes, source identity, source-duration
grouping and failed/null timing by running both new and unchanged old contracts.
Use deep copies per mutation. Test exact fixed case keys and case fingerprints.

- [x] Add push-only Python contracts workflow with checkout, Python3.12 and
`pip install opencc-python-reimplemented==0.1.7`.

```yaml
- run: python -m unittest discover -s scripts -p 'test_voice_browser_*.py' -v
```

- [x] Commit tests/workflow/plan, push, inspect Actions. Expected initial failure:
`ModuleNotFoundError: No module named 'voice_browser_cases'`.

## Task 2: Fixed selection and focused projects

- [x] Create the shared fixed selection:

```json
{
  "win32-edge": {
    "platform": "win32",
    "project": "installed-edge",
    "browserName": "chromium",
    "channel": "msedge",
    "device": "Desktop Edge"
  },
  "linux-webkit-mobile": {
    "platform": "linux",
    "project": "installed-webkit-mobile",
    "browserName": "webkit",
    "channel": null,
    "device": "iPhone 14 Pro Max"
  }
}
```

TypeScript exports `BrowserCase`, `browserCases`, `selectBrowserCase(caseId)`,
and `browserEvidenceDirectory(caseId)`. Parse JSON as unknown, validate all five
fields and reject unknown cases; never default a supplied unknown case to
Chromium. Python loads the same file as `CASES`.

- [x] Add the focused Playwright config using the existing base config. Match
only these exact files, keep one worker and no retries:

```typescript
const testMatch = [
  '**/voice-input.spec.ts',
  '**/voice-browser-capture.spec.ts',
  '**/voice-installed-browser.spec.ts',
];
```

For WebKit take `use` from the base `iphone-webkit` project and assert that it
exists. Edge uses `devices['Desktop Edge']` with `channel: 'msedge'`.
Project names come from the fixed mapping. No unrelated tests or base project
matching changes.

- [x] Extend the launcher with an optional fourth positional case argument.

```javascript
const [packageDirectory, model, mode = 'direct', caseId] = process.argv.slice(2);
const selectedCase = caseId === undefined ? undefined : selectBrowserCase(caseId);
assert.ok(!selectedCase || (mode === 'browser' && selectedCase.platform === process.platform));
const config = selectedCase ? 'tests/playwright.voice-matrix.config.ts' : 'tests/playwright.config.ts';
const project = selectedCase?.project ?? 'desktop-chromium';
```

Set `INSTALLED_BROWSER_CASE` only from the explicit selection; remove inherited
selection for legacy mode. Evidence path is `installed-browser-${caseId}` for
selected cases and the existing directory otherwise. Propagate selection to
both fixture and corpus commands. Retain install hash verification and cleanup.
Fingerprint selection/config/launcher/helper/collector and product implementation
files. Host metadata includes case identity and actual host OS.

- [x] Collector validates project, engine, channel and descriptor settings
against the fixed selection before recording. Record Playwright version,
actual browser version/UA, requested and effective device settings. Edge must
show `Edg/` branding; record executable path/version/hash from the Windows runner.
Add `caseId` to every attempt, source/upload manifest and completion marker.
Completion includes run/commit and the existing exact100/200/model fields.
Use the case evidence directory for every write, preserving legacy output.

## Task 3: Case-aware scoring and evidence

- [x] Add optional keyword-only `cases=None` to `browser_report`. Keep legacy
calls unchanged. Select the grouping field explicitly:

```python
group_key = "caseId" if cases is not None else "platform"
groups = tuple(cases) if cases is not None else PLATFORMS
if cases is not None:
    for row in rows + baseline:
        if row.get("caseId") not in cases or row.get("platform") != cases[row["caseId"]]["platform"]:
            raise ValueError("Case/host identity differs")
```

All exact-matrix, baseline, pair and cell joins use `group_key`; outputs retain
the actual host `platform` and explicit `caseId`. Do not replace the host with
the case ID. Preserve scoring math, failure deletion handling, quality ceilings,
short/long P95 thresholds, original duration grouping and diagnostic-only status.

- [x] Add optional `case_id=None` to `load_platform`, checking strict case-bound
completion, host, browser and row identities. Check manifest case, source list
and upload hashes. Verify `implementation.json` against checked-out files before
accepting case evidence. `validate_browser(browser, case_id)` checks engine,
project/channel/device, source rate, versions and requested/effective settings;
Edge branding and executable identity are mandatory.

- [x] Add explicit final CLI selector `matrix` for baseline/evidence commands;
legacy invocation remains unchanged. Use case paths and `load_platform` with
the selected host. Baseline rows include case and host; baseline completion and
environment include the exact case list, run and commit. Never infer a case
from missing metadata. Validate baseline case provenance before scoring.

- [x] Produce case-labelled Markdown and JSON. For an incomplete collection,
retain `status: incomplete` with a concrete reason and nonzero process exit;
do not score a passing subset. Preserve complete per-case measurements if the
other case is blocked. Catch only anticipated evidence input errors at the
report entry point; unexpected programming errors still fail visibly.

- [x] Push and inspect Python contracts. Expected: both legacy and matrix
contracts pass. Add artifact mutation tests for case manifest, completion,
fingerprints and captured WAV corruption before accepting evidence.

## Task 4: Actions compatibility and measurement

- [x] Extend the workflow with two target compatibility jobs, using
`windows-2022`/`msedge` and `ubuntu-24.04`/`webkit`, fail-fast false. Install Node
24.20.0 and browsers. Build/typecheck the app and explicitly typecheck the
focused config, shared selection, collector and helper:

```sh
npx tsc --noEmit --strict --skipLibCheck --esModuleInterop --target ES2017 --lib dom,dom.iterable,esnext --module esnext --moduleResolution bundler --jsx react-jsx --allowImportingTsExtensions tests/playwright.voice-matrix.config.ts tests/voice-installed-browser.spec.ts tests/voice-browser-capture.spec.ts
```

Start the isolated fixture app in Actions with existing authentication test
settings; wait for `/api/auth/providers`. Run both existing voice and observer
fixtures for the selected project before enabling its corpus. Retain explicit
compatibility status and sanitized Playwright line output. No private app logs.
Do not skip target assertions on failure.

- [x] Manual collection reuses the pinned downloads, corpus preparation,
package installer and build from `voice-installed-browser.yml`. Commands:

```sh
node scripts/voice/installed-api-run.mjs package sensevoice-small-q8 browser win32-edge
node scripts/voice/installed-api-run.mjs package sensevoice-small-q8 browser linux-webkit-mobile
```

One command per corresponding host. Artifacts use the case evidence directory
and name. Preserve100sources/200attempts per host, no selective retries.

- [x] Baseline/report retain pinned archive downloads and original baseline
downloads from the existing workflow, with case-named artifact paths:

```sh
python scripts/voice_browser_baseline.py evidence sherpa sense baseline matrix
python scripts/voice_browser_evidence.py evidence baseline short-baseline/scored-results.jsonl long-baseline/long-report/scored-results.json browser-report matrix
```

Upload results even on measured failure, retain30days, never upload model
weights/private logs/configuration. Baseline or corpus failure must not prevent
an explicit incomplete report job from running.

- [x] Push, inspect target fixture outcomes. Adapt only the observer if
evidenced necessary; push fixes and rerun contracts before measurement.
Dispatch the expensive workflow only once both targets pass. Inspect actual
run/commit, case coverage,400attempts,200diagnostic tuples and all thresholds.
Failed quality gates are results, not justification to tune or rerun samples.

## Task 5: Persistent evidence and closure

- [x] Record run/commit/artifact IDs, checksums, case-level delivery/quality/P95,
diagnostic availability and interpretation limits in:
`docs/superpowers/specs/2026-09-25-voice-browser-matrix-design.md`,
`docs/superpowers/specs/2026-09-24-install-selected-voice-input-design.md`,
and `scripts/VOICE-DEPLOYMENT.txt`.
- [x] Mark completed plan steps with evidence; explicitly mark any blocked
step rather than claiming completion. Preserve the prior Windows direct quality
failure regardless of these browser measurements.
- [x] Commit/push documentation with the required coauthor trailer:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

- [x] Stop the15minute progress reminder at completion or a genuine approval/
environment blocker. Report actual outcomes, not real-device qualification.

## Self-review

The plan covers both fixed cases, reuse of mobile coverage, strict identity,
compatibility-before-corpus, original gates, bounded same-byte diagnostics,
Actions-only execution and durable evidence. Legacy Chromium remains a separate
mode and its completed corpus is not rerun. `caseId` is consistently the join
identity while `platform` always describes the actual host.

## Execution checkpoints

- [x] Written-spec approval and inline execution recorded; plan committed in
  `4c1ae62`.
- [x] Test-first run36083976647 failed for missing `voice_browser_cases`;
  unchanged eight legacy Python contracts passed.
- [x] Case mapping, focused projects, case-bound collector, baseline and report
  implemented in `b340f99`; artifact corruption/incomplete-report contracts
  added in `c1f2d7c`.
- [x] Compatibility runs36084214690/36084280859 exposed two test assumptions:
  WebKit did not expose the Blob request body to Playwright's request observer;
  an exactly30second stimulus could complete before automatic stop.
- [x] Fixture-only corrections use an independent loopback HTTP receiver for
  exact upload bytes and a32second generated stimulus for the unchanged30second
  recording cap. Run36084652722 additionally exposed fixture transport and
  native-wrapper cleanup problems; `7b680ac` supplies CORS handling and observes
  owned tracks by stable native track ID through the shared stop prototype.
  Native stop is always forwarded. Production recorder/inference code unchanged.
- [x] Run36085061136 at`7b680ac` passed Python contracts and both actual target
  compatibility jobs. Legacy Chromium regression run36085061185 also passed;
  no completed Chromium corpus was rerun.
- [x] Dispatched full measurement run36085430283 at`7b680ac`.
- [x] Full run36085430283 completed both collectors and baseline; all400attempts
  and200diagnostic tuples retained. Browser delivery200/200; Windows direct
  delivers99/100 because `test-01049` has a transport error. Edge browser and
  Linux direct pass. WebKit browser mixed/medium17.3333% exceeds16.6667%;
  Windows direct mixed/medium26.6667% includes the failed reference deletion.
  The report correctly exits1; no sample was retried or excluded.
- [x] Durable result/host/version/artifact/digest/interpretation evidence recorded
  in this phase's specification, the parent product spec and deployment ledger.
  Product acceptance remains failed; no algorithm fix or real-device claim.
