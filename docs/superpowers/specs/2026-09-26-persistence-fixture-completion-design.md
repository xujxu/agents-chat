# Persistence Fixture Completion Boundary

## Approved scope

The user approved an independent completion signal for the persistence test
fixture: keep dispatch observation intact, change no product code, and suppress
no errors. This repairs the demonstrated fixture lifecycle gap, not every
persistence failure. All execution remains in GitHub Actions.

The source baseline is14875f2. In run36232557503 the lost-acknowledgement case
passed its final functional assertion, then closed its context while the
fixture's synthetic reply POST was outstanding. `sent.push` precedes that
write and is not a completion acknowledgement.

Run36233497979 has a different failure: its GET returned ECONNRESET before
finally navigation or context closure. A concurrent fixture GET and subsequent
POST/DELETE succeeded. That transport cause remains unresolved. The retained
read-only evidence is in session files
`persistence-reset-36233497979/analysis-summary.json`; artifact10903273196,
archive SHA256
`760ca7d16bcdad07a53ec3c772fb19d7e2d2f3b9618bbf1a6a647b65caaddba3`.
Neither concurrency nor earlier EPIPE/later ACP timeout logs establish its cause.

## Chosen design and alternatives

Preserve `sent` as a record of received send requests. Add explicit completion
tracking for the existing asynchronous ACP send callback, using a focused
test-only helper under `tests/helpers/`. Keep fixture installation, payload
construction, routing and persistence assertions in their existing locations;
do not broadly extract or refactor the entire fixture.

Moving `sent.push` to the end would hide dispatch while work is pending and
weaken negative assertions. Adding sleeps, request retries or ignored route
errors would obscure failures. Neither is acceptable.

## Lifecycle contract

For each accepted `action: send`, register its tracked operation synchronously
before the first await, retaining the existing arrival-order `sent` update.
Success requires all three existing stages to finish:

1. Read stored chat and record whether the user message was saved before send.
2. Write the synthetic reply and check the HTTP result.
3. Await `route.fulfill` successfully.

Expose a fixture method that waits for an exact expected count of received send
operations and their successful completion. Preserve ordered dispatch-count
assertions: an extra dispatch must not be treated as success by an
at-least-count check. Waiting must use existing bounded test/assertion timeouts,
not a new longer timeout or fixed sleep.

Keep failures available to both the route callback and explicit wait/drain.
Tracking rejection must not create an unhandled secondary Promise rejection.
Observing a Promise rejection for bookkeeping is permitted only when its
failure remains stored and is explicitly rethrown; it is not a success fallback.
Do not remove failed operations before the waiter can observe them.

The helper owns only send-operation lifecycle, not network retry, serialization,
HTTP interception policy, or production state. It must not report success while
the operation is pending or after any tracked stage has failed.

## Fixture consumers and cleanup

Audit every successful-send consumer of `installPersistenceFixture` in
`tests/chat-persistence.spec.ts`, including both sends in the large-message/
attachment case. Before relying on the callback's persistence effects, starting
a dependent send, normal reload or teardown, wait for the expected completed
send count. Keep assertions on original text, counts, saved-before-send ordering,
stored messages, attachments, UI replies and no duplicate dispatch.

Negative `sent` assertions remain arrival-based and unchanged. Tests intentionally
holding or interrupting a save retain those semantics: completion waiting must
not be inserted ahead of the release/reload that the scenario is meant to test.
Release existing test gates before final lifecycle draining.

Centralize the fixture-owned teardown sequence rather than copying it into
every test. Stop new page traffic with the existing about:blank navigation,
wait for already-started tracked send callbacks, then delete the fixture chat.
This final drain also handles failure exits where the main test never reached
its positive completion wait. Navigation is not context destruction: the
context/request client remains alive until tracked work has settled.
Do not use `unrouteAll({ behavior: 'ignoreErrors' })` or silently catch a failed
write/fulfillment. Work arriving after teardown begins must be an explicit
fixture violation, not an untracked operation or synthetic successful response.

Ensure cleanup failures are reported, and attempt the existing fixture-chat
deletion after settled send failures without hiding either failure. Preserve
special cleanup for additional recovered chats and release hooks in individual
tests. Do not delete the fixture chat while a tracked synthetic write is pending.
Do not add global chat deletion or change intentionally deleted-chat semantics.

## Regression coverage

Add deterministic helper tests with deferred operations, not wall-clock races:

- Dispatch is visible while completion is blocked.
- Completion remains pending through read, write and fulfillment stages.
- Releasing every stage allows completion exactly once; records retain arrival
  order even if concurrent operations settle out of order.
- Rejection in any stage rejects waiting/draining with the original failure.
- Failed operations remain observable after settlement; extra dispatch is not
  accepted as the expected count.
- Teardown prevents new accepted sends and waits for existing work before
  deletion; deletion still runs after a settled failure, with errors surfaced.

Add a Playwright regression against the actual persistence fixture that holds
the synthetic reply write, observes dispatch without completion, releases the
gate and verifies completion before cleanup. Gates are test-only and always
released on failure. Deterministic helper checks cover failure propagation;
do not manufacture an unhandled route exception that invalidates the entire
Playwright worker merely to exercise that branch.
The exact helper API and mechanism will be specified in the implementation plan.

Keep existing large-history, lost-acknowledgement, interrupted-save, no-dispatch,
attachment and browser assertions. Do not reduce payload sizes, remove cases,
widen thresholds or change retry settings to obtain a passing run.

