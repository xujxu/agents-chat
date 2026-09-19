# Minimal Native Viewport Reproduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> User approved direct inline implementation, without subagents. The named
> execution skills are unavailable; execute here with remote-only validation.

**Goal:** Produce an authenticated, standalone HTML recorder that isolates
the iPhone native-scale symptom from all chat/framework client behavior.

**Architecture:** A Route Handler renders plain HTML with self-contained
compiled browser functions, without Next client bootstrap. A bounded pure
recorder and exact standalone schema feed a separate upload route sharing
the existing admission and private storage mechanisms.

**Tech Stack:** TypeScript, native DOM/VisualViewport, Next Route Handlers,
Node test runner, Playwright and GitHub Actions.

---

## File Map and Contracts

- `lib/viewportReproduction/schema.ts`: metric/event constants, exact
  `MinimalViewportLog` validator. Log identity is version 1 and experiment
  `native-viewport-minimal`; existing schema 5 remains unchanged.
- `lib/viewportReproduction/recorder.ts`: pure bounded recorder.
- `lib/viewportReproduction/client.ts`: self-contained typed browser
  function; receives the recorder factory explicitly, uses no runtime
  imports or enclosing module state.
- `lib/viewportReproduction/html.ts`: isolated HTML and inline serialization
  of the compiled functions; escaped build revision, fixed typography.
- `app/diagnostics/viewport-minimal/route.ts`: HTML response only.
- `lib/viewportDiagnosticAdmission.ts`: shared upload authorization,
  origin and content-type guards extracted unchanged.
- `lib/viewportDiagnosticStore.ts`: accept a typed union of validated log
  shapes; preserve storage behavior.
- `app/api/diagnostics/viewport/route.ts`: use shared admission.
- `app/api/diagnostics/viewport/minimal/route.ts`: strict minimal validator
  and existing storage/error behavior.
- `tests/minimal-native-viewport.test.mjs`: pure schema, recorder and HTML.
- `tests/minimal-native-viewport.spec.ts`: served isolation, recorder,
  native Chromium observation, upload API/privacy and unchanged history.
- Existing workflow/config: add the Node selector and a separate browser
  stage without removing prior coverage.

Factory contract:

```ts
createMinimalRecorder(seed: Omit<MinimalViewportLog, 'samples' | 'dropped' | 'stopReason'>): {
  record(sample: MinimalViewportSample): void;
  finish(reason: MinimalViewportLog['stopReason']): {
    log: MinimalViewportLog;
    body: string;
  };
}
```

`finish` freezes once. Later record/finish calls cannot alter its body.
Samples use `events` (bounded allowlisted array), `t`, `touches`,
`orientation`, `visibility` and exact `metrics`. Stop reasons are `manual`,
`timeout`, `hidden`, `pagehide`. Preserve initial plus at most 255 later
samples; count removed records and trim to 256 KiB before freezing.

## Task 1: Red Contracts

- [x] Create Node tests importing the missing schema/recorder/template.
  Use finite full-width scale-1 seed measurements. Assert the new identity,
  chronological records, exact shape, version/revision/event/metric limits,
  bounded record retention, byte budget and immutable finish:

```js
const recorder = createMinimalRecorder(seed());
for (let i = 1; i <= 300; i++) recorder.record(sample(i, ['periodic']));
const first = recorder.finish('manual');
assert.equal(first.log.samples.length, 255);
assert.equal(first.log.dropped, 45);
recorder.record(sample(301, ['periodic']));
assert.equal(recorder.finish('timeout').body, first.body);
assert.equal(validateMinimalViewportLog(first.log), true);
```

- [x] Add an authenticated browser route-isolation case before implementation:

```ts
await authenticateViewportDiagnostic(context);
const response = await page.goto('/diagnostics/viewport-minimal');
expect(response?.status()).toBe(200);
await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeVisible();
expect(await page.locator('script[src], link[rel="stylesheet"]').count()).toBe(0);
```

- [x] Add Node and browser selectors to the workflow/mobile project list.
  Commit with `[skip ci]`, push, explicitly dispatch:

