# Chrome Native History Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Execution override: continue inline as the user requested. Neither execution
> skill is installed. Do not spawn subagents. All validation runs in Actions.

**Goal:** Determine whether an owned same-document history checkpoint can restore native Chrome scale without reloading or compensating the page visually.

**Architecture:** Keep the normal chat unchanged. A pure controller owns a single
checkpoint/restore lifecycle; a browser adapter supplies history, viewport, and
identity observations. The existing opt-in diagnostic panel displays controls
and records strict version-3 evidence through the existing private upload API.

**Tech Stack:** Next.js App Router, React, TypeScript, History/VisualViewport APIs,
Node test runner, Playwright, existing three-engine GitHub Actions workflow.

---

## File boundaries

- `app/features/diagnostics/nativeHistoryProbe.ts`: deterministic controller and
  ports; no DOM, React, timers, persistence, or native-scale emulation.
- `app/features/diagnostics/useNativeHistoryProbe.ts`: one browser controller per
  mounted probe, owned history markers, identity references, events and cleanup.
- `app/features/diagnostics/NativeHistoryProbeControls.tsx`: accessible controls,
  clear history warning, phase and error messages.
- `app/features/diagnostics/ViewportDiagnostics.tsx`: gated composition and
  recording of probe transitions, without changing ordinary shell behavior.
- `app/features/diagnostics/ViewportDiagnostics.css`: scrollable experimental
  panel bounded to the real visual viewport; no CSS scale.
- `app/diagnostics/viewport-history/page.tsx`: existing chat composition only.
- `lib/viewportDiagnostics.ts`: version-3 exact-key contract and evidence types.
- `app/features/diagnostics/viewportCapture.ts`: version-3 defaults.
- `app/api/diagnostics/viewport/route.ts`: explicit old-collector errors.
- `tests/native-history-probe.test.mjs`: controller tests with deterministic
  time/history ports.
- `tests/viewport-diagnostics.test.mjs`, `tests/viewport-diagnostics.spec.ts`:
  schema, storage, API, route and real History API coverage.
- `.github/workflows/markdown-typography.yml`: include the new Node suite;
  existing browser selectors already include the changed diagnostic spec.

## Task 1: Establish a failing remote contract

- [ ] Write the pure-controller tests first. Define the interface as:

```ts
type Observation = {
  now: number; scale: number | null; width: number | null;
  clientWidth: number; orientation: 'portrait' | 'landscape';
  touches: number; editable: boolean; historyLength: number;
  entry: 'checkpoint' | 'working' | null; sameUrl: boolean;
  documentContinuous: boolean; shellContinuous: boolean;
  composerContinuous: boolean;
};
type Ports = {
  read(): Observation;
  checkpoint(): void;
  back(): void;
  publish(evidence: ProbeEvidence): void;
};
// Factory result: arm(), restore(), observe(event), evidence().
// Events: tick, touch, orientation, popstate, navigation, lifecycle.
```

Test healthy arm at times 0/100/200/300; assert one checkpoint and no back.
Then supply a settled rotated scale 2.16 and call restore; assert one back.
Supply the owned checkpoint popstate and stable scale 1; assert restored.
Explicitly test non-unit scale, missing API, width mismatch, active touch,
editable focus, non-fresh history, marker/URL/DOM ownership loss, no rotation,
too-early restore, repeated calls, API exceptions, wrong popstate, three-second
timeout and lifecycle invalidation.

- [ ] Add a browser red case asserting the new route renders the chat, has the
  ordinary viewport policy, and exposes the probe only with baseline enabled:

```ts
await open(page, 'baseline', '/diagnostics/viewport-history');
await expect(page.getByRole('button', {
  name: 'Establish 100% checkpoint',
})).toBeVisible();
await expect(page.locator('meta[name="viewport"]'))
  .not.toHaveAttribute('content', /minimum-scale|maximum-scale/);
```

- [ ] Extend the existing remote Node step:

```yaml
run: node --experimental-strip-types --test tests/viewport-diagnostics.test.mjs tests/native-history-probe.test.mjs
```

- [ ] Commit tests with `[skip ci]`, push, and dispatch:

```bash
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

Expected red: controller module missing; browser candidate route absent.
Record the run and its actual result. No local runner invocation.

## Task 2: Implement the bounded controller

- [ ] Implement the factory against the above ports. Polling is external.
  Use a 300 ms stability window with at least three observations. Reset that
  window on changes to scale/width/client width/orientation, touch or focus.
  Reject missing/nonfinite geometry. Initial scale tolerance is 0.01 and
  width tolerance is 2 CSS pixels. Only an explicit arm may write history.

```ts
const atOriginalScale = (o: Observation) =>
  o.scale !== null && Number.isFinite(o.scale) &&
  Math.abs(o.scale - 1) <= 0.01 &&
  o.width !== null && Number.isFinite(o.width) &&
  o.clientWidth > 0 && Math.abs(o.width - o.clientWidth) <= 2;
