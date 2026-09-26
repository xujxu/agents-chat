# Voice Recording Readiness Test Boundary

## Approved scope

The user approved approach A: repair only the recording readiness prerequisite,
using active recording with displayed elapsed time from 1 through 29 seconds.
Keep the existing five-second assertion window, product behavior, and all
subsequent functional checks. All validation runs in GitHub Actions.

The source baseline is ef588b43640d082c089ff54c7d11ee1301bd8f81.
This specification does not include the independent streaming-save baseline
repair; that requires its own design and implementation cycle.

## Evidence and limits

In run36238088445, the Android cancellation case failed at
`tests/voice-input.spec.ts:78`, before uploading or cancelling transcription.
The exact `Recording 0:01 / 0:30` assertion ran from trace time273099.539
through278111.420. A screenshot at274234.773 shows that exact label; later
snapshots show recording at five and six seconds. The trace contains one voice
GET and no voice POST or DELETE.

Artifact10904906609 has archive SHA256
`4fe26ceb7e1111702124d91471a38b52be12018b2505d3dad2df6440acc44c84`.
The bounded analysis is retained in session evidence
`e2e-36238088445-analysis.json`, with the screenshot in
`e2e-36238088445-android/recording-frame-274300.jpeg`.

The latest inspected automatic run36238857145 failed the same prerequisite in
the iPhone account-change case. Only its logs and artifact metadata were
inspected. These observations establish a fragile transient-label prerequisite,
not a cancellation defect or the precise browser polling/scheduling mechanism.

## Alternatives

The chosen approach observes the existing UI semantically: recording must still
be active and must have reached at least one displayed second. It tolerates a
missed intermediate display without extending the assertion window.

Freezing a virtual clock at one second would alter the relationship between the
browser audio graph and product timing. A fixed sleep would not establish
recording readiness at all. Neither alternative is used.

## Readiness contract

Readiness succeeds only when one observation establishes all of the following:

- The recording status is visible and its complete text matches the existing
  `Recording 0:SS / 0:30` format.
- `SS` is an integer represented by two digits, from01 through29 inclusive.
- The exact `Stop recording` button is visible and enabled.

Zero seconds, thirty seconds or more, another maximum duration, malformed text,
opening the microphone, transcription, idle state, and a missing, hidden, or
disabled stop button must not satisfy the predicate. Do not retain an earlier
valid status value and combine it with a later control state.

The wait uses Playwright's existing five-second assertion timeout and normal
assertion polling. It introduces no fixed sleep, additional grace period,
test retry, application-clock override, or synthetic elapsed-time state in the
real application. A timeout must report the expected readiness contract and
the observed status/control state. Unexpected browser/locator errors propagate;
there is no catch-and-pass fallback.

The lower bound describes displayed recording elapsed time, not a new guarantee
about captured sample count. Existing WAV assertions remain responsible for
audio payload checks. The 30-second automatic-stop case remains independent
and unchanged.

## Components and data flow

Add one focused test-only helper,
`tests/helpers/voiceRecordingReadiness.ts`, owning the readiness predicate and
bounded UI wait. Its typed observation contains only status text/visibility and
stop-control visibility/enabled state. It reads the existing recording status
and accessible control, without product exports or additional product hooks.
Use a single browser-side observation for the predicate's inputs.

`record(page)` in `tests/voice-input.spec.ts` keeps its start-button click,
initial stop-button assertion, and microphone-call assertion, then delegates
the final readiness wait to this helper. All its existing consumers receive the
same corrected prerequisite. Do not change cancellation routing, request-ID
checks, gate release, fixture disposal, or native-provider setup.

Place the regression cases in the existing voice-input spec so both the voice
workflow and the existing desktop, Android, and iPhone Playwright projects
execute them without widening suite selection. The helper has no responsibility
for microphone creation, uploading, cancellation, or persistence.

## Regression coverage and red/green proof

First extract the current exact-one-second wait without repairing its behavior,
then add a browser regression using controlled test DOM with an enabled stop
button and a visible two-second recording status. Invoke the same shared wait
used by `record(page)`. This models the first observation after missing the
one-second display and must fail against the old exact predicate in Actions.
It does not require manipulating the product clock or reproducing scheduler
timing.

Add deterministic observation-contract cases for accepted elapsed values01,
02, and29 and for every rejected category in the readiness contract. These
cases must check the actual helper predicate, not a duplicate implementation.
Include contradictory UI states, such as valid recording text with a disabled
stop button. Exercise the real DOM observation with controlled status/control
elements as well as the predicate inputs.

After the minimal helper repair, the unchanged two-second regression and the
contract cases must pass. Existing recording tests must then pass in desktop
Chromium, Android Chromium, and iPhone WebKit, including the three pending
transcription cancellation variants. Preserve WAV bounds/header checks, draft
protection, no automatic send, runtime-disabled behavior, explicit errors, and
the existing 30-second stop assertion.

Use the existing Actions workflows for build/typecheck and browser execution.
No local test server, test command, dependency installation, or model execution
is permitted. Inspect failed artifacts without rerunning until green. Record
source revisions and run IDs for the expected red failure and subsequent
acceptance; unrelated failures remain separate blockers, not evidence for or
against this repair.

## Non-goals and completion

Do not change production code, display strings, durations, audio capture,
native packages, cleanup policy, workflows' timeouts/retries, or release state.
Do not modify the streaming persistence test in this change. Historical
ECONNRESET and Windows cleanup-residual causes remain unresolved.

Completion requires a causal red/green regression for the skipped one-second
display and preserved existing voice behavior across all three browser
projects, with persistent Actions evidence. Draft PR #2 remains Draft.