```bash
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

- [x] Require actual missing-module failures from Actions before
  implementation. Do not execute these commands locally:
  `node --experimental-strip-types --test tests/minimal-native-viewport.test.mjs`
  and `npx playwright test --config tests/playwright.config.ts
  tests/minimal-native-viewport.spec.ts --workers=1`.

## Task 2: Schema and Bounded Recorder

- [x] Define the exact sample/log types and metric allowlist. Accept
  nullable unavailable readings, finite bounded available metrics, integer
  touches 0..20, monotonic times up to seven days (to represent suspended
  timer delays), explicit orientation and visible/hidden states. Require
  initial time 0 and initial event; later records exclude initial.
- [x] Validate exact version/experiment, parsed browser/OS versions,
  nullable 40-hex revision, nonnegative bounded integer dropped count,
  maximum 256 total samples, known final stop event, and lifecycle reason
  correspondence. Reject arbitrary URLs, keys, values and schema mixing.
- [x] Implement the factory with a cloned seed, FIFO bounded samples,
  explicit drop count and single cached finish result:

```ts
if (finished) return finished;
const log = { ...seed, samples: [...samples], dropped, stopReason: reason };
let body = JSON.stringify(log);
while (new TextEncoder().encode(body).length > 256 * 1024 && log.samples.length > 1) {
  log.samples.shift();
  log.dropped++;
  body = JSON.stringify(log);
}
if (new TextEncoder().encode(body).length > 256 * 1024) {
  throw new Error('Diagnostic log exceeds 256 KiB.');
}
finished = { log, body };
return finished;
```

## Task 3: Passive Browser and HTML

- [x] Implement a self-contained browser function accepting the recorder
  factory. Import only types. Render only after start admission, refusal,
  stop or upload result; no per-sample visible writes.
- [x] Capture raw metrics/reference/font, touch count and lifecycle.
  Require original finite scale/width, no overflow, contacts, hidden state
  or editable focus at Start. Refuse unavailable VisualViewport explicitly.
- [x] Maintain a bounded event Set and one requestAnimationFrame for
  coalesced events. Sample periodically every 200 ms; stop at 30 seconds.
  Flush pending events at Stop, include final raw sample, clear all timers/
  frame callbacks, and freeze. Hidden/pagehide freeze as interruptions.
- [x] Send only the frozen body to `/api/diagnostics/viewport/minimal`.
  Handle HTTP/JSON/network failures explicitly, keep Retry reachable, and
  reject malformed success responses. Start clears only recorder state.
- [x] Render ordinary-flow utilitarian HTML: 16px serif text, high-contrast
  buttons, a 100px reference block and bounded status region. No fonts,
  images, dynamic viewport units or fixed overlays.
- [x] Serialize self-contained compiled functions with explicit arguments:

```ts
const script = `(${minimalViewportClient.toString()})(${createMinimalRecorder.toString()});`;
```

  Escape closing-script sequences. Put only a validated revision in a
  data attribute, never an arbitrary environment value. The compiled
  browser tests must catch bundler-introduced closure dependencies.
- [x] Add GET returning content type `text/html; charset=utf-8` and
  `Cache-Control: no-store`; do not modify root layout or middleware.

## Task 4: Private Upload and Compatibility

- [x] Extract existing token/admin/origin/content-type checks into
  `requireViewportDiagnosticUpload(request): Promise<void>`, preserving
  all statuses/messages. Call it from existing and new upload routes.
- [x] Add `StoredViewportDiagnostic = ViewportDiagnosticLog |
  MinimalViewportLog` to the store's input types; no runtime storage
  changes or casts. Existing callers retain their strict validators.
- [x] Implement new route with admission, bounded read, exact minimal
  validation and store; return 201/no-store only after persistence.
  Reuse `DiagnosticError` responses and standard logger behavior.
- [x] Keep schema-5 acceptance and old-version rejection untouched.

## Task 5: Remote Browser/API Coverage and Review

- [ ] Exercise Start/refusals, active multi-touch departure, shrink/rotate,
  30-second timeout, hidden/pagehide, bounded overflow and frozen retries.
  Inspect record timestamps and final shape, not just displayed status.
- [ ] Observe history methods and meta mutations through test-only
  instrumentation. Require zero app calls and constant history length
  throughout recording/upload; require no DOM changes during active
  periodic/event observation.
- [ ] Run HTTP cases: page login protection, unauthenticated 401, ordinary
  user 403, foreign/missing origin 403, content type 415, byte limit 413,
  invalid/mixed schema 400 and successful private persistence. Existing
  storage tests retain permission/retention/failure coverage.
- [ ] Verify immutable failed-upload retry and explicit malformed/network
  errors. Read saved log via existing helper, which removes its test file.
- [ ] Add Android Chromium CDP case: set actual native scale 2, observe
  recorded scale 2 without recovery, return scale 1, save JSON evidence.
  Explicitly label this transaction coverage, not physical iOS proof.
- [ ] Push implementation with `[skip ci]`, dispatch same workflow, inspect
  exact failures and iterate remotely. Require all three builds/types/jobs
  green and download the final minimal/native artifacts.
- [ ] Update this record with exact revisions, results and limitations;
  stop progress schedule and request separate deployment authorization.

## Plan Self-Review

The tasks cover isolated compiled HTML, raw bounded read-only capture,
native pinch, lifecycle, frozen upload, shared private storage, schema-5
compatibility and remote API/browser validation. The standalone function
serialization is intentional: it avoids framework bootstrapping and
untyped hand-maintained JavaScript, and must work in the served production
artifact. Physical reproduction and production deployment are not inferred
from automation. No ordinary-page behavior is changed.

## Execution Record

- Written specification approved; user authorized planning and direct
  implementation, not deployment.
- Red source `c194f50509dab58f774c5b7447712b2f3a02a2bd`, Actions
  `35448755523`: desktop job `105912141152` failed with
  `ERR_MODULE_NOT_FOUND` for the new schema. Existing 55 Node tests passed.
  Retrieved the completed job log directly while mobile jobs continued.
- First implementation source `fd8528027f4c9ee4a7ad86f6d6b8ed4cb1eca88d`,
  Actions `35448917858`: submitted for remote validation.
- PROD remains `4c40f4d`; no minimal-page deployment or physical
  reproduction result is claimed.
