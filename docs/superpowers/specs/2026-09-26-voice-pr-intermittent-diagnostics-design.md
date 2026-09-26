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

### Approved Windows-only supplement (2026-09-26)

After an interrupted approval prompt, the user explicitly approved removal of
the crashing filesystem watcher and a bounded Windows-only supplemental batch.
This supersedes the event-notification requirement for that supplement, not the
original failure record. Use lifecycle timestamps plus post-stop residual
metadata and sampling off/on, at most3rounds per arm, stopping at first failure.
Product baseline remains `20f5f0e`; no native/runtime code changes.

The lifecycle recorder no longer opens any filesystem watcher. Consequently
it cannot identify directory creation/removal times except through retained
filesystem timestamps and optional per-case snapshots; report this limitation.
The exact original libuv assertion trigger remains undiagnosed, not fixed in
Node itself. Add a contract for recorder context, timestamps and bounds, run
contracts in Actions, then dispatch once with `run_cohorts=true` and
`run_webkit=false`. A separate default-false WebKit input prevents accidental
repeat of the completed WebKit cohort. WebKit follow-up is read-only code and
existing-evidence analysis. Product fixes remain subject to approval.

### WebKit read-only follow-up

The retained voice trace from `36225934786` adds two observations:

- A `ResizeObserver loop completed with undelivered notifications.` page error
  occurs at trace time15421.578, during the **first, successful** landscape
  transition (viewport call15200.032). It is not direct proof of the later
  failure: the failing landscape call starts16244.685 and has no additional
  recorded loop error.
- Snapshot `after@call@100` at16767.570, after settling that failing transition,
  explicitly adds the `Jump to latest messages` button. Unlike the geometry
  samples, this is evidence that the UI was notified of a non-bottom position.
  Snapshot HTML uses references; absence of the literal in later deltas does
  not prove removal.

`chatScrollController.ts`, `chatScrollGeometry.ts`, `useChatScroll.ts` and
`ChatShell.css` have no diff between the pinned main and voice products.
The composer resize helper differs only by the unused-in-this-case voice
transcript append callback. No evidence establishes voice-only causation.

The controller checks `isIndependentScroll` before enforcing `following`.
A classification as independent calls `captureUserPosition`, which can switch
following off and retain a historical anchor. Conversely, if following stays
true and the last observed geometry is184px tall at top7877, a correction at
179px with unchanged content8061 should write7882, not retain7877.
This narrows the remaining question to actual controller state/callback
sequencing (including independent-scroll classification), but does not answer
it: the retained sampler observes document scroll and viewport resize, not
controller state or ResizeObserver delivery. The button alone is not a
snapshot of `following`.

The existing composer ResizeObserver synchronously remeasures textarea height
when its width changes; the header has geometry-affecting transitions. Both
are investigation context, not proven causes. Do not remove transitions,
force-follow after all resizes, alter the4px threshold, or change manual
scroll/history anchoring based on this evidence. Product changes still need
separate approval and a causal regression case.

### Windows-only supplement result

Contracts `36227022903` and supplement `36227059166` passed at harness
`b3613f62a537f121d8a6bfcf7853f0af06758b2f`; five metadata contracts passed.
The product remained `20f5f0e3e55569a4ac7f0878f314f1d8c7b2e009`.
Both Windows arms used Node24.20.0 and runner image20260920.314.1.
WebKit was skipped as approved.

Sampling0 and sampling1 each completed3/3rounds, all four modes per round.
Every Sense/Whisper invocation passed17cases with1existing skip; invalid and
disabled modes passed1case each. That is108passed/6skipped case executions per
arm, not216unique tests. All24original post-stop directory assertions passed;
all24post-stop snapshots contained0directories, with empty initial baselines.
Six retained lifecycle reports each contain16events,0dropped and no error or
snapshotError. Sampling1 emitted216before/after records with empty directories;
sampling0 emitted none, as expected.

Removing the watcher eliminated the native assertion in this collection.
This is a repaired diagnostic harness, **not a fix for the original leak**.
The leak did not reproduce in either arm, so neither a cause nor the absence
of an instrumentation timing effect is established. The approved supplemental
budget is exhausted; no further batch or product change was started.

| Artifact | ID | Bytes | SHA256 |
| --- | --- | --- | --- |
| `windows-cleanup-sampling-0-36227059166` |10901048865|1723253|`522b52ad5c54a0e07636405d43db7fcb1a89f170ba3144928a1a0f7ecaaaa55f`|
| `windows-cleanup-sampling-1-36227059166` |10901435657|1723282|`c6fce70e738ee5e9d6ba3ba7e01eb34b3dd05fbb6ed503fb5f3eb122490dbdd5`|

Artifacts expire2026-10-10; local evidence is retained under session files
`voice-pr-diag-36227059166/`. PR #2 remains Draft. Windows's original residual
and the reproduced WebKit orientation failure remain unresolved.

## Approved WebKit controller-state diagnosis

