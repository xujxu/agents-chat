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

- [x] Exercise Start/refusals, active multi-touch departure, shrink/rotate,
  30-second timeout, hidden/pagehide, bounded overflow and frozen retries.
  Inspect record timestamps and final shape, not just displayed status.
- [x] Observe history methods and meta mutations through test-only
  instrumentation. Require zero app calls and constant history length
  throughout recording/upload; require no DOM changes during active
  periodic/event observation.
- [x] Run HTTP cases: page login protection, unauthenticated 401, ordinary
  user 403, foreign/missing origin 403, content type 415, byte limit 413,
  invalid/mixed schema 400 and successful private persistence. Existing
  storage tests retain permission/retention/failure coverage.
- [x] Verify immutable failed-upload retry and explicit malformed/network
  errors. Read saved log via existing helper, which removes its test file.
- [x] Add Android Chromium CDP case: set actual native scale 2, observe
  recorded scale 2 without recovery, return scale 1, save JSON evidence.
  Explicitly label this transaction coverage, not physical iOS proof.
- [x] Push implementation with `[skip ci]`, dispatch same workflow, inspect
  exact failures and iterate remotely. Require all three builds/types/jobs
  green and download the final minimal/native artifacts.
- [x] Update this record with exact revisions, results and limitations;
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
  Both mobile jobs subsequently failed the missing route assertion with
  HTTP 404 instead of 200; no unrelated failing stage was reported.
- First implementation source `fd8528027f4c9ee4a7ad86f6d6b8ed4cb1eca88d`,
  Actions `35448917858`: all three jobs passed.