```

- [ ] Arm only from idle and history length 1. Recheck prerequisites before
  calling checkpoint. Consume the attempt before calling the port, so an
  exception cannot allow a second partial history write.
- [ ] Require owned working marker, length 2, same URL and original DOM
  references throughout armed/restoring. Require an observed orientation
  change and settled scale greater than 1.01 before explicit restore.
- [ ] Set restoring before calling back, and accept only the checkpoint
  popstate within three seconds. Start a separate three-second settling
  deadline after that acknowledgment. No acknowledgment or stable scale
  failure yields an explicit negative outcome, never a retry/fallback.
- [ ] On exceptions emit a fixed `history-error` reason, not arbitrary exception
  text in uploads. Report it visibly. Invalidation never navigates.

## Task 3: Browser adapter and evidence contract

- [ ] Define `ProbeEvidence` using literal phase/reason unions, an owned-entry
  boolean and three continuity booleans. Add a nullable `probe` to every
  sample and `experiment: 'native-history' | null` to the version-3 log.
  Add `probe` to allowed sample events; transitions inherit recorder time.
  Exact-key validation must reject private/unknown fields and invalid enums.
  Ordinary logs require null probe data; history logs require evidence.
- [ ] Update initial capture and all existing test payloads to version 3.
  Reject versions 1 and 2 explicitly with a fresh-tab instruction:

```ts
throw new DiagnosticError(
  400, 'outdated_log',
  'Open a fresh diagnostic tab and collect a new log before uploading.',
);
```

- [ ] Implement marker reads by checking opaque `history.state` object shape.
  Use a random per-controller token and namespace; preserve all other fields.
  Do not create Next internal fields. A checkpoint uses:

```ts
history.replaceState({ ...existing, viewportHistoryProbe: {
  token, role: 'checkpoint',
} }, '', href);
history.pushState({ ...existing, viewportHistoryProbe: {
  token, role: 'working',
} }, '', href);
```

- [ ] Capture Document, shell, and composer references before arming. Read
  identity equality on each observation; track touches passively, listen to
  orientation/resize/popstate/hashchange/pagehide, and sample every 100 ms.
  Cleanup removes listeners/timers and invalidates without changing history.
- [ ] Gate the hook on exact route plus baseline query. Retain ordinary route
  behavior. Provide establish/restore controls, one-shot phase labels, explicit
  refusal/error text, and history warning. Record every controller transition
  immediately through the existing recorder; regular samples include current
  evidence. Keep failed-upload frozen snapshots unchanged.
- [ ] Bound only the experimental panel to real viewport width/height and
  offset, with internal scrolling. Preserve native pinch and authored viewport.

## Task 4: Continuity, failure, and private-upload coverage

- [ ] Add real History API tests using a fresh browser tab. After checkpoint,
  assert length grows from 1 to 2 and opaque state is preserved. Capture
  Document/shell/composer handles and count navigation requests.
- [ ] With synthetic viewport metrics, rotate and enlarge, click restore,
  acknowledge real popstate, then supply scale 1. Assert restored only after
  stable geometry. Keep a separate no-metric-reset case ending not-restored;
  mocked success must not be reported as evidence of native recovery.
- [ ] Add draft and attachment before restoration and retain a selected
  conversation. Start the existing controlled typography stream, restore,
  append text, and confirm streaming continues with exactly one send and no
  new resume/start request. Verify document and DOM references are unchanged.
- [ ] Verify user Back is not prevented, ownership loss disables restoration,
  stale log versions fail, probe uploads contain only the allowlisted fields,
  private content never appears in saved evidence, and normal/minimum routes
  contain no probe controls or history writes.
- [ ] Check control rectangles against a small synthetic landscape visual
  viewport. Where feasible, add an actual Chromium CDP page-scale case:

```ts
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
```

Observe and attach results without asserting this emulation proves iOS native
behavior. Retain all existing upload/API and three-engine regressions.

## Task 5: Remote green run and handoff

- [ ] Commit the implementation and dispatch the same production-origin
  workflow. Inspect step failures and fix the cause; do not weaken acceptance
  or run locally. Record exact run/commit/build evidence.
- [ ] Keep progress messages at least every 15 minutes while work is active.
  Use the requested schedule, bounded CLI waits, and durable todo state.
- [ ] Self-review the diff for accidental ordinary-page history changes,
  viewport mutations, reloads, gesture interception, arbitrary log content,
  uncontrolled repeated navigation, and loss of router state.
- [ ] Update this execution record, commit, and request deployment approval
  with the actual remote outcome. Do not deploy an unapproved artifact.
  A green run is not a fix claim: real Chrome acceptance remains blocked.

## Execution record

- Resumed after interrupted written-spec confirmation; user requested inline
  continuation and 15-minute progress output.
- Specification: `3bb51a6`; production remains `29195d0`.
- Plan self-review: tasks cover isolation, native geometry, history ownership,
  lifecycle, privacy, continuity, remote-only validation, and separate
  deployment/physical acceptance gates.
