# Bounded diagnosis of intermittent voice PR failures

## Status and scope

The user approved the diagnostic direction and requested this short written
design before implementation. Written-spec approval is still required.
This work investigates two failures recorded in Draft PR #2, not new product
functionality. All execution, builds and tests run in GitHub Actions.

Pinned product baselines:
- Voice branch: `20f5f0e3e55569a4ac7f0878f314f1d8c7b2e009`.
- Main: `638c553c62406dbb7e6b5aeb41cdddf4cd6de179`.

Record the separate diagnostic harness SHA in every result. Do not silently
substitute a moving branch for either product baseline.

## Existing evidence

- Windows run `36224052311`: both provider phases passed their API/browser
  cases, but the final Whisper assertion found one extra temporary directory.
  Its contents and creation time were not retained.
- Windows run `36224479150`: metadata-only per-case diagnostics and the original
  final assertion passed. Instrumentation may change timing; this is not a fix.
- WebKit run `36224073522`: orientation cycle 2 at width 844 left a bottom
  distance of 16px, exceeding the unchanged 4px ceiling.
- Subsequent full E2E and exact-case main/voice comparisons passed. Neither
  failure's cause is established.

## Chosen approach

Use small controlled cohorts with retained metadata, rather than repeatedly
rerunning until green. Existing-log-only review cannot recover missing Windows
directory metadata. Product cleanup changes or longer settling waits would
change the behavior under investigation and are excluded.

### Windows: lifecycle versus per-case sampling

Run two independent Windows Server 2022 jobs against the same pinned product:
per-case snapshots disabled and enabled. Both retain lifecycle event recording.
Each job builds once and runs at most three rounds of the existing
Sense/Whisper/invalid/disabled application suite, stopping at its first failure.
Use one worker and zero test retries. Do not run real speech models.

Retain the original order: tests complete, the harness stops the owned server,
then it compares temporary-directory names with the job's initial baseline.
Do not add a pre-stop filesystem scan, cleanup wait, deletion or retry.
Use distinct round/provider log and test-output paths so evidence is not
overwritten. Never refresh the initial directory baseline between rounds.

Observe matching temporary-directory create/change/delete notifications with
timestamps and the current round/provider/phase. A filesystem notification is a
hint, not proof of a complete event history. Keep at most 4096 events per round,
recording an explicit dropped-event count and watcher errors.
Record server stop-request and close times. After shutdown, record bounded
metadata for residual directories: names, timestamps, up to 20 immediate member
names/sizes/types per directory and at most 64 directories, with total counts.
Never follow symlinks or read audio, transcript or arbitrary file contents.

Diagnostics must not suppress an assertion, replace an error with success, or
remove a residual directory. Persist lifecycle evidence even if the test runner
or leak assertion fails. Both jobs finish independently; one failure does not
cancel the other cohort. Each job has a 30-minute maximum.

### WebKit: identical main and voice comparison

Use two Ubuntu 24.04 jobs with the same pinned Node/Playwright versions and
browser settings. Build each pinned product baseline separately, then overlay
only the identical diagnostic test/sampler from the recorded harness revision.
Record those overlay paths; never overlay application code.

Run only `keeps latest messages at the bottom through orientation round trips`
from `tests/chat-reading-anchor.spec.ts`, using `iphone-webkit`, one worker,
zero retries and five repetitions. Each repetition retains all three existing
portrait/landscape round trips. Preserve the existing settling helper, polling
timeout and 4px assertion exactly. Stop a job on its first failure and record
how many repetitions actually completed; each job has a 15-minute maximum.

Retain a bounded numeric geometry history around scroll/resize events and
assertion failure: timestamps, viewport dimensions/scale, chat scroll offset,
client/scroll height, bottom distance, and composer/textarea dimensions.
Keep at most 512 samples per test, recording dropped samples. Store no message
or draft text. Preserve the existing failure trace and final geometry.
Use exactly the same sampling and fixture on both baselines. Sampling overhead
remains a possible confound, even when the two jobs use the same instrumentation.

## Implementation boundary and validation

Changes may touch test helpers, `tests/voice-windows-application.mjs`,
`tests/chat-reading-anchor.spec.ts`, diagnostic Actions configuration and related
evidence documentation only. Prefer reuse of existing build/test steps; any new
diagnostic workflow must be manual-only. Do not expand regular PR checks into
these repeated cohorts. Preserve the existing one-round Windows check defaults.

Before interpreting a cohort, verify its recorded product/harness identities,
requested and completed counts, sampling mode, original assertion outcome and
artifact presence. Exercise metadata bounds and failure-report preservation with
synthetic fixtures in Actions. Treat diagnostic capture errors explicitly as
incomplete evidence, never a clean run.

## Stop and decision rules

One bounded batch only: at most six Windows rounds and ten WebKit repetitions.
If a failure occurs, analyze retained metadata and existing logs; propose a
specific fix only when supported by the evidence. Explain the affected component,
reason, impact and verification, and obtain approval before product changes.
If all cohorts pass or data is insufficient, report that reproduction/root cause
remains unconfirmed and stop; do not launch another batch automatically.

Keep PR #2 Draft while these findings await a decision. Do not reopen licensing
or accuracy research, change models/toolchains, relax thresholds, publish native
packages, merge the PR, or describe non-reproduction as a fix.