- Final source `42111b3371894332e1bf0096c14ab37959857c74`, Actions
  [35449463953](https://github.com/xujxu/agents-chat/actions/runs/35449463953):
  all three builds, type checks and jobs passed. This final revision adds
  explicit served build-revision and post-upload history/meta assertions;
  runtime implementation is unchanged from the first green candidate.

| Coverage | Desktop Chromium | Android Chromium | iPhone WebKit |
| --- | ---: | ---: | ---: |
| Node policy/schema/storage | 60 | not scheduled | not scheduled |
| Typography behavior | 8 | 7 | 7 |
| Emitted typography policy | 1 | 1 | 1 |
| Existing diagnostic API/browser | 18 | 18 | 17 |
| Reactive recovery | 7 | 8 | 7 |
| Preventive transactions | 9 | 10 | 9 |
| Minimal recorder/API/browser | 10 | 10 | 9 |
| Existing desktop/mobile regressions | 17 | 31 | 31 |

- Total: 296 passing executions and 14 deliberate project-specific skips.
  All execution was remote; no local installs, builds, type checks or
  tests occurred.
- Compiled-page coverage confirms the self-contained function serialization
  executes without missing closure dependencies, loads no framework
  bundles/styles, keeps visible DOM unchanged during recording, and does
  not write history or modify viewport metadata through upload.
- Downloaded exact final Android artifact ID `10585797798`. Its
  `native-minimal-viewport.json` identifies client `42111b3`, experiment
  `native-viewport-minimal` and server build `yL3bdMywuIiB9jEMZHo8P`.
  Initial native scale 1 has widths 412/412; native scale 2 samples have
  widths 206/412; after the test explicitly returns scale to 1, final
  widths are 412/412. Reference width stays 100 and computed font size
  stays 16. Ten total samples, zero drops; no recovery was attempted.
  Contacts were synthetic and scale changes used Chromium CDP. This is
  recorder evidence, not a physical iOS rotation result.
- Desktop deployment artifact:
  `typography-42111b3371894332e1bf0096c14ab37959857c74-desktop-chromium`,
  ID `10586024166`. iPhone artifact ID `10586657646`.
- Self-review retained separate minimal/schema-5 identities, unchanged
  upload admission behavior, bounded event/timer capture, explicit refusal/
  interruption/error states, and identical frozen bodies on retry. No
  history operation, CSS compensation or scale normalization is present
  in the minimal runtime. Existing build tracing warnings point to
  `next.config.ts` / `app/api/markdown/route.ts`; they are outside this change.
- Progress schedule 11 stopped at the deployment gate.
- At the validation handoff PROD remained `4c40f4d`; no physical
  reproduction result was claimed. Authorized deployment followed below.

## Authorized Production Deployment

- User approved deployment to existing PROD for physical validation.
  Deployed the exact `42111b3371894332e1bf0096c14ab37959857c74` desktop
  artifact ID `10586024166` from Actions `35449463953`.
- Build ID: `U29bqrydoMMrN4CyDCSIG`. Service active/running, observed
  PID `52092`. Only `.next` changed; host dependencies and environment
  remained intact. Previous `4c40f4d` build and consistent SQLite backup
  API snapshots are retained under
  `.data/deployments/viewport-minimal-42111b3/`.
- Deployment integrity checks confirmed artifact identity, compiled
  minimal HTML/revision and both new route manifests, production-origin
  metadata, unchanged ordinary viewport policy, exact local/public CSS
  and public client revision, both typography policies, login gates on
  all four history/minimal diagnostic routes, upload 401 on both endpoints
  and database readability. No local builds or tests were performed.
- Progress schedule 12 stopped after deployment. First physical entry:
  `https://agent.xujx.us.kg/diagnostics/viewport-minimal`.
- Use a fresh Chrome tab, move to landscape at 1x without a preliminary
  pinch, press Start recording, pinch larger/back to original and release,
  return to portrait, wait three seconds, then Stop recording and Upload
  diagnostic log. Recording automatically freezes after 30 seconds.
- This page neither prevents nor corrects zoom. Await the first isolated
  Chrome result before requesting Safari or another experiment.
  Ordinary chat has no new scaling behavior.

## First Isolated Chrome Physical Result

- Upload `a3991247-7ac6-4e8b-b681-f9b5ed4894f8`, received
  `2026-09-19T15:04:53.155Z`: minimal schema 1, experiment
  `native-viewport-minimal`, exact client `42111b3` and deployed server
  build `U29bqrydoMMrN4CyDCSIG`. Chrome 153.0.8010.24 / iOS 18.7.8.
- The recording contains the initial measurement plus 170 samples,
  zero dropped samples, visible lifecycle throughout, and manual Stop
  at 23.156 s. No timeout or hidden-page interruption occurred.
- Initial landscape geometry is scale 1 and visual/document widths
  832/832. Two contacts are recorded from 5.941 s; scale departs from 1
  and reaches reported values above 2 during the pinch.
- Both contacts release by 8.841 s. The elastic visual-width overshoot
  resolves at 8.994 s to scale 1 and 832/832. Repeated periodic readings
  retain that healthy, contact-free baseline through 13.604 s, before
  the orientation transition. This is not a rotation while intentionally
  left at non-unit zoom.
- The transition includes intermediate inconsistent readings at 13.814 s
  and 13.901 s. From 13.935 s through manual Stop at 23.156 s, recorded
  portrait scale is 2.338709592819214 and visual/document widths are
  183/428. These readings are consistent with actual native enlargement:
  183 multiplied by the reported scale is approximately 428.
  Unlike the earlier 2.018817/428-by-428 state, this is not solely a
  scale/full-width contradiction.
- All recorded computed font sizes remain 16px and reference-block
  bounding dimensions remain 100 by 24 CSS pixels. No further multi-touch
  occurs after the original release; a later single-contact Stop tap
  does not explain the earlier rotation-triggered enlargement.
- Conclusion: a standalone instrumented HTML page without React, chat
  layout/runtime, global CSS or history recovery reproduces unintended
  native zoom after the affected pinch-return/rotation sequence. Those
  chat-specific mechanisms are not necessary to trigger this symptom.
  The scale magnitude and geometry differ from the previous portrait
  contradiction; do not claim this proves an identical internal defect,
  the exact browser/engine component responsible, or a working repair.
- Next approved comparison: use the same minimal page on the same iPhone
  in Safari, starting in landscape at 1x, then record one identical
  pinch-return/release/portrait sequence and upload. Do not modify or
  redeploy the page between the paired browser observations.

## Paired Safari Physical Result and Scope Completion

- Upload `fb55f875-02a2-483d-bd32-5ed199342a64`, received
  `2026-09-19T15:07:19.450Z`, identifies the same minimal schema,
  experiment, client `42111b3` and server build `U29bqrydoMMrN4CyDCSIG`.
  The parsed Safari version is 18.7.5 and its user-agent OS field is 18.7.
  Chrome reported OS 18.7.8; these parsed strings do not independently
  establish a different installed OS or device. The requested comparison
  was Safari on the same iPhone.
- Initial plus 149 samples, zero drops, visible throughout, manual Stop
  at 20.162 s. Landscape starts at scale 1 and widths 832/832.
  Multi-touch departs from original scale, with reported scale above 3.
- All contacts release by 6.988 s; elastic overshoot resolves at 7.156 s.
  Scale 1 and 832/832 persist through the pre-transition observations,
  including the orientation event at 12.627 s.
- The first portrait geometry at 12.681 s is scale 1 and 428/428.
  Every retained portrait sample through Stop at 20.162 s remains at
  those values, a 7.481-second observation span. No post-rotation
  enlargement or contradictory portrait scale was captured.
- Computed font size stays 16px and reference geometry stays 100 by 24
  CSS pixels throughout. No recovery mechanism ran in either browser.
  The larger Safari pinch amplitude does not make the gestures identical;
  both recordings nevertheless establish released original-scale geometry
  well before rotation.

| Isolated physical trial | Released landscape baseline | Settled portrait observations |
| --- | --- | --- |
| Chrome `a3991247` | 1, 832/832 | 2.3387096, 183/428; retained until Stop |
| Safari `fb55f875` | 1, 832/832 | 1, 428/428; retained until Stop |

- The approved minimal-reproduction scope is complete: unintended native
  enlargement is reproducible without chat/React/history recovery in the
  affected Chrome environment, while this paired Safari trial did not
  reproduce it. Sampling does not exclude uncaptured transient frames,
  and one paired trial does not establish behavior across all versions.
- This directs further investigation toward browser-specific native zoom
  behavior and its interaction with the engine. It does not identify the
  responsible native function or prove the earlier full-width/2.018817
  contradiction shares the exact internal cause.
- Do not request repeated copies of these trials or add another app-side
  reset without a new evidence-based hypothesis. No webpage-level repair
  meeting the no-reload/no-compensation/native-pinch constraints has yet
  been demonstrated for the full Chrome issue.
- Any new recovery experiment, app integration or upstream publication
  remains separately scoped. No further code changes, deployment or
  external submission followed from this paired result.