The user approved a new WebKit-only bounded diagnosis, then explicitly selected
Actions-product-copy instrumentation instead of a permanent product debug
interface. This is a separate budget from the completed geometry comparison.
Written-spec review and an implementation plan precede implementation.

### Isolation and alternatives

Keep tracked production controller, geometry helpers, composer and CSS
unchanged. A test-owned instrumenter modifies only the disposable pinned
product checkout inside Actions. Before writing, require an exact expected
controller revision and uniquely matched insertion sites; mismatch fails
explicitly without a partially instrumented output. Retain original and
instrumented SHA256 values plus the instrumentation diff in the artifact.
Apply identical instrumentation to both baselines:

- Main: `638c553c62406dbb7e6b5aeb41cdddf4cd6de179`.
- Voice: `20f5f0e3e55569a4ac7f0878f314f1d8c7b2e009`.

A permanent production debug hook would increase shipped surface unnecessarily.
External geometry-only sampling cannot resolve internal state transitions.
The selected overlay avoids both limitations, but its extra reads and recording
can still affect scheduling; a passing result cannot establish absence of a race.

### Observation and evidence

Use a test-owned typed recorder with an explicit event/state schema. Browser
initialization enables it only for this diagnostic case. Give controller
instances page-local numeric IDs; record relative timestamps and event order.
Capture callback entry, relevant branch decisions and state transitions for
layout correction, independent-scroll classification, user-position capture,
ResizeObserver delivery, correction scheduling and scroll-position writes.
Include user-intent and lifecycle transitions needed to distinguish an
intentionally suspended/disposed controller from missing correction delivery.

Record `following`, `userIntent`, `jumping`, `suspended`, `disposed`,
`multiTouch`, `scrollbarDrag`, pending-correction state, anchor-presence only,
`expectedTop`, `lastTop`, cached/current numeric geometry, scrollTop and the
requested write target where relevant. Record the decision actually taken,
not a second evaluation of a predicate presented as the original result.
Do not change predicate order, thresholds, scroll writes, scheduling policy,
event registration semantics or return values. No chat text, anchor text/DOM
references, audio, transcript, credentials or persistent user identifiers.

Each page retains at most2048state events with a dropped count; errors have
a separate bound of16 and an overflow count. Do not overwrite earlier events.
Missing initialization, zero controller events, malformed reports or capture
errors are explicit collection failures. Saturation marks evidence incomplete,
not a complete successful diagnosis. Preserve the original test failure and
available partial evidence even when collection also fails. Attach state data
beside existing numeric geometry and final-geometry reports, with pinned
product/harness identity and repetition index.

### Workflow and stop rules

Extend the existing manual diagnostic workflow, with independent default-false
Windows and WebKit gates. The new state-diagnostic dispatch runs no Windows
jobs. No temporary push registration or default-branch modification is needed.

Use the existing Node24.20.0, Ubuntu24.04 and lockfile-defined browser tooling.
Run contracts first in Actions: injection succeeds only on the expected source,
rejects changed/missing/duplicate sites before writing, preserves the original
product body except declared instrumentation, and records correct state,
timestamps, ordering, bounds and explicit capture failures. Verify instrumented
TypeScript via the existing build/typecheck in Actions. No local validation,
dependency installation, server or browser execution.

After contracts pass, dispatch exactly one batch, main and voice each at most
3repetitions of the existing orientation round-trip case. Keep its actions,
settling helper and4px acceptance threshold unchanged. Each arm uses1worker,
0retries and max-failures1; a failure stops that arm, not the other arm.
No additional browser smoke batch or automatic retries. Upload available
evidence even on failure, including provenance and instrumentation diff.

Classify each arm as reproduced, not reproduced within its completed budget,
or collection blocked/incomplete. Report actual counts rather than requested
counts. A causal conclusion requires a recorded path linking state/decision to
the missed bottom correction; a ResizeObserver error or button appearance
alone is insufficient. Keep PR #2 Draft. Any proposed product fix must explain
its evidence and effect on manual scrolling/history anchoring and receive
separate approval before implementation. Licensing and accuracy work stay paused.

### Controller-state execution and causal evidence

The written specification was approved, with inline execution. Red contracts
`36228324769` failed for the intended missing instrumenter; green contracts
`36228414785` passed10/10 at harness
`60851557134a6df63aa91e3e56f695c6afbedc42`. The only cohort batch was
`36228445199` at that same harness, dispatched with Windows false/WebKit true.
Both product builds/typechecks passed; Windows was skipped.

| Arm | Completed result | Remaining not run | Controller events |
| --- | --- | --- | --- |
| Main | Repeat0passed; repeat1failed at16px vs4px, cycle1 landscape |1|184(pass),111(fail)|
| Voice | Repeat0failed at5px vs4px, cycle1 landscape |2|107(fail)|

