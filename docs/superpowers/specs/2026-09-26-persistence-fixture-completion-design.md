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
