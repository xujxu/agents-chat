# Accepted Layout Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. This skill is unavailable; the user chose inline execution, so follow these checkpoints directly.

**Goal:** Preserve bottom following across accepted intermediate layout clamps without overriding independent scroll or history.

**Architecture:** Update the existing controller's accepted-layout branch only. Exercise the actual controller in a deterministic VM fixture and the browser using synchronous expansion/contraction. Keep historical instrumentation pinned to old source.

**Tech Stack:** TypeScript, Node24 standard-library test/VM modules, existing Playwright and Actions.

---

Approved spec: `docs/superpowers/specs/2026-09-26-scroll-layout-cache-design.md`
at7247d65. Implementation and written spec approved inline. No local validation.

## Task 1: Red controller and browser regressions

Files:
- Create `tests/helpers/scrollControllerFixture.mjs`.
- Create `tests/chat-scroll-controller.test.mjs`.
- Modify `tests/chat-reading-anchor.spec.ts`.

- [ ] Fixture loads the real controller with `stripTypeScriptTypes`,
  `SourceTextModule` and `SyntheticModule`, linking the real geometry module and
  a narrow reading-anchor stub. Use event-target Maps, callback Maps for RAF/
  timeouts, explicit ResizeObserver/MutationObserver triggers, and controllable
  container height/top. Expose controller, container, emit, resize, frame,
  pendingFrames and cleanup. No real timer/browser/global mutations.
  Source loading and linkage:

```js
const source = await readFile(new URL('../../app/features/chat/runtime/chatScrollController.ts', import.meta.url), 'utf8');
const module = new SourceTextModule(stripTypeScriptTypes(source), { context });
await module.link(specifier => {
  const exports = specifier === '../chatScrollGeometry' ? geometry
    : specifier === '../chatReadingAnchor' ? anchors : null;
  if (!exports) throw new Error(`Unexpected controller import: ${specifier}`);
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
});
await module.evaluate();
const controller = module.namespace.createChatScrollController(container, () => {}, initial);
```

- [ ] Core causal tests loop heights192/181 with scrollend false/true:

```js
const fixture = await createScrollControllerFixture({ height });
try {
  assert.equal(fixture.container.scrollTop, 8061 - height);
  fixture.resize(height + 3);
  fixture.emit('scroll');
  if (scrollend) fixture.emit('scrollend');
  fixture.resize(179);
  fixture.frame();
  assert.equal(fixture.controller.snapshot().following, true);
  assert.equal(fixture.container.scrollTop, 7882);
} finally { fixture.cleanup(); }
```

- [ ] Add fixtures asserting independent motion during geometry change and before
  delayed scroll delivery both stop following; explicit wheel input stops
  following; an initial historical anchor survives the layout cycle with the
  expected bottom-relative correction; suspended/disposed controllers do not
  schedule correction. Assert pending frames and anchor identity where relevant.
- [ ] Browser tests establish a height192/181 box at landscape width with
  `flex:none`, `box-sizing:border-box` and zero border, scroll to bottom, settle,
  then perform this single synchronous task:

```ts
element.style.height = `${height + 3}px`;
const expandedHeight = element.clientHeight;
element.scrollTop = Math.min(element.scrollTop, element.scrollHeight - expandedHeight);
const expandedTop = element.scrollTop;
element.dispatchEvent(new Event('scroll'));
element.style.height = '179px';
return { expandedHeight, expandedTop, finalHeight: element.clientHeight };
```

  Assert actual expanded/final heights and3px clamp before the existing4px
  bottom-distance poll. Restore the original style attribute in finally.
  Keep the ordinary orientation case unchanged.

## Task 2: Wire Actions contracts and preserve historical diagnostics

Files:
- Modify `.github/workflows/voice-pr-diagnostics.yml`.
- Modify `.github/workflows/markdown-typography.yml`.
- Modify `tests/reading-controller-diagnostics.test.mjs`.

- [ ] Diagnostic contracts job checks out20f5f0e into
  `diagnostic-baseline`, after the main checkout:

```yaml
- uses: actions/checkout@v4
  with:
    ref: 20f5f0e3e55569a4ac7f0878f314f1d8c7b2e009
    path: diagnostic-baseline
```

  Set `DIAGNOSTIC_CONTROLLER_SOURCE` to
  `diagnostic-baseline/app/features/chat/runtime/chatScrollController.ts`.
  The historical test requires that explicit environment path:

```js
assert.ok(process.env.DIAGNOSTIC_CONTROLLER_SOURCE, 'Pinned controller source is required');
const source = await readFile(process.env.DIAGNOSTIC_CONTROLLER_SOURCE, 'utf8');
```

- [ ] Contract command becomes:

```bash
node --experimental-vm-modules --test tests/voice-pr-diagnostics.test.mjs tests/reading-controller-diagnostics.test.mjs tests/chat-scroll-geometry.test.mjs tests/chat-scroll-controller.test.mjs
```

  Existing typography geometry step runs the last two selectors with the same
  VM flag; existing reading suites already discover the added browser cases.
- [ ] Commit/push tests and workflow wiring. Dispatch contracts only:

```bash
gh workflow run voice-pr-diagnostics.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

  Expect causal controller regressions to fail on followingfalse, not fixture/
  import errors. Both diagnostic cohorts remain skipped. Record red evidence.

## Task 3: Minimal cache repair

File: `app/features/chat/runtime/chatScrollController.ts`, onScroll's
geometryChanged branch.

- [ ] Replace only `else scheduleCorrection()` in that branch:

```ts
else {
  geometry = current;
  lastTop = container.scrollTop;
  expectedTop = null;
  scheduleCorrection();
}
```

  Comment only why intermediate accepted clamps must advance classification
  state before another resize. Do not change predicates, following, anchors or
  geometry tolerances.
- [ ] Commit/push repair and dispatch contracts only. Expect all contracts green.
  Inspect ordinary PR typography runs for this exact SHA; if not triggered,
  manually dispatch `markdown-typography.yml` for this branch.
- [ ] Read all three browser results, build/typecheck and deterministic cases.
  Diagnose failures from Actions artifacts; do not blindly rerun or widen
  thresholds. No old diagnostic batch or Windows rerun.

## Task 4: Evidence closeout

- [ ] Update spec/plan with red/green run IDs, final revision, browser results
  and remaining limitations. Update Draft PR #2, preserving unresolved Windows
  evidence. Commit/push docs, verify clean worktree and remote head.
- [ ] Stop progress reminder. No merge, release, package publication or
  reopening licensing/accuracy research.

## Self-review and execution choice

All product changes are confined to the accepted-layout branch. Causal tests
exercise the controller rather than a copied classifier; anchor traversal is
covered by existing actual-browser tests. Historical instrumentation retains
its original exact hash. All execution is Actions-only. The user already chose
inline implementation; no additional execution-choice prompt is needed.