All3state reports have0dropped events,0capture errors and0error overflow.
Each failing test has only the original orientation assertion error, not a
diagnostic-collection error. Both original controller hashes are
`3ebb63ffe07e976b9f0c3154206418a5691dd3c3a5f96f69d3af1d63eb69f94e`;
both instrumented hashes are
`13c8066e8988cab7eaa409031c9a9ca103dfecfc32218c08a1eb14230d042ebb`.
The retained diff records all injection changes. Node24.20.0 and runner
image20260920.314.1 match in both provenance reports.

The two failures expose the same stale-layout-state path, not merely a missing
final resize notification. Event sequence numbers below are zero-based within
each failing page, controller1; times are performance milliseconds.

| Stage | Main repeat1 | Voice repeat0 |
| --- | --- | --- |
| Bottom write recorded | #89 at2851: height192, top/lastTop7869 | #85 at3965: height181, top/lastTop7880 |
| Intermediate expansion clamps top by3px | #93 at3124: height195, top7866 | #89 at4135: height184, top7877 |
| Scroll correctly classified as layout | #95 `scroll:layout`; cached height192/lastTop7869 unchanged | #91 `scroll:layout`; cached height181/lastTop7880 unchanged |
| Following frame sees final height179 | #101 at3127 `correct:independent`, top7866 vs cached lastTop7869 | #97 at4137 `correct:independent`, top7877 vs cached lastTop7880 |
| Position capture disables following | #103 at3132: followingfalse, anchorpresent | #99 at4141: followingfalse, anchorpresent |
| Resize callback is delivered afterward | #104 at3133 | #100 at4141 |
| Historical-anchor correction preserves wrong gap | #108-110 at3351-3352 write7866, final16pxgap | #104-106 at4274 write7877, final5pxgap |

Width844 and contentHeight8061 are unchanged over each critical intermediate
expansion/final contraction. `userIntent` isfalse throughout this sequence;
neither page has an `intent:marked` event. The test performs viewport changes,
not a manual scroll gesture during these transitions.

Explanation supported by both recorded branches:
`onScroll` accepts the intermediate top as a valid layout clamp and schedules
correction, but retains the geometry/lastTop from the earlier write.
Before that correction executes, the viewport contracts again.
`correctLayout` then applies `isIndependentScroll` using the stale pair.
Clamping the stale lastTop against the *final* maximum7882 produces7869/main
or7880/voice, which differs from the actual top by3px, beyond the1px layout
tolerance. It therefore calls `captureUserPosition`, and the non-bottom
position turns following off. The next callback now deliberately preserves
the captured historical anchor instead of restoring bottom following.

This establishes the causal path for these instrumented reproductions in
both pinned products. It does not prove every earlier uninstrumented failure
had this path or identify every source of intermediate size changes.
The diagnostic reads can affect scheduling. Nevertheless the observation
rules out voice-only causation and missing ResizeObserver delivery for these
two failures, while reproducing the prior5px/16px symptoms without changing
test thresholds or scroll policy.

### Proposed product-fix boundary (not approved or implemented)

Candidate: in the controller's already-classified layout-scroll path, retain
the accepted intermediate geometry/top for subsequent independent-scroll
classification, without changing following or the historical anchor.
Reason: avoid reinterpreting a previously accepted layout clamp as user
movement merely because another resize occurs before the queued frame.
Review `expectedTop` handling together with that transition; do not blindly
force following, ignore genuine manual/programmatic independent scrolling,
remove CSS transitions or widen tolerances.

Before implementing, obtain separate approval for the controller change and
focused regression coverage. A deterministic regression should replay both
recorded expansion/contraction sequences and remain failing before the fix.
Guard genuine independent/user scrolling and historical reading-anchor
behavior as well as bottom following, then use existing Actions browser
coverage. No component replacement is proposed. No product code was changed
by this diagnosis, and no further batch is authorized by the completed budget.

| Artifact | ID | Bytes | GitHub SHA256 |
| --- | --- | --- | --- |
| `webkit-orientation-main-36228445199` |10902250320|1487996|`8c883662d457b19f1a89b938cedeb1497bd06343493ec8f9a9369d7788cd8125`|
| `webkit-orientation-voice-36228445199` |10902345145|1294740|`6b2a296bc652874851eba7c8c0a11321f03bf2ea294f2fad10eaaf67502247e0`|

Artifacts expire2026-10-10; local reports and traces are retained in session
files `webkit-state-36228445199/`. PR #2 remains Draft. Windows's original
residual-directory cause is still unconfirmed; licensing and accuracy remain
paused.

### Subsequent approved repair

The previously proposed product-fix boundary was subsequently approved,
specified and implemented as51c9708. See
`2026-09-26-scroll-layout-cache-design.md` for deterministic pre-fix red
contracts, green25/25contracts and ordinary three-browser acceptance in
36229180746. Only accepted-layout cached geometry/top and stale expectedTop
were changed. The diagnostic evidence and budget records above remain
historical; no diagnostic batch was repeated to validate this repair.
Windows cleanup uncertainty and Draft PR status remain unchanged.
