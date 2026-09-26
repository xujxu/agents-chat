# WebKit Controller Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. This subskill is unavailable here; the user explicitly chose inline execution, so execute the following checkpoints directly without subagents.

**Goal:** Distinguish loss of following from missed layout correction using one approved, bounded WebKit comparison.

**Architecture:** A test-owned exact-source transformer instruments disposable Actions product copies only. A browser init recorder captures typed state and selected branches; the existing orientation test attaches its report without changing actions or assertions. Independent workflow gates leave Windows disabled.

**Tech Stack:** Node24.20.0 standard library, TypeScript, existing Playwright/WebKit, GitHub Actions.

---

Specification: `docs/superpowers/specs/2026-09-26-voice-pr-intermittent-diagnostics-design.md`,
section `Approved WebKit controller-state diagnosis`, committed `fc99779`.
Written specification and inline implementation approved. No local validation.

## File responsibilities

- Create `tests/helpers/controllerStateRecorder.ts`: standalone serializable
  browser initializer, typed report, explicit report validation.
- Create `tests/helpers/instrumentScrollController.mjs`: exact-source patching,
  reversible patch contract and CLI writing hashes into existing provenance.
- Create `tests/helpers/readingControllerDiagnostics.ts`: opt-in Playwright
  initialization and attachment, then validation.
- Create `tests/reading-controller-diagnostics.test.mjs`: Node contracts.
- Modify `tests/helpers/readingGeometryDiagnostics.ts`: register optional state
  capture beside geometry without changing the orientation test.
- Modify `.github/workflows/voice-pr-diagnostics.yml`: contract selectors,
  independent WebKit gate, test-file overlays, injection and3repeat limit.
- Update spec and this plan with run IDs and evidence after execution.
- Do not edit tracked `app/` files or add dependencies.

## Task 1: Red contracts

- [ ] Add Node contracts before implementation. Import
  `instrumentController`, `restoreController`, `controllerSha` from the
  instrumenter, and `initializeControllerDiagnostics`, `requireCompleteReport`
  from the recorder. Read the tracked controller with `readFile`.
  The core source-identity assertions are:

```js
const source = await readFile('app/features/chat/runtime/chatScrollController.ts', 'utf8');
const output = instrumentController(source);
assert.notEqual(output, source);
assert.equal(restoreController(output), source);
assert.equal(createHash('sha256').update(source).digest('hex'), controllerSha);
assert.throws(() => instrumentController(source + '\n'), /revision/);
assert.throws(() => instrumentController(source.replace('function onScroll()', 'function other()')), /revision/);
assert.throws(() => instrumentController(source + source), /revision/);
```

- [ ] Exercise the initializer against a synthetic `window` in Node, restoring
  the original descriptor in `finally`. Use the following complete state shape:

```js
const state = {
  following: true, userIntent: false, jumping: false, suspended: false,
  disposed: false, multiTouch: false, scrollbarDrag: false,
  correctionPending: false, anchorPresent: false, expectedTop: null, lastTop: 100,
  cached: { width: 844, height: 184, contentHeight: 284 },
  current: { width: 844, height: 179, contentHeight: 284 }, scrollTop: 100,
};
initializeControllerDiagnostics();
const recorder = window.__chatScrollDiagnostic;
recorder.record(1, 'correct:enter', () => state);
state.following = false;
recorder.record(1, 'capture:complete', () => state);
assert.equal(recorder.report.events[0].state.following, true);
assert.equal(recorder.report.events[1].state.following, false);
assert.equal(recorder.report.events[0].sequence, 0);
assert.ok(Number.isFinite(recorder.report.events[0].at));
requireCompleteReport(recorder.report);
```

- [ ] Add exact2048event and16error limit contracts, ordering, lazy reads after
  saturation, missing/zero/malformed reports, and error rejection. Failed state
  reads must increment bounded errors, not produce success-shaped events.
- [ ] Add the new test selector to contracts. Commit/push and dispatch contracts
  only; expect missing-module failure with both cohorts skipped.

