# Streaming Save Baseline Test Boundary

## Approved scope

The user approved approach A: repair only the streaming-thinking persistence
test's baseline boundary, with a focused test helper. Identify initial pending
user persistence and successful dispatch-confirmation persistence before
freezing the no-stream-save count. Reject unexpected saves instead of filtering
them out or blindly accepting a count of two.

The source baseline is5e1b666d8ee8ade79e61b6ce9fe0dd21d127d840.
All validation runs in GitHub Actions. No production behavior, timeout, retry,
payload, persistence protocol or native diagnostic policy changes are included.
The previously accepted recording-readiness repair remains unchanged.

## Evidence and limits

In full E2E run36238088445, the streaming-thinking case in
`tests/test-ui.spec.ts:3905-3996` captured a count of1 at trace time181210.502.
A second save began at181221.454, about11ms later. It contained the same user
message with pending/resend fields removed and an empty pending agent
placeholder. Neither counted payload contained thinking text or agent parts.
The final-answer stage was not reached.

This matches the explicit `confirmUserMessageDispatch` save in
`app/features/chat/runtime/useChatRuntime.ts:340-350,498-500`.
`chatAcpService.ts:165-183` creates the pending agent before dispatch.
`incrementalChatSaver.ts:15-22` removes agent parts from client save payloads.
The existing test observes request arrival, not acknowledgement, and freezes
its count as soon as any saved user message is found.

Retained evidence: session file `e2e-36238088445-analysis.json`;
desktop artifact10905266151, archive SHA256
`89a50f9e7daca34009f89fb72bcfa899923758395870dbc41d63992191d3a1a2`.
The extra save is consistent with dispatch confirmation, not a demonstrated
thinking-content save. Later full E2E36251380383 passed, but did not repair
this baseline race.

## Alternatives

Chosen: recognize the two allowed payload transitions and their successful
HTTP/API acknowledgements. This makes the baseline meaningful while preserving
the prohibition on streaming saves.

Waiting only for count2 cannot distinguish a confirmation from an unwanted
stream save. Adding a fixed settling delay can still race and lengthens the
test. Neither alternative is used.

## Save observation and allowed transitions

Keep every observed chat-save request in arrival order, including requests
whose responses are pending or fail. Non-save actions such as `set-last-chat`
are explicitly distinguished from save operations; unknown save shapes must
fail, not be silently discarded.

Setup traffic remains separate from this single turn. Establish the setup
boundary before dispatching the user message, retain the setup observations,
and require outstanding setup saves to settle before beginning the turn.
Do not remove or disregard an unexpected save after that boundary, even if
its chat ID or message ID does not match the expected turn.

The controlled one-agent, one-user-message turn allows these transitions:

1. Initial user save: the expected user text and stable message/chat IDs,
   with `sendStatus: pending` and the existing resend metadata. No agent
   thinking, response text, or parts may be present.
2. Dispatch confirmation: the same user message and chat, with pending,
   send-error and resend fields cleared. An empty pending agent placeholder
   for the selected agent is allowed; loading/thinking status metadata alone
   is not response content. It must contain no response text or parts.
3. Final save, only after the test releases turn completion: the expected
   final agent content. Preserve the existing exact one-additional-save
   assertion and check that the final agent belongs to the same chat/turn.

Use the actual delta-operation shape and stable IDs, not array-position or
substring guesses. Message IDs and content must agree across transitions;
duplicate initial/confirmation operations, deletions, additional messages,
foreign-chat saves, malformed save bodies and any pre-completion thinking/
stream content are violations. Do not treat a failed operation as acknowledged.

Before freezing the baseline, exactly the initial and confirmation saves for
the turn must have arrived and successfully completed the fixture's response
boundary. Validate the real backend response's HTTP status and API success,
then complete route fulfillment before recording acknowledgement. This proves
backend success and response delivery by the fixture, not that every frontend
promise reaction has run.

## Architecture and error handling

Add `tests/helpers/streamSaveBaseline.ts` for typed save observations,
semantic classification, and readiness evaluation. Keep the ACP mock's
thinking/final events and the user-visible assertions in the existing test.
Do not extract unrelated portions of the large UI spec.

The test continues to use the real chat API. For observed save requests, fetch
the real response, validate it, and fulfill the original request with that
response. Do not substitute mock save acknowledgements. Record request arrival
before asynchronous work and acknowledgement only after fulfillment. Retain
HTTP, API, malformed-response and route errors for explicit assertion/draining;
do not catch them as success or hide them in an unobserved callback.

The helper exposes a pending result until both required transitions are
acknowledged, a ready baseline only for the complete valid sequence, and an
explicit failure for invalid sequences or retained operation errors. Pending
state must not erase evidence. The existing bounded10-second persistence
assertion performs readiness waiting.

After the baseline and visible thinking are established, preserve the existing
2500ms observation interval and require no additional save arrivals. Continue
checking all pre-completion payloads, including saves that arrived before the
baseline, so waiting longer cannot absorb a forbidden stream save.

