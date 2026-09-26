# Voice Cleanup Fault Characterization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. It is unavailable here; the user approved direct inline checkpoint execution.

**Goal:** Characterize cancellation/cleanup-error precedence and directory ownership after helper failure, without product edits.

**Architecture:** A voice-local VM fixture loads the actual five production modules and mocks only external boundaries. Six fixed scenarios assert status, code, log, cleanup ordering and simulated ownership, then check admission recovery. A small Actions artifact explicitly labels these as injected, not native, results.

**Tech Stack:** Node24 standard-library VM/test/crypto, existing Actions contracts workflow.

---

Approved specification77e91c7:
`docs/superpowers/specs/2026-09-26-voice-cleanup-fault-design.md`.
User approved written spec and inline implementation. No local validation.

## Task 1: Characterization tests before helper

Files:
- Create `tests/voice-cleanup-faults.test.mjs`.
- Modify `.github/workflows/voice-pr-diagnostics.yml`.

- [ ] Import `createVoiceFaultFixture` and `faultModes` from
  `tests/helpers/voiceFaultFixture.mjs`. Define the exact scenario oracle:

```js
const cases = [
  ['normal', 200, null, 1, 0],
  ['cancel', 499, 'voice_cancelled', 1, 0],
  ['cancel-cleanup-failure', 499, 'voice_cancelled', 1, 1],
  ['cleanup-failure', 500, 'voice_failed', 1, 1],
  ['create-before-failure', 503, 'voice_process_failed', 0, 0],
  ['create-after-failure', 503, 'voice_process_failed', 0, 1],
];
```

- [ ] Each case creates a fresh fixture, calls `request(mode)`, checks exact
  status/error code and number/order of create/infer/remove events, logged codes,
  outstanding directories and released timer/job. Then call `request('normal')`
  and assert200, no busy response, and unchanged prior residual count.
  Assert source hashes cover actual route/transcriber/windowsNative/jobs/audio.
- [ ] Guard unknown mode and mocked boundary violations; verify byte content,
  transcript, UUID/path and raw failure messages are absent from the report.
- [ ] In an `after` hook write the bounded report only if
  `VOICE_FAULT_REPORT` is supplied. Each case starts `incomplete`, becomes
  `passed` only after all assertions, and on failure retains a sanitized error
  name and rethrows. Include run/harness identity and source SHA256.
- [ ] Add the test selector to the existing contracts command and set
  `VOICE_FAULT_REPORT: voice-cleanup-faults.json`. Add always-upload for that
  file,14day retention, missing-file warning (the intended red has no helper).
- [ ] Commit/push and dispatch existing workflow with both default-false gates.
  Expect missing-helper red, not product or native failure:

```bash
gh workflow run voice-pr-diagnostics.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

## Task 2: Actual-module VM fixture

File: Create `tests/helpers/voiceFaultFixture.mjs`.

- [ ] Import standard-library readFile, SHA256, path.win32, promisify and VM.
  Maintain a per-fixture VM context, module cache, source hashes, in-memory
  directory set, event list, log-code list, violation list and fake timer map.
  Only five source IDs are eligible for actual-file reads; aliases resolve
  explicitly. Unknown imports throw. Core source loading:

```js
const source = await readFile(new URL(`../../${id}`, import.meta.url), 'utf8');
sourceHashes[id] = createHash('sha256').update(source).digest('hex');
const module = new SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), { context, identifier: id });
modules.set(id, module);
return module;
```

  Use transform mode because VoiceError has parameter properties. VM shares
  host Error/Buffer/AbortController/text encoders and web request primitives,
  but receives only synthetic process.env/platform and fake timers.
- [ ] Actual linker resolves route aliases and relative imports to the same
  cached audio/jobs/transcriber/windowsNative modules, preserving VoiceError
  identity. Configuration, providers, process, memory, auth, logger and Next
  receive explicit SyntheticModules, not copied product flow.
- [ ] Inject callback-style execFile with a validated absolute synthetic path,
  sole supported command `--create-directory`, and event order:

```js
events.push('create:start');
if (mode === 'create-before-failure') return callback(new Error('injected helper failure'));
directories.add(directory);
events.push('create:owned');
if (mode === 'create-after-failure') return callback(new Error('injected helper failure'));
callback(null, Buffer.alloc(0), Buffer.alloc(0));
```

  Pass real promisify to the real windowsNative implementation. Creation is the
  only execute call expected for the chosen SenseVoice configuration; all
  others record a fixture violation and fail.
- [ ] Simulated writeFile verifies its parent belongs to the set and signal
  is not aborted; never writes real files. rm records attempt, throws injected
  EPERM-like error in either cleanup-failure mode, otherwise removes only the
  exact owned directory and records completion. No cleanup retries.
- [ ] Mock inference validates input/output ownership and actual AbortSignal,
  records entry, and for cancellation cases invokes actual cancelVoiceJob with
  the active synthetic user/request ID then throws signal.reason. Other cases
  return a fixed synthetic Buffer. Decoder returns synthetic text only to the
  in-memory response; reports contain no text.
- [ ] `request(mode)` rejects unknown modes, assigns a unique valid synthetic
  request UUID, constructs a valid non-silent WAV using actual encodeVoiceWav,
  makes a Request with matching ownership/content type and sets nextUrl.
  Call actual POST. Return status/code, sanitized events/log codes, remove count,
  directory count and timer count. Boundary errors are surfaced from the
  violation list after POST even if production catches them.
- [ ] `dispose()` clears only in-memory state/timers. No cleanup of real
  directories and no child processes. Expose source hashes and supported modes
  for contracts, not internal production control-flow copies.

## Task 3: Green characterization and evidence

- [ ] Commit/push helper and dispatch contracts only. Expect25existing contracts
  plus all new cases/fixture guards to pass, with native/browser cohorts skipped.
  A green characterization documents current faults; it is not a product fix.
- [ ] Inspect the small artifact and exact source hashes, compare each injected
  case to its positive control, and confirm the report contains no private
  content. Unexpected outcomes require fixture/source investigation, not
  weakening assertions or editing product logic.
- [ ] Record run/artifact identity and limits in the spec and PR #2.
  Keep old Windows incident cause unconfirmed; propose logging and ownership
  changes for separate approval only. Stop reminder. No release or merge.

## Self-review and handoff

The two questions share one request lifecycle, so use one bounded fixture rather
than native/browser fan-out. Fixed scenario count and isolated state avoid
timing assumptions. Production sources are unchanged; typed errors come from
the same actual module graph. Filesystem and process semantics remain mocked.
Inline execution was already selected; executing-plans is unavailable.
