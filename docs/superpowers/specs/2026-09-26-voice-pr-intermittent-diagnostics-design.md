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

## Execution record: first bounded batch (2026-09-26)

Written design approved; plan/red tests `6ea6897`. New manual-only workflow
initially returned404 because it was not registered on the default branch.
The user approved a temporary contracts-only push trigger (`b40cdfc`), removed
in harness `6162582a249241adac2518fd80d89a43c2cf53c8`.
Red run `36225811502` failed on the missing helper module. Green run
`36225903942` passed4metadata contracts without running cohorts.

The single approved batch is
[36225934786](https://github.com/xujxu/agents-chat/actions/runs/36225934786).
Both product SHAs match the pinned baselines above; Node24.20.0 and the identical
test overlay were used. Both Ubuntu image versions were20260920.314.1.
No application/native implementation changed.

| Cohort | Actual result |
| --- | --- |
| Windows per-case sampling off | Harness process aborted before completing any round |
| Windows per-case sampling on | Same harness abort, before completing any round |
| WebKit main | 5/5 passed, zero retries |
| WebKit voice | First repetition failed; remaining4not run, zero retries |

Windows failed with Node/libuv's native assertion
`!_wcsnicmp(filename, dir, dirlen)` in `src\win\fs-event.c:72` after adding the
temporary-directory watcher. Only provenance survived; no lifecycle report
was produced. JavaScript finally/error handlers cannot guarantee reporting after
a native abort. These jobs provide **no valid cleanup-cohort result** and do not
reproduce or clear the original product directory leak. This is a new diagnostic
harness blocker, not evidence that the voice runtime or toolchain must change.
The exact filesystem/path condition causing the native assertion is unconfirmed.

WebKit voice failed cycle1 at width844 with5px distance from bottom (limit4px).
The retained history has14samples, zero dropped samples and zero capture errors.
At the last observed scroll, scrollTop was7877, content height8061, client
height184, bottom distance0, and chat top54.28125. Final geometry shows the same
scrollTop/content height but client height179, giving5px bottom distance.
Thus the record shows the viewport shortened after a bottom-position sample
without sufficient final scroll compensation. It does not record the internal
controller's following/intent state, so it does not yet establish why correction
was missed. The composer/textarea changed height during orientation (124->121
and37->34); this is observation, not a component replacement recommendation.

All5main repetitions finished with0px bottom distance. Their histories contain
26/27samples, zero dropped samples and zero capture errors. Passing this bounded
main cohort does not prove main can never encounter the race, nor that voice
code alone caused it; the scroll controller is shared.

The ordinary PR typography workflow `36225906723` at the same harness commit
also failed this orientation test, cycle2/width844 at16px versus4px, with
geometry sampling not enabled. Android/desktop typography jobs passed.
This is additional reproduction outside the instrumented cohort, not a new
approved diagnostic batch or a reason to relax the tolerance.

Retained artifacts (expiry2026-10-10):
- Windows off `10900956564`,783bytes,
  SHA256`45bdf553c0ff27cbe94f155bbbe5152883bb39d43f4067ec13cf12a3f5147a88`.
- Windows on `10901171067`,782bytes,
  SHA256`93ac4c21f5edab1cf10ef0dc2300a965795baedb40385bd6e56f0f277df1b406`.
- WebKit main `10900602561`,5901bytes,
  SHA256`f9d6c383c08a079c8449f22601a1895582132418394c687bf0c0787285fff348`.
- WebKit voice `10900931830`,1260270bytes,
  SHA256`f770bb3fa859e0e38cdc1bef7479cc309c287d490add878bb8426f4231eb40a5`.

The batch is stopped. Do not rerun either cohort automatically. A further
Windows attempt requires repairing/replacing the diagnostic watcher and explicit
approval for the revised collection method/budget. No product fix is justified
as completed by these results. PR #2 remains Draft.
