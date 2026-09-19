# Native Recovery Tolerance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> User selected direct inline execution. Neither named execution skill is
> installed; proceed in this session without subagents or local validation.

**Goal:** Apply the existing original-scale tolerance consistently without
weakening intentional-zoom or anomalous-geometry safeguards.

**Architecture:** Change two eligibility predicates in the automatic
controller. Keep geometry helpers, manual recovery and browser history
ownership unchanged. Add policy and real-hook regressions before the fix.

**Tech Stack:** TypeScript, existing Node tests, Playwright, GitHub Actions.

---

## Task 1: Reproduce the conflicting predicates

**Modify:** `tests/automatic-native-recovery.test.mjs`.
The existing `fixture()` exposes `o`, `c`, `arm`, `tick`, `settle`, `rotate`
and operation `count`. Add these cases:

- [ ] Add original-intent, focus and rotation regressions:

```js
test('near-original released pinch uses the original-scale tolerance', () => {
  for (const scale of [1.004727, 0.995]) {
    const f = fixture();
    Object.assign(f.o, { width: 832, clientWidth: 832, scrollWidth: 832, orientation: 'landscape' });
    f.arm();
    f.o.touches = 2; f.tick(1, 'touch');
    Object.assign(f.o, { scale, width: 832, touches: 0 });
    f.settle();
    assert.equal(f.c.evidence().intent, 'original');
    assert.equal(f.count.back, 0);
    f.rotate(); f.settle();
    assert.equal(f.count.back, 1);
  }
});

test('near-original focus exit requires fresh stability then accepts the baseline', () => {
  for (const scale of [1.004727, 0.995]) {
    const f = fixture();
    Object.assign(f.o, { width: 832, clientWidth: 832, scrollWidth: 832, orientation: 'landscape' });
    f.arm();
    f.o.editable = true; f.tick(1, 'focus');
    Object.assign(f.o, { editable: false, scale });
    f.tick(1, 'focus'); f.tick(); f.tick();
    assert.equal(f.c.evidence().intent, 'unknown');
    f.tick(); f.tick();
    assert.equal(f.c.evidence().intent, 'original');
    assert.equal(f.count.back, 0);
  }
});

test('near-original rotation completes assessment without native navigation', () => {
  for (const scale of [1.004727, 0.995]) {
    const f = fixture(); f.arm(); f.rotate(scale, false); f.settle();
    assert.equal(f.c.evidence().phase, 'watching');
    assert.equal(f.c.evidence().reason, 'none');
    assert.equal(f.c.evidence().intent, 'original');
    assert.equal(f.count.back, 0);
  }
});

test('original-scale tolerance does not admit nonunit or excessive width error', () => {
  for (const [scale, width, intent] of [
    [1.02, 832, 'unknown'],
    [0.98, 832, 'unknown'],
    [1.004727, 835, 'unknown'],
    [1, 835, 'unknown'],
    [1.16834, 832 / 1.16834, 'intentional-nonunit'],
    [2.018817, 832, 'unknown'],
  ]) {
    const f = fixture();
    Object.assign(f.o, { width: 832, clientWidth: 832, scrollWidth: 832, orientation: 'landscape' });
    f.arm();
    f.o.touches = 2; f.tick(1, 'touch');
    Object.assign(f.o, { scale, width, touches: 0 }); f.settle();
    assert.equal(f.c.evidence().intent, intent);
    f.rotate(); f.settle();
    assert.equal(f.count.back, 0);
  }
});
```

**Modify:** `tests/automatic-native-recovery.spec.ts`.
The existing helpers `enable`, `panel`, `touch`, `mockCorrection` and
`setTestVisualViewport` remain unchanged.

- [ ] Add a browser case reproducing full-width near-unit geometry:

```ts
test('near-original full-width pinch remains eligible for later correction', async ({ page }) => {
  await enable(page);
  await page.setViewportSize({ width: 832, height: 390 });
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await expect(panel(page)).toHaveAttribute('data-phase', 'watching');
  let cycle = 0;
  for (const scale of [1.004727, 0.995]) {
    await touch(page, 2);
    await page.evaluate(() => {
      if (!window.visualViewport) throw new Error('Test viewport is missing');
      Object.defineProperty(window.visualViewport, 'width', {
        configurable: true, get: () => document.documentElement.clientWidth,
      });
    });
    await setTestVisualViewport(page, 390, 0, scale);
    await touch(page, 0);
    await expect(panel(page)).toHaveAttribute('data-intent', 'original');
    await expect(panel(page)).toHaveAttribute('data-corrections', String(cycle));
    expect(await page.evaluate(() => history.state.viewportHistoryProbe.role)).toBe('working');
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (!viewport) throw new Error('Test viewport is missing');
      Object.defineProperty(viewport, 'width', {
        configurable: true, get: () => window.innerWidth / viewport.scale,
      });
    });
    cycle++;
    await mockCorrection(page, cycle, cycle % 2 === 0);
  }
});
```

- [ ] Commit the tests and plan, push, dispatch the existing workflow:

```bash
git add tests/automatic-native-recovery.test.mjs tests/automatic-native-recovery.spec.ts \
  docs/superpowers/plans/2026-09-19-native-recovery-tolerance.md
git commit -m "test: reproduce original-scale tolerance conflict [skip ci]" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin fix/ios-markdown-text-autosizing
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

Expected: the first three new policy tests fail; the safety case passes.
The browser case fails to learn original intent. Inspect actual job logs
before implementation; all execution is remote.

## Task 2: Implement and validate the narrow repair

**Modify:** `app/features/diagnostics/automaticNativeRecovery.ts`.

- [ ] Replace the watching gate with:

```ts
if (phase === 'watching' && settled && (atOriginalScale(o) || consistentGeometry(o))) {
```

- [ ] Replace the geometry gate inside `assessing-rotation` with:

```ts
if (settled && (atOriginalScale(o) || consistentGeometry(o))) {
```

Keep the block bodies and all other runtime code unchanged.

- [ ] Commit, push and dispatch the same workflow:

```bash
git add app/features/diagnostics/automaticNativeRecovery.ts
git commit -m "fix: consistently accept original-scale viewport tolerance [skip ci]" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin fix/ios-markdown-text-autosizing
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

- [ ] Inspect all three final jobs and exact counts; download final native
  Chromium cycle evidence. Require builds, type checks, Node policy/schema,
  new E2E coverage, existing manual/API/typography and UX regressions green.
- [ ] Review the two-line runtime diff against the approved spec; record
  exact red/green revisions, run IDs and artifact provenance below.
- [ ] Ask for separate deployment authorization. Leave current PROD at
  `e927428` until approved. Stop periodic updates while awaiting user input.

## Review and Execution Record

- Spec `b7d7965` approved for direct inline implementation.
- Plan covers both original-scale recognition gates, fresh focus stability,
  intentional non-unit and inconsistent-geometry protection, near-unit E2E
  after released pinch, remote-only validation and separate deployment.
- No new feature, helper, schema or ordinary-page navigation is introduced.
