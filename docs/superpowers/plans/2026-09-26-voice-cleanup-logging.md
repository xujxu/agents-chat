# Voice Cleanup Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution. That skill is unavailable in this environment; use explicit task checkpoints with user approval instead.

**Goal:** Make deletion failures independently visible without changing cancellation, error identity or cleanup policy.

**Architecture:** Add one narrow catch/log/rethrow at the existing transcriber deletion boundary. Extend the existing actual-module VM fixture to validate complete logger arguments and direct rejection identity. Preserve the historical characterization evidence.

**Tech Stack:** TypeScript, existing Pino logger, Node VM/test modules, GitHub Actions.

---

Approved spec:
`docs/superpowers/specs/2026-09-26-voice-cleanup-logging-design.md`,
commit9df15da. Written-spec approval was received before the interrupted session.
No local validation or dependency installation.

## File responsibilities

- `lib/voice/transcriber.ts`: the only production change; cleanup warning.
- `tests/helpers/voiceFaultFixture.mjs`: mocked warning boundary, direct actual
  transcriber entry point and injected error identity.
- `tests/voice-cleanup-faults.test.mjs`: API warning expectations, direct rejection
  assertions, bounded report.
- This plan and the approved specification: execution/evidence ledger.
- Existing `voice-pr-diagnostics.yml`: unchanged contracts selector.
- Existing `voice-input.yml`: build, typecheck, Linux native/API/browser regression.

## Task 1: Regression expectations before product implementation

- [ ] Extend the fixture state with `warnings = []` and a stable per-fixture
  cleanup error; replace only the existing cleanup throw with that object:

```js
const cleanupError = Object.assign(
  new Error('fixture-private cleanup failure'), { code: 'EPERM' },
);
// Existing injected failure branch:
throw cleanupError;
```

- [ ] Replace the logger mock with strict argument checks. Use the existing
  `guard` to retain violations even if product code catches a mock exception:

```js
createLogger: name => ({
  warn(...args) {
    guard(args.length === 2, 'unexpected-warning-arguments');
    const [fields, message] = args;
    guard(fields !== null && typeof fields === 'object', 'invalid-warning-fields');
    const cleanup = name === 'voice.transcriber';
    guard(cleanup || name === 'api.voice', 'unexpected-warning-logger');
    const keys = cleanup ? ['aborted', 'code'] : ['code'];
    guard(Reflect.ownKeys(fields).length === keys.length
      && keys.every(key => Object.hasOwn(fields, key)), 'unexpected-warning-fields');
    if (cleanup) {
      guard(fields.code === 'voice_cleanup_failed'
        && typeof fields.aborted === 'boolean'
        && message === 'Voice temporary directory cleanup failed',
      'invalid-cleanup-warning');
    } else {
      guard(['voice_cancelled', 'voice_failed', 'voice_process_failed'].includes(fields.code)
        && message === 'Voice request failed', 'invalid-route-warning');
    }
    warnings.push({ name, fields: { ...fields }, message });
    logCodes.push(fields.code);
  },
  info: () => {},
}),
```

  Capture only checked warning fields, never raw exception/request values.
  Reset `warnings` beside existing per-request event/code/violation resets.
  Include cloned `warnings` in each request result.

- [ ] Extract the existing request preparation (mode validation, state reset,
  UUID assignment and WAV generation) into `prepare(nextMode)`; the existing
  `request` calls it without changing headers, Request or POST handling:

```js
function prepare(nextMode) {
  if (!faultModes.includes(nextMode)) throw new Error('Unknown fault mode');
  mode = nextMode;
  events = []; logCodes = []; warnings = []; violations = [];
  requestId = uuid();
  return modules.get('lib/voice/audio.ts').namespace.encodeVoiceWav(
    new Float32Array(16000).fill(0.2),
  );
}
```

  Add these properties to the returned fixture, using the actual job and
  transcriber modules. Keep directory cleanup exclusively in actual code:

```js
cleanupError,
async transcribe(nextMode) {
  const audio = prepare(nextMode);
  const job = modules.get('lib/voice/jobs.ts').namespace.reserveVoiceJob(
    'fixture-user', requestId, new AbortController().signal,
  );
  try {
    return await modules.get('lib/voice/transcriber.ts').namespace
      .transcribeVoice(audio, config, job.signal);
  } finally {
    job.release();
    guard(violations.length === 0, 'caught-boundary-violation');
  }
},
```

- [ ] In the six API scenarios replace the existing log-code equality with
  exact expected records (host-created records avoid VM prototype comparisons):

