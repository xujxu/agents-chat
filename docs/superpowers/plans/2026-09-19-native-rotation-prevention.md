# Native Rotation Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> User chose direct inline implementation. The named execution skills are
> not installed; execute in this session without subagents or local tests.

**Goal:** Test whether a healthy post-pinch history restoration prevents the
next native rotation anomaly, without reactive fallback.

**Architecture:** A focused gesture-driven controller reuses the existing
browser history adapter and original-scale policy. A separately gated route
and schema-5 evidence distinguish preparations from actual prevention.

**Tech Stack:** TypeScript/React/Next.js, History/VisualViewport, existing
Node tests, Playwright and GitHub Actions.

---

## Task 1: Red controller and route contracts

**Create:** `tests/preventive-native-recovery.test.mjs`.
**Modify:** `tests/viewport-diagnostics.spec.ts`,
`.github/workflows/markdown-typography.yml`.

- [ ] Use the existing automatic port observation shape. The new controller
  contract is `createPreventiveNativeRecovery(ports)` returning `arm`,
  `observe`, `stop`, `evidence`; `ports` has `read`, `checkpoint`, `back`,
  `rearm`, `publish`. Define a local deterministic fixture in the new test:

```js
const observation = {
  now: 0, scale: 1, width: 428, clientWidth: 428, scrollWidth: 428,
  orientation: 'portrait', touches: 0, editable: false, overlay: false,
  historyLength: 1, entry: null, entryCycle: null, sameUrl: true,
  documentContinuous: true, shellContinuous: true, composerContinuous: true,
};
// checkpoint mutates entry to working/cycle0/length2;
// back records one request, without synthesizing acknowledgment;
// rearm mutates checkpoint to working and increments entryCycle.
```

The fixture advances `now` for observations, explicitly acknowledges by
setting `entry='checkpoint'` and delivering `popstate`, and keeps only the
latest published evidence. This supports exact counter-bound checks without
retaining a million evidence objects.

- [ ] Write cases for 20 repeated preparations, no enable/rotation/resize/
  focus-only action, no departure/no preparation, non-unit intent, partial
  release, fresh near-original stability, fixed gesture deadlines, new
  contact/focus/orientation cancellation, ownership/overlay/DOM changes,
  Stop with late acknowledgment, API exceptions, missing acknowledgment,
  missing settled original scale, and bounded counters.
- [ ] The positive scenario is:

```js
f.arm();
f.o.touches = 2; f.tick(1, 'touch');
f.o.scale = 2; f.o.width = f.o.clientWidth / 2; f.tick();
f.o.scale = 1; f.o.width = f.o.clientWidth; f.tick();
assert.equal(f.count.back, 0);
f.o.touches = 0; f.tick(1, 'touch'); f.settle();
assert.equal(f.c.evidence().phase, 'preparing');
f.acknowledge(); f.settle();
assert.equal(f.c.evidence().preparations, 1);
assert.equal(f.o.historyLength, 2);
```

- [ ] Add route assertion using existing `open`:

```ts
await open(page, 'baseline', '/diagnostics/viewport-preventive');
await expect(page.getByRole('button', { name: 'Enable rotation prevention' })).toBeVisible();
await expect(page.getByRole('button', { name: 'Enable automatic recovery' })).toHaveCount(0);
await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute('content', /minimum-scale|maximum-scale/);
```

- [ ] Append the new Node file to the existing contract command, commit
  with `[skip ci]` and the required trailer, push, dispatch remotely:

