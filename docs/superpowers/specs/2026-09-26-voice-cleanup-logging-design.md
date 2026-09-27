# Voice Cleanup Failure Logging

## Scope and approval

The user approved independent sanitized cleanup-failure logging while preserving
existing semantics. This specification covers that visibility repair only.
Directory ownership, creation-failure cleanup, retries, sweeping, native helpers,
HTTP response changes, release and licensing work are outside scope.

The preceding actual-module characterization at c78952c, Actions36230917732,
established that cancellation hides an injected deletion failure in the response
and logged code. It did not identify the cause of the original Windows residual
in36224052311. This change must not be described as fixing that residual.

## Chosen boundary and alternatives

Log at the existing deletion boundary in `lib/voice/transcriber.ts`. This
boundary knows that the failed operation was cleanup, and is shared by Windows
and non-Windows transcription. Reuse `createLogger` from `../logger` and the
existing `voice.transcriber` logger name used by `lib/voice/process.ts`.

Wrapping cleanup failures in a new error type and propagating them to the route
would expand coupling and risk changing error precedence. Logging all errors
suppressed by cancellation in the route would not reliably identify cleanup.
Neither alternative is necessary for this scope.

## Behavior and data flow

Keep directory acquisition and the transcription body unchanged. Inside the
existing `finally`, surround the single awaited
`rm(directory, { recursive: true, force: true })` with a narrow try/catch.
On rejection, emit one warning with exactly these application-supplied fields:

```ts
{ code: 'voice_cleanup_failed', aborted: signal.aborted }
```

Use the constant message `Voice temporary directory cleanup failed`.
Then rethrow the same caught value, without wrapping or replacing it.
Use the normal synchronous logger call; add no special logging transport,
fallback, request identifier, asynchronous task or swallowed exception.
Standard logger envelope fields, such as timestamp and logger name, remain
unchanged. Do not pass the caught value to the logger.

The boolean records whether the signal is aborted when cleanup rejection is
handled; it does not claim cancellation caused deletion failure.

Preserve:

- One cleanup attempt, awaited before transcription resolves or rejects.
- Cancellation response499/voice_cancelled and its existing route warning.
- Non-cancelled cleanup-failure response500/voice_failed and route warning.
- Original cleanup rejection identity for direct transcriber callers.
- Job release and subsequent request admission even after deletion failure.
- No warning for successful cleanup, normal completion or creation failure.
- No deletion of prior residuals or preexisting/unowned paths.

Do not log raw errors, error messages, stacks, OS error strings, paths, request
or user identifiers, audio bytes, child output or transcripts. Do not change
`app/api/voice/route.ts`, its error selection, or the creation helper.

## Tests and evidence

Extend `tests/helpers/voiceFaultFixture.mjs` and
`tests/voice-cleanup-faults.test.mjs`, using the same actual five production
modules and bounded in-memory filesystem/native boundaries. Do not duplicate
production control flow or introduce a runtime fault-injection switch.

The logger mock must capture and validate the complete warning arguments,
including logger name, exact fields and message, rather than dropping unknown
fields before assertions. Reject unexpected payloads explicitly and retain
only allowlisted synthetic records in the evidence artifact.

Keep the six existing scenarios and subsequent normal control requests:

| Scenario | Additional cleanup warnings | `aborted` | Response |
| --- | --- | --- | --- |
| Normal | 0 | Not applicable | 200 |
| Cancellation, cleanup succeeds | 0 | Not applicable | 499/voice_cancelled |
| Cancellation, cleanup fails | 1 | true | 499/voice_cancelled |
| No cancellation, cleanup fails | 1 | false | 500/voice_failed |
| Helper fails before creation | 0 | Not applicable | 503/voice_process_failed |
| Helper fails after creation | 0 | Not applicable | 503/voice_process_failed |

For both cleanup failures assert the independent warning precedes the existing
route warning. Preserve cleanup-attempt counts, simulated residual counts,
timer release, subsequent admission and unknown-mode guard assertions.
Add direct actual-transcriber rejection checks for both cleanup-failure modes
to assert the thrown value is the injected cleanup error, not a wrapper or the
cancellation reason. Exercise mocked external boundaries only.

The historical characterization report/spec remains unchanged. New evidence
records the new source hashes and changed warning expectations; green tests
mean logging behavior meets this specification, not native leak remediation.

## Execution limits and acceptance

After written-spec approval, write an inline implementation plan and follow
red/green development. Push failing regression expectations before product
implementation, then implement the narrow logging change and repeat the
contracts-only Actions workflow. Both diagnostic cohort inputs remain false.
Repair fixture mistakes if necessary without relaxing the stated assertions.

All test execution, dependency installation, builds, type checks and servers
run in GitHub Actions only. Use existing build/typecheck and related Linux
voice/API regression workflows for integration acceptance. Inspect their
results; no new Windows/native/browser diagnostic budget is authorized.
No frontend behavior is changed, so no new UI-specific test is required.