```js
const expectedWarnings = [];
if (mode.includes('cleanup-failure')) {
  expectedWarnings.push({
    name: 'voice.transcriber',
    fields: { code: 'voice_cleanup_failed', aborted: mode.startsWith('cancel') },
    message: 'Voice temporary directory cleanup failed',
  });
}
if (code) {
  expectedWarnings.push({
    name: 'api.voice', fields: { code }, message: 'Voice request failed',
  });
}
assert.deepEqual(result.warnings, expectedWarnings);
assert.deepEqual(result.logCodes, expectedWarnings.map(item => item.fields.code));
```

  Keep all existing status, event, residual, timer, recovery and redaction
  assertions. Add exact empty warning/code assertions for recovery requests.
  Label the report additionally with
  `purpose: 'cleanup-warning-regression-not-native-leak-repair'`.

- [ ] Add two direct rejection regressions, recording only sanitized result
  labels in a `directRejections` report array:

```js
for (const mode of ['cleanup-failure', 'cancel-cleanup-failure']) {
  test(`direct transcriber preserves cleanup rejection: ${mode}`, async () => {
    const record = { mode, status: 'incomplete' };
    report.directRejections.push(record);
    let fixture;
    try {
      fixture = await createVoiceFaultFixture();
      await assert.rejects(fixture.transcribe(mode), error => error === fixture.cleanupError);
      const recovered = await fixture.request('normal');
      assert.equal(recovered.status, 200);
      assert.equal(recovered.pendingTimers, 0);
      assert.equal(recovered.remainingDirectories, 1);
      assert.deepEqual(recovered.warnings, []);
      record.status = 'passed';
    } catch (error) {
      record.failure = error instanceof Error ? error.name : 'unknown';
      throw error;
    } finally { fixture?.dispose(); }
  });
}
```

- [ ] Commit/push tests and dispatch contracts with both cohort gates false:

```bash
git add tests/helpers/voiceFaultFixture.mjs tests/voice-cleanup-faults.test.mjs
git commit -m "test: require independent sanitized cleanup warnings" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin HEAD
gh workflow run voice-pr-diagnostics.yml -R xujxu/agents-chat --ref experiment/voice-natural-long -f run_cohorts=false -f run_webkit=false
```

  Inspect the returned run ID, do not dispatch again after interruption.
  Expect34tests: two API cleanup-warning cases fail because no independent
  warning exists;32others pass, including direct rejection identity.
  A fixture/linking error is not the intended red; fix the fixture first.

## Task 2: Narrow product change and green contracts

- [ ] Add the existing logger import and module-level logger to transcriber:

```ts
import { createLogger } from '../logger';
const logger = createLogger('voice.transcriber');
```

  Replace only the deletion statement in the existing finally:

```ts
try {
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  logger.warn(
    { code: 'voice_cleanup_failed', aborted: signal.aborted },
    'Voice temporary directory cleanup failed',
  );
  throw error;
}
```

- [ ] Commit/push, dispatch the same contracts-only command and inspect results:

```bash
git add lib/voice/transcriber.ts
git commit -m "fix: log voice cleanup failures independently of cancellation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin HEAD
gh workflow run voice-pr-diagnostics.yml -R xujxu/agents-chat --ref experiment/voice-natural-long -f run_cohorts=false -f run_webkit=false
```

  Expect34/34passed, both cohorts skipped. Inspect the small
  `voice-cleanup-faults-<run ID>` artifact: six API cases, two direct checks,
  fixed warnings and actual source hashes. Preserve old red and characterization
  evidence; do not edit the historical report to match new behavior.

## Task 3: Integration and persistent evidence

- [ ] Inspect PR-triggered workflows for the implementation revision:

```bash
gh run list -R xujxu/agents-chat --branch experiment/voice-natural-long --limit 15 --json databaseId,headSha,status,conclusion,workflowName
```

  Use existing Voice input PoC run when present rather than duplicate it.
  If absent, dispatch exactly:

```bash
gh workflow run voice-input.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

  This workflow includes build/typecheck, voice logic tests, API/browser
  cancellation regression, Linux temporary cleanup and native smoke. It is
  ordinary integration, not a new Windows/WebKit diagnostic cohort. Inspect
  any other automatically triggered required checks; do not broadly redispatch.

- [ ] Inspect logs/artifacts for failures; repair only directly related
  regressions and repeat affected Actions checks. No local tests or servers.
  Report progress at least every15minutes, including while awaiting Actions.
- [ ] Record exact red/green and integration revision/run IDs, artifact
  metadata, source hashes and the logging-only limitation in the specification.
  Refresh PR #2 body before adding evidence; keep it Draft.
- [ ] Commit/push evidence with the required coauthor trailer. Verify clean
  pushed state, close task records, stop the reminder. Original Windows cause
  and creation-ownership work remain unconfirmed/deferred respectively.

## Plan self-review

The warning schema is explicit and checked before report capture. Existing
response/deletion semantics and original rejection identity have independent
assertions. No new production helper, route change, retry or native cohort is
needed. Existing fixture context already links the five required actual modules.
Only the transcriber production hash is expected to change.