```bash
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

Require actual missing-module/route failures before implementing.

## Task 2: Pure preventive transaction

**Create:** `app/features/diagnostics/preventiveNativeRecovery.ts`.
**Reuse unchanged:** `nativeViewportPolicy.ts`, `nativeHistoryBrowser.ts`.

- [ ] Define ports by reusing `AutoPorts` without its publisher, replacing
  it with `publish(PreventiveProbeEvidence)`. Keep mutable phase, reason,
  intent, cycle/preparations/gesture/orientation counters, pendingAck,
  deadline, previous contact count, direction and saw-departure flag.
- [ ] Implement initial admission from the approved spec; establish one
  owned pair after fresh stable original readings. Compute live evidence
  from `ports.read()` even in terminal states.
- [ ] On a new multi-touch sequence, increment gesture counter and clear
  intent. Record a departure only while at least two contacts are present:

```ts
if (o.touches >= 2 && validGeometry(o) && Math.abs(o.scale - 1) > 0.01) {
  sawDeparture = true;
}
```

Partial release keeps `pinching`. All contacts released starts one fixed
three-second window only if departure was observed; otherwise return
watching with `no-scale-change`.
- [ ] Assess original geometry with `atOriginalScale` first; consistent
  non-unit becomes intentional non-unit without traversal. Contradictory
  geometry waits only until the fixed deadline. New contact, focus or
  orientation cancels that gesture. A subsequent new gesture may start.
- [ ] On eligible original geometry call back exactly once, wait for owned
  acknowledgment, reset stability, then verify original geometry and
  re-arm. Increase completed preparations only after re-arm and ownership
  checks succeed. Restore failure stops; no retry or reactive action.
- [ ] Check counter bounds before increments. Preserve opaque router state
  and all live guards through the unchanged adapter. Stop cancels re-arm,
  never attempts to cancel or compensate an issued native traversal.

## Task 3: Schema and focused composition

**Modify:** `lib/viewportDiagnostics.ts`,
`app/api/diagnostics/viewport/route.ts`,
`app/features/diagnostics/viewportCapture.ts`,
`app/features/diagnostics/useNativeHistoryProbe.ts`,
`app/features/diagnostics/ViewportDiagnostics.tsx`.
**Create:** `app/features/diagnostics/PreventiveRecoveryControls.tsx`,
`app/diagnostics/viewport-preventive/page.tsx`.

- [ ] Add the new exact evidence shape and type guard:

```ts
type PreventiveProbeEvidence = Omit<AutoProbeEvidence, 'phase' | 'reason' | 'corrections'> & {
  phase: typeof PREVENTIVE_PHASES[number];
  reason: typeof PREVENTIVE_REASONS[number];
  preparations: number;
  gestureEpoch: number;
};
// isPreventiveProbeEvidence checks the preparations discriminator.
```

Use the spec's phase allowlist and existing common reasons plus `nonunit`,
`overlay`, `overflow`, `superseded`, `stopped-by-user`, `unassessed`,
`no-scale-change`, `counter-limit`. Version becomes 5; experiment adds
`native-history-preventive`. Validate exact shape and identity independently
from reactive/manual evidence; reject version 4 as outdated.
- [ ] Add hook kind `preventive`, selecting the new controller. Deliver
  focus events to either automatic controller. Reuse passive listeners,
  live evidence, 100ms ticks and safe cleanup.
- [ ] Gate the new kind only on its exact baseline route. Render its own
  controls and experiment identity; exclude its shape from manual controls.
  Capture experiment identity with the new type guard before other guards.
- [ ] Controls show preparations, raw scale via the existing panel, phase
  and fixed reason messages. Disclose extra history and no prevention
  guarantee. New route only returns `<ChatPageClient />`.

## Task 4: Browser, API and preserved regressions

**Create:** `tests/preventive-native-recovery.spec.ts`.
**Modify:** `tests/helpers/viewportDiagnosticFixture.ts`,
`tests/playwright.config.ts`, `.github/workflows/markdown-typography.yml`,
`tests/viewport-diagnostics.test.mjs`, `tests/viewport-diagnostics.spec.ts`,
`tests/automatic-native-recovery.spec.ts`.

- [ ] Add the preventive URL to the test harness's initial-blank replacement
  allowlist, never replacing a running document.
- [ ] Use real history with synthetic native viewport readings for three
  gesture preparations. Preserve draft, attachment, streaming, document
  and shell/composer handles; assert length2 and no extra send/resume.
- [ ] Cover no-departure/non-unit/rotation-only behavior, near-original
  full-width baseline, interruption, Stop, browser Back, overlay history,
  and absence of reactive fallback after later injected enlargement.
- [ ] Upload schema-5 preventive evidence through the real API; verify the
  saved shape, privacy and rejection of mixed experiment data. Update
  existing version fixtures/assertions, retaining old-version rejection.
- [ ] Add native Chromium CDP observation: gesture contacts plus real native
  scale2 then1, before any rotation; record three real preparations and
  unchanged native geometry/history. Do not manufacture a claim that iOS
  rotation prevention has been proven by CDP.
- [ ] Add separate preventive E2E workflow step with the existing timeout,
  workers1 and artifact conventions; include its spec in mobile selectors.
  Keep all existing workflow stages.
- [ ] Commit/push and run the existing production-origin workflow. Inspect
  exact final results and native evidence; fix in-scope failures remotely.

## Task 5: Review and deployment gate

- [ ] Review against every admission, gesture, transaction, schema and
  physical acceptance condition in approved spec `48f42bc`.
- [ ] Record source/run/artifact provenance and exact limitations.
- [ ] Stop periodic updates and request separate deployment authorization.
  Do not replace PROD or claim physical preventive success before approval.

## Review and Execution Record

- Written spec approved for direct implementation.
- No low arbitrary retry limit is introduced; each gesture is bounded to
  one attempt, with explicit counter-bound stop and no corrective fallback.
- Existing typography fix and manual/reactive behavior remain separate.