Persist Actions identities and limitations in this specification and Draft
PR #2. Do not merge, publish, replace components or claim that logging itself
removes any residual directory. Creation ownership remains a separate design.

## Execution evidence

Written specification9df15da and inline execution plan1cd6983 were approved.
Regression tests638a35f preceded the product change:

- Red Actions36232508784:34tests,32passed,2failed precisely because the
  independent cleanup warning was missing. Both direct-transcriber rejection
  identity checks passed already; neither failed test was a fixture/link error.
- Product1dedadcf8cc0408fdb5d79c6a99328cd1c20b7b4 changes only
  `lib/voice/transcriber.ts`: existing logger plus narrow catch/log/rethrow
  around the single awaited deletion.
- Green Actions36232554524:34/34passed. Both Windows and WebKit diagnostic
  cohorts were skipped. All six API scenarios, their normal recovery requests,
  the unknown-mode guard and both direct rejection checks passed.

The green report records one independent `voice_cleanup_failed` warning before
the route warning for each deletion-failure mode. `aborted` is true for injected
cancellation and false otherwise;499/voice_cancelled and500/voice_failed remain
unchanged. Successful cleanup and creation failure produce no cleanup warning.
Simulated residual counts and single deletion-attempt counts remain unchanged.
The fixture checks complete warning arguments before capturing allowlisted
records, and verifies the original cleanup rejection object is preserved.

Artifact `voice-cleanup-faults-36232554524`, ID10902822164,1183bytes,
GitHub archive SHA256
`fa80f608f242805262271ec18e022dbbe181df7e3eebdba1a30e1ef9efbe009a`,
expires2026-10-10. Report retained in session files
`voice-cleanup-faults-36232554524/voice-cleanup-faults.json`.
The actual transcriber source hash is
`1d3bf921573d911a38f70a5255247a7ea848762e599bf43cf4f9305db6e0fa5a`.
The report's other four actual-source hashes match historical36230917732:
route, Windows wrapper, jobs and audio are unchanged.

Ordinary automatically triggered Voice input PoC36232557538 passed both jobs,
including build/typecheck,27logic tests,11WebKit capture/cancellation tests,
28API/Chromium tests plus1existing skip,1real-model API smoke test and17existing
composer/mobile/disabled-voice tests. The temporary-directory assertion passed.
It checked out PR integration revision
`9c295b41dca7676b21dc25860d6594b570e1c03b` (main638c553 plus head1dedadc),
not a merge of PR #2 into main.

Full E2E36232557443 passed all6jobs. Typography36232557446 passed all3jobs.
Persistence36232557503 did **not** pass: build/typecheck, persistence logic,
desktop persistence and existing-send steps passed, but mobile persistence
had37passed and1failed. The subsequent repeated WebKit network step was skipped.
Do not describe the full implementation-revision check set as green.

The failed case was `tests/chat-persistence.spec.ts:354`, iPhone WebKit,
lost commit acknowledgement. Its functional assertions passed in the trace;
an asynchronous fixture route callback at line137 was still writing its
synthetic reply when the test navigated away and tore down the context:

| Trace call | Relative time (ms) | Outcome |
| --- | --- | --- |
| `pw:api@94`, fixture POST `/api/chats` |247987.286start|Still pending during final assertion/cleanup|
| `expect@95`, stored-message count |248127.193end|Passed|
| `pw:api@96`, navigate `about:blank` |248128.047start /248154.962end|Passed|
| `pw:api@97`, delete fixture chat |248156.147start /248177.671end|Passed|
| `pw:api@94`, fixture POST |248186.334end|Target page/context/browser closed|

The fixture increments `sent` at line124 before awaiting its synthetic reply
write at line137; this test waits for `sent.length` and the user-message count,
not callback completion, before its finally block at lines364-367. The retained
sequence identifies an outstanding fixture operation across teardown. It does
not justify suppressing errors, widening timeouts or altering persistence
product behavior as part of the logging repair.

Failure artifact `chat-persistence-evidence`, ID10902778379,42446bytes,
GitHub archive SHA256
`c8d1e0201a82dd5d8525b41c53b94f3ed9a96d967b922f46638717f93c614f8f`,
retained under session files `cleanup-log-persistence-36232557503/`.
The small `test.trace` was inspected without running a local browser or test.
No rerun-to-green or unrelated fixture/product edit was performed.
Complete integration acceptance remains blocked on this separate failure;
a bounded fixture-lifecycle repair requires separate scope approval.

Automatic push checks also passed: provider36232554525 (contracts passed,
application skipped), Windows foundation36232554543, and natural-long
36232554551 (selection-tests/report only; inventory/compare skipped).
These were existing triggers, not newly dispatched diagnostic experiments.
No accuracy study or new Windows/WebKit comparison batch was launched.

The original Windows residual cause remains unknown. This repair restores
cleanup-failure visibility; it does not remove residuals, recover lost creation
ownership, or prove native deletion reliability.