## Validation and decision boundary

After written-spec approval, prepare an inline plan, then add failing regression
coverage before implementation. Run focused helper/fixture red-green checks in
Actions, followed by the existing persistence workflow at the repaired revision.
Use an existing suitable runner/selector or a narrow workflow selector; no
indefinite repetition, new Windows/voice diagnostic cohort or connection tracing
experiment is authorized.

If ECONNRESET returns, retain its evidence and report the separate unresolved
failure instead of adding a blanket retry. A passing run alone does not prove
that transport failure fixed. Report fixture lifecycle acceptance separately
from overall persistence integration status.

Record exact revisions, runs, failure/skip counts and artifact locations.
Keep PR #2 Draft. No voice cleanup ownership change, product persistence edit,
licensing work, release or merge is included.

## Execution evidence

Written specification8da51e0 and inline plan5409d15 were approved. Implementation
changed only tests and their workflow, with no product source changes.

| Revision/run | Outcome |
| --- | --- |
| Tests15be8f4 /36237914612 | Intended missing-helper import red; persistence job skipped |
| Helpera9b7770 /36237963315 |7/8passed; out-of-order test exposed delayed outcome publication |
| Correctionaa9aec9 /36238009699 |8/8passed; no assertions relaxed; persistence job skipped |
| Actual fixture13c98eb /36238088471 | Contracts and full persistence jobs passed |

The helper originally used a second Promise reaction to publish its outcome.
That allowed a caller awaiting the original operation to resume before the
completion counter reflected it. The correction publishes outcome in the first
observer; original rejection propagation is retained. The deterministic test
caught this helper defect before actual fixture integration.

Fixture revision `13c98eb202e8de8b5fea5b2a307bb5debdd9c747` tracks read,
synthetic write and fulfillment together. Positive send consumers explicitly
await completion, including both large-message/attachment sends and the
lost-acknowledgement case. Negative dispatch assertions and intentional
in-flight-save releases/reloads retain their original meaning. Final disposal
stops page traffic, drains existing sends and checks fixture-chat deletion;
late sends and operation/deletion failures are surfaced.

Full persistence run36238088471 used generated PR integration revision
`bede9aef0f1639e6220e2a6d6e7f0a649f0dbfa8`, parents main638c553 and13c98eb.
This is a CI integration checkout, not a merge of PR #2.

| Acceptance step | Result |
| --- | --- |
| Dependency-free completion contracts |8passed|
| Existing persistence logic runner |13passed|
| Build and typecheck |Passed|
| Desktop history/API/failure/selection cases |50passed|
| Existing send behavior |8passed|
| Android and iPhone persistence |40passed|
| Existing repeated WebKit network/reload selection |12passed|

The new blocked-reply-write case passed on desktop Chromium, Android Chromium
and iPhone WebKit. It observes arrival with zero completed sends while the write
is held, then verifies completion after release and safe fixture disposal.
The helper contracts independently hold all three stages, preserve rejection
identity, reject extra/late sends and verify drain-before-delete ordering.
No fixed sleeps, request retries, ignored route errors or increased timeouts
were introduced. The12repeated cases are the preexisting workflow step,
not a new diagnostic cohort.

Artifact `chat-persistence-evidence`, ID10905595520,13938bytes, GitHub archive
SHA256 `c9b6d5937d57b625cde515f395c41dfd66952e2c7351ae4a9b1f6d42c48e4fe4`,
expires2026-10-03. Retained in session files `fixture-completion-36238088471/`.

The approved fixture completion gap is addressed and this persistence run
passes. The original36233497979 ECONNRESET remains unexplained; non-recurrence
does not establish that the lifecycle change repaired its transport cause.
Original Windows voice residual ownership/cause also remains unresolved.

## Remaining overall PR checks

At the same fixture revision, ordinary voice36238088478 passed both jobs and
typography36238088453 passed all3jobs. Full E2E36238088445 did **not** pass:
4jobs succeeded and2jobs failed with different assertions outside this fixture.

| Job | Failure | Counts |
| --- | --- | --- |
| Android Chromium | `tests/voice-input.spec.ts:78` cannot find exact recording label `Recording 0:01 / 0:30` within existing5second assertion; cancellation case at line161 |119passed,3skipped,1failed|
| Desktop shard3 | `tests/test-ui.spec.ts:3984` streaming-thinking case expects unchanged save count1 but observes2 |76passed,2skipped,1failed|

Neither file imports `fixtureCompletion` or `installPersistenceFixture`.
This is a scope distinction, not proof of a root cause or proof that they are
harmless flakes. No change to those assertions, production behavior or retries
was made, and the workflow was not rerun to obtain a green status.

Retained GitHub artifacts, expiring2026-12-25:

- Desktop3: ID10905266151, `playwright-artifacts-desktop-3`,6214665bytes,
  archive SHA256
  `89a50f9e7daca34009f89fb72bcfa899923758395870dbc41d63992191d3a1a2`.
- Android: ID10904906609, `playwright-artifacts-android-chromium`,28358433bytes,
  archive SHA256
  `4fe26ceb7e1111702124d91471a38b52be12018b2505d3dad2df6440acc44c84`.

Only failure logs and artifact metadata were inspected for these two new
signatures; detailed trace attribution is not part of the approved fixture
repair. Overall PR acceptance remains blocked pending separately scoped
analysis. Keep the successful fixture acceptance and failed broader checks
distinct; PR #2 remains Draft.
