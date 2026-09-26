# Voice Cleanup Fault Characterization

## Scope and approval

The user selected actual-module VM boundary injection before any native Windows
fault helper. This is tests and evidence only, not a product repair. The two
questions are whether cancellation hides cleanup failure and whether a helper
failure after directory creation bypasses cleanup ownership.

Use the existing Node VM test approach without adding dependencies. Run only
in Actions. No local validation, browser/server, native compiler, model,
filesystem watcher or new Windows/WebKit diagnostic cohort.

## Actual code and mocked boundaries

Load unchanged `app/api/voice/route.ts`, `lib/voice/transcriber.ts`,
`lib/voice/windowsNative.ts`, `lib/voice/jobs.ts` and `lib/voice/audio.ts` in a
fresh VM context per case. Preserve their actual control flow and error
classes. TypeScript transformation must support the existing VoiceError
parameter properties, not just erasable types.

Mock the external boundaries: Next response/auth, logger, configuration,
provider process/decoding, OS/environment and filesystem. Use real promisify
against an injected execFile callback; run the actual native wrapper.
An in-memory directory set models existence and ownership, not Windows ACLs,
sharing violations or directory-delete implementation. No mock writes real
files, spawns processes, or creates actual request directories.

Use a real AbortController, real synthetic valid WAV and actual job reservation/
release. Inject cancellation when the mocked inference boundary is reached,
then throw the actual job signal reason; inject an EPERM-like deletion error
independently. Record sanitized boundary event names, returned response/log
codes, attempted cleanup, directory counts and subsequent admission recovery.
No real credentials, audio, transcripts, private paths or exception messages
are retained as evidence.

## Fixed cases and assertions

| Case | Injected behavior | Observed current behavior to characterize |
| --- | --- | --- |
| Normal completion | create/infer/delete succeed |200, cleanup completed,0directories|
| Cancellation control | inference aborts, deletion succeeds |499voice_cancelled, cleanup completed,0directories|
| Cancel plus cleanup failure | inference aborts, deletion rejects |499voice_cancelled, cleanup attempted,1directory, cleanup error absent from logged code|
| Cleanup failure without cancellation | inference succeeds, deletion rejects |500voice_failed, cleanup attempted,1directory|
| Creation failure before creation | execFile callback rejects before adding directory |503voice_process_failed, no inference,0directories|
| Creation failure after creation | execFile callback rejects after adding directory |503voice_process_failed, no inference, no cleanup attempt,1directory|

These are explicit characterization tests of current behavior, not assertions
that residual directories or lost cleanup evidence are desirable. Fail if a
scenario does not reach the intended boundary or response/log/cleanup ordering.
Assert job release and a subsequent clean successful request for each scenario.
Reset faults without deleting the simulated residual until its count and
ownership have been recorded; a control request cannot silently erase it.

Add fixture guards for unexpected module imports, forbidden native operations,
unknown modes and missing/invalid simulated paths. All injected failures have
explicit labels. Preserve test failures, rather than reporting partial
characterization as success.

## Execution and evidence

Add a focused test and helper, plus its selector to the existing manual
diagnostic contracts job. Run a missing-helper red check before implementation,
then one green characterization check after fixture implementation. Both
cohort inputs remainfalse. Repair fixture defects if needed, but do not
automatically escalate to native or browser collection.

The helper follows the existing VM pattern but stays voice-local; do not
refactor the unrelated scroll fixture. Tests execute actual production source,
not copied route/transcriber logic. Capture a small JSON report with source
hashes and scenario outcomes when an output path is supplied by Actions; upload
on failure as well as success. Mark incomplete scenarios explicitly.

Successful characterization establishes how current code responds to the
injected boundaries. It does not show that those boundaries occurred in
run36224052311, nor prove a Windows OS race. Keep that original cause
unconfirmed. Present any proposed logging/cleanup ownership repair with
failure semantics and ownership safeguards for separate approval.
PR #2 remains Draft. No component replacement, production edit, retry/deletion
policy, licensing review, merge or release is authorized.

## Execution record

Written specification and inline implementation were approved. Tests/plan
ab5c8a2 preceded the helper. Red run36230690946 failed for the intended missing
helper;25existing contracts passed. Run36230875481 at0e3b481 encountered a
fixture-only link error: the synthetic next/server module lacked NextRequest.
That run is incomplete characterization, not evidence of a product defect.
Correction c78952c supplied the missing boundary export without product edits.

Run36230917732 at c78952cef81a53a64498c8d2c7cdef76a3a993a7 passed32/32:
25existing contracts plus6characterization cases and1unknown-mode guard.
Windows/WebKit cohorts were skipped. These were Node VM tests on Ubuntu,
not Windows-native tests. No production files changed.

| Injected scenario | Response/log code | Cleanup attempts | Simulated residuals |
| --- | --- | --- | --- |
| Normal |200/no error|1completed|0|
| Cancellation, successful cleanup |499/voice_cancelled|1completed|0|
| Cancellation, EPERM-like cleanup failure |499/voice_cancelled|1failed|1|
| EPERM-like cleanup failure without cancellation |500/voice_failed|1failed|1|
| Helper fails before creation |503/voice_process_failed|0|0|
| Helper fails after creation |503/voice_process_failed|0|1|

Every case released its actual job timer and admitted a subsequent normal
request, which returned200 without removing any earlier simulated residual.
The paired cancellation scenarios produced the same API response and logged
error code despite different cleanup outcomes. The post-creation helper failure
never reached inference or cleanup. Reported directory ownership is an in-memory
model of the injected boundary, not observation of a Windows filesystem.

The five actual-source SHA256 values in the report are:

| Source | SHA256 |
| --- | --- |
| `app/api/voice/route.ts` |`b251d60b89598ffdeb8483860d079201d4ce1ea38f00d1b5bca2f54e120d0e30`|
| `lib/voice/transcriber.ts` |`d266b350a45977763e9d31d49958902c5625c374c2157c5ee42c5b90e09251de`|
| `lib/voice/windowsNative.ts` |`92a050c9896951058cac363144b97fdbf67805d2be12a7922ba6e800d1a232fe`|
| `lib/voice/jobs.ts` |`9a1c5a843a5eb3766e1dc0bf892454894a9f297bb74adaa2e2fe4b240e4f721f`|
| `lib/voice/audio.ts` |`68099bc7ce53279aa1e2053c7ea877cb12dcb206d9ca1d6b64a85fe977cb204b`|

Artifact `voice-cleanup-faults-36230917732`, ID10901473886,965bytes,
GitHub archive SHA256
`6f5b8f3f71c19aebe35ea71c95af7120310e8b1071c94ad911d7d862f4dcc3e2`,
expires2026-10-10. Small report retained in session files
`voice-cleanup-faults-36230917732/voice-cleanup-faults.json`.
The report contains only source identities, codes, boundary labels and counts;
no request payload, transcript or synthetic private path is included.

## Decision boundary after characterization

These findings justify considering independent sanitized cleanup-failure
logging, because cancellation currently hides that evidence. Preserve HTTP
cancellation semantics unless separately approved; do not expose raw filesystem
messages or paths. Such logging does not itself remove residual directories.

Creation-failure recovery requires a separate ownership design: do not blindly
delete a generated target when CreateDirectory may have failed because an entry
already existed. A native acknowledgement/ownership mechanism or equivalent
safe proof needs analysis before a cleanup change. No helper replacement,
automatic deletion/retry policy or API response change is implemented here.

Neither injected fault is established as the cause of36224052311. The
post-creation failure scenario is a coverage gap, not a supported attribution
of that incident. Further product changes or
native validation require separate approval. PR #2 remains Draft.