```bash
gh workflow run voice-pr-diagnostics.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

## Task 2: Implement isolated capture

- [ ] Recorder initialization defines `window.__chatScrollDiagnostic` with
  `nextId:1`, `report:{events:[],dropped:0,errors:[],errorsDropped:0}` and
  `record(controller,kind,read)`; its body is self-contained for addInitScript.
  Core bounded recording logic:

```ts
if (report.events.length >= 2048) { report.dropped++; return; }
try {
  const state = read();
  report.events.push({
    sequence: report.events.length, at: performance.now(), controller, kind,
    state: { ...state, cached: { ...state.cached }, current: { ...state.current } },
  });
} catch (error) {
  if (report.errors.length < 16) report.errors.push(error instanceof Error ? error.name : 'unknown');
  else report.errorsDropped++;
}
```

- [ ] Define explicit state/event/report/channel types and global Window typing.
  Validate every report field, boolean state, finite numeric geometry, nullable
  expectedTop, event sequence, controller ID, kind and timestamp. Require at
  least1event; reject capture errors, dropped events and over-bound arrays.
- [ ] Transform only the exact controller SHA256
  `3ebb63ffe07e976b9f0c3154206418a5691dd3c3a5f96f69d3af1d63eb69f94e`.
  Use a named list of `{before,after}` exact replacements. Every `before`
  must occur once in the original and current intermediate source. Pure
  `instrumentController(source)` returns the complete result before CLI writes.
  Reverse replacements in reverse order for `restoreController`.

```js
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Non-unique diagnostic insertion');
  return source.replace(before, () => after);
}
export function instrumentController(source) {
  if (createHash('sha256').update(source).digest('hex') !== controllerSha) {
    throw new Error('Unexpected controller revision');
  }
  for (const { before } of patches) replaceOnce(source, before, before);
  return patches.reduce((text, { before, after }) => replaceOnce(text, before, after), source);
}
export function restoreController(source) {
  return [...patches].reverse().reduce((text, { before, after }) => replaceOnce(text, after, before), source);
}
```

- [ ] Inject a type-only recorder import and this observer after `notify`, before
  the first `correctLayout()` call:

```ts
const diagnostic: ControllerDiagnosticChannel | undefined = window.__chatScrollDiagnostic;
if (!diagnostic) throw new Error('Missing controller diagnostic initialization');
const controllerId = diagnostic.nextId++;
function observe(kind: string, requestedTop?: number) {
  diagnostic!.record(controllerId, kind, () => ({
    following, userIntent, jumping, suspended, disposed, multiTouch, scrollbarDrag,
    correctionPending: correctionFrame !== 0, anchorPresent: anchor !== null,
    expectedTop, lastTop, cached: { ...geometry }, current: measure(),
    scrollTop: container.scrollTop, ...(requestedTop === undefined ? {} : { requestedTop }),
  }));
}
```

- [ ] Add entry/complete observations to writes and capture; observe actual taken
  blocked/independent/following/anchor branches in correction, and actual taken
  user-intent/geometry-independent/geometry-layout/jumping/expected/unchanged/
  capture branches in scroll. Add scheduling entry/completion, intent entry/
  completion, touch entry, jump/suspend/dispose boundaries. Wrap ResizeObserver
  and MutationObserver callbacks only to record then call the unchanged
  `scheduleCorrection`; do not add observers or reevaluate predicates.
- [ ] CLI accepts only product root and requires `GITHUB_ACTIONS=true`. It reads
  the entire source, transforms before writing, verifies reverse identity, then
  writes controller and merges original/instrumented hashes into provenance.
  Keep injected type import resolving to the overlaid test recorder.
- [ ] In the new Playwright helper, register hooks only when
  `READING_CONTROLLER_DIAGNOSTICS=1`. Before each case use
  `page.addInitScript(initializeControllerDiagnostics)`. After each case obtain
  channel.report via page.evaluate, attach JSON including status/repeat/product/
  harness, then call `requireCompleteReport`. Attach missing/partial reports
  before throwing. Do not suppress original failures.
- [ ] Register the new helper from the existing geometry helper. Overlay both
  new TypeScript helpers in the pinned product before build/typecheck.

## Task 3: Workflow and green contracts

- [ ] WebKit gate becomes
  `github.event_name == 'workflow_dispatch' && inputs.run_webkit`,
  depending only on contracts. Windows remains gated by `run_cohorts`.
  Both inputs default false.
- [ ] Enable `READING_CONTROLLER_DIAGNOSTICS=1` only in the WebKit job. Retain
  fixed products/tool versions. Set provenance requestedRepetitions3 and list
  all overlaid helpers plus instrumented controller. After overlays:

```bash
node ../harness/tests/helpers/instrumentScrollController.mjs .
git diff -- app/features/chat/runtime/chatScrollController.ts > artifacts/controller-instrumentation.diff
```

- [ ] Replace5repeats with3, preserve all other original actions/assertions and
  first-failure stop. Keep existing artifact upload-on-failure and timeout.
- [ ] Commit/push implementation and run contracts only. Read exact green result
  before any cohort. Repair contract/instrumentation failures without starting
  browser cases; no local execution.

## Task 4: One approved batch, evidence and stop

- [ ] Dispatch once:

```bash
gh workflow run voice-pr-diagnostics.yml -R xujxu/agents-chat \
  --ref experiment/voice-natural-long -f run_cohorts=false -f run_webkit=true
```

- [ ] Inspect actual repetition counts, errors/drops, pinned source identities,
  branch-state chronology and final geometry. A build or capture failure is a
  collection blocker, not a product reproduction.
- [ ] Retain run/artifact IDs/hashes and a bounded state sequence in the spec;
  update Draft PR #2. Do not merge, modify product behavior, restart licensing
  or automatically rerun. Stop reminder and mark collection complete even if
  the causal question remains unresolved.

## Self-review and handoff

Scope is one diagnostic subsystem; Windows budget is not reopened. All execution
uses Actions. Pure transformation and lazy bounded capture precede the only
browser batch. Source identity and typecheck guard against applying stale
instrumentation. Original behavior is preserved, but timing interference
remains explicitly possible. The user has already selected inline execution;
no additional execution-choice prompt is needed.