Set `finishTurn` only after the no-save check. Keep the existing final text,
hidden Stop-generation control, and baseline-plus-one save assertions. Also
wait for that final save's successful response before ending the fixture.
Release any test-owned gate in `finally` and drain started save callbacks while
the page context is alive. Teardown must not manufacture success or suppress
route failures. Reuse existing focused completion utilities where applicable.

## Deterministic regression and acceptance

Exercise the helper used by the real test, not a duplicate predicate. Add
deterministic contract cases for initial-only observations, confirmation
arrival with acknowledgement still held, acknowledged valid transitions,
duplicate/extra saves, invalid IDs/payloads, early stream content, and response
failure. Only the complete acknowledged valid sequence can yield a baseline.

In the actual UI scenario, hold the dispatch-confirmation response with an
explicit test gate after the real backend responds. Allow ACP thinking polls
to proceed independently. Once the confirmation is held and thinking is
visible, assert that the actual baseline evaluator still reports pending;
then release the gate and require readiness. Release and drain on failure as
well. The gate is a controlled event, not a new fixed delay.

First retain the old arrival-based readiness behavior in the extracted helper
and add the held-confirmation regression. Actions must demonstrate the
intended early-readiness failure while the response is held. A missing export,
bad fixture payload, timeout before reaching the gate, or unrelated build
failure is not causal red evidence.

Implement the minimal semantic/acknowledgement repair without weakening that
regression. Require the new contract cases and existing streaming-thinking
UI scenario to pass, including final-response persistence. Use existing
Actions E2E/build coverage and preserve all suite selectors, timeout values
and retry settings. Record source revisions and actual red/green run results.
Do not rerun unrelated failures until green.

## Non-goals and completion

No product save suppression, protocol serialization change, agent dispatch
change, persistence-fixture rewrite, or broad test refactor is authorized.
Historical ECONNRESET and Windows residual causes remain unresolved. Licensing,
accuracy studies, releases and merges stay outside this scope.

Completion requires causal red/green evidence for the held-confirmation
boundary, strict payload/count protection before turn completion, final-save
success, and persistent acceptance evidence. PR #2 remains Draft.

## Accepted execution evidence

Initial red source c38382e7f7c7abca9e3054af0870c2cfb25d3c38:
[E2E36287256431](https://github.com/xujxu/agents-chat/actions/runs/36287256431)
failed the two baseline contracts. The real browser trace also reached the
held-confirmation assertion and returned2 instead of pending, but a subsequent
fixture teardown error obscured it in the job log. That late request was
`set-last-chat`, not a chat save. The fixture had incorrectly enrolled every
POST in save-completion tracking.

Fixture-only correction f38aa52b58e2e124018f6ef887b5834909b3d6d9 explicitly
distinguishes this metadata action before save tracking, retaining its shape
assertion and normal route-error propagation. Unknown save actions still fail.
No errors were caught or ignored and the old evaluator remained unchanged.
[Corrected red36288035696](https://github.com/xujxu/agents-chat/actions/runs/36288035696)
then exposed precisely the intended held-response failure, received2, with no
teardown violation. Desktop2 had79 passed/2 expected contract failures;
desktop3 had78 passed/2 skipped/1 expected browser failure. Other4 jobs passed.

The inspected initial-red desktop3 artifact10920812695 is2835256 bytes;
archive SHA256
`6f5c37b7879222ba0246a04d4456ac6327c4a89e66c86d32c71f95cbc93c6fdb`.
Trace `expect@176` at194041.672 records the held-response assertion; the
metadata request appears at194059.986. Paired browser and `route.fetch`
network records are not duplicate frontend saves.

Repair source **6a261b91b450e4c84d53645d3d3678a01eaf660f** changes only the
baseline evaluator after the clean red checkpoint. It validates the complete
sequence, rejects additional pre-baseline saves, and waits for both successful
acknowledgements. The regression expectations are unchanged.

| Acceptance at6a261b9 | Result |
| --- | --- |
| [Full E2E36288645244](https://github.com/xujxu/agents-chat/actions/runs/36288645244) | All6 jobs passed; desktop shards81,81,79,46 passed, with2 and35 existing skips in the latter two; Android123 passed/3 skipped; iPhone122 passed/4 skipped |
| Streaming contracts | All4 passed in desktop shard2, including pending acknowledgements, invalid/extra saves, explicit response failures and final identity/release |
| Actual streaming UI regression | Passed in desktop shard3, including held-confirmation pending state,2500ms no-save interval and acknowledged final save |
| [Persistence36288645351](https://github.com/xujxu/agents-chat/actions/runs/36288645351) | Passed |
| [Typography36288645251](https://github.com/xujxu/agents-chat/actions/runs/36288645251) | Passed |
| [Voice36288645247](https://github.com/xujxu/agents-chat/actions/runs/36288645247) | Passed |

The streaming contracts and UI case are desktop-selected; the Android/iPhone
jobs cover their existing suites, not these newly added cases. All validation
ran in Actions, with no manual reruns or local validation. This accepts the
scoped test repair, not every persistence path or a product persistence change.
Historical ECONNRESET and Windows residual causes remain unresolved.
