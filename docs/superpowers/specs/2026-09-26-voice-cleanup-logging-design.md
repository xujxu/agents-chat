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
