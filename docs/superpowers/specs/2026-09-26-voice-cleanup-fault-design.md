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
