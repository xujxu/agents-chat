# iOS Initial Viewport Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ineffective runtime viewport reset with an initial iOS scale ceiling and a stable 100% authored text-size policy.

**Architecture:** Next.js emits the scale ceiling in the first server-rendered viewport declaration, before WebKit lays out the page. CSS fixes authored typography at 100%, while all runtime viewport-mutation code and its recovery-specific tests are removed; existing viewport sizing and Chat anchor restoration remain unchanged.

**Tech Stack:** Next.js 16 App Router viewport metadata, React 19, CSS `text-size-adjust`, TypeScript 5 strict mode, Playwright mobile projects.

---

**Reference spec:** `docs/superpowers/specs/2026-09-16-ios-initial-viewport-stability-design.md`

**Worktree note:** Keep `.agents-chat-storage.json` untracked and out of every
commit.

## File Structure

- Modify `app/layout.tsx`: emit `maximum-scale=1` in the initial viewport.
- Modify `app/globals.css`: use an application-wide 100% text-size adjustment.
- Modify `app/features/layout/components/ChatShell.tsx`: remove the ineffective recovery hook integration.
- Delete `app/features/layout/hooks/useIOSOrientationScaleRecovery.ts`: remove runtime meta mutation and timers.
- Delete `app/features/layout/orientationScaleRecovery.ts`: remove the unused runtime policy helper.
- Delete `tests/orientation-scale-recovery.spec.ts`: remove tests for the superseded policy helper.
- Modify `tests/mobile-responsive.spec.ts`: assert static policy, no runtime viewport mutation, stable typography/drafts/layout, and retain anchor coverage without recovery delays.

### Task 1: Rewrite Tests for the Initial Viewport Policy

**Files:**
- Modify: `tests/mobile-responsive.spec.ts:1-115,247-560`

- [ ] **Step 1: Remove recovery-specific test helpers**

Change the Playwright import back to:

```ts
import { expect, test, type Locator } from '@playwright/test';
```

Delete the complete `ViewportMutationTestWindow` declaration and the complete
`startViewportMutationRecording`, `getViewportMutations`, and
`clearViewportMutations` functions.

Delete the complete tests named:

```ts
test('temporarily recovers iOS scale and restores the zoom-enabled viewport', ...)
test('does not mutate viewport metadata for Android orientation events', ...)
test('reports a missing viewport meta without leaving recovery active', ...)
```

- [ ] **Step 2: Change the repeated-orientation test to require the static policy**

Rename:

```ts
test('prevents automatic zoom across repeated orientation changes', async ({
```

to:

```ts
test('keeps typography stable with the initial viewport policy', async ({
```

Replace the initial viewport assertions with:

```ts
  const viewport = page.locator('meta[name="viewport"]');
  const viewportContent = await viewport.getAttribute('content');
  if (!viewportContent) throw new Error('Viewport content not found');
  expect(viewportContent).toMatch(/maximum-scale\s*=\s*1/i);
  expect(viewportContent).not.toMatch(/user-scalable\s*=\s*no/i);
```

Immediately afterward, install a local observer that records any transient
runtime viewport changes:

```ts
  await page.evaluate(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) throw new Error('Viewport meta not found');
    const testWindow = window as Window & {
      __orientationViewportMutations?: string[];
    };
    testWindow.__orientationViewportMutations = [];
    new MutationObserver(() => {
      testWindow.__orientationViewportMutations?.push(
        meta.getAttribute('content') ?? '',
      );
    }).observe(meta, {
      attributes: true,
      attributeFilter: ['content'],
    });
  });
```

Change the expected `text-size-adjust` values from:

```ts
{ supported: true, values: ['none', 'none', 'none'] }
```

to:

```ts
{ supported: true, values: ['100%', '100%', '100%'] }
```

After the existing 2.5-second delayed typography assertion, add:

```ts
  expect(await page.evaluate(() =>
    (window as Window & {
      __orientationViewportMutations?: string[];
    }).__orientationViewportMutations ?? []
  )).toEqual([]);
  await expect(viewport).toHaveAttribute('content', viewportContent);
```

Keep the existing Markdown/header/Composer computed-font checks, interactive
control minimum size checks, layout width checks, and Composer draft
assertion.

- [ ] **Step 3: Remove runtime-recovery delays from anchor tests**

Change both anchor tests back to the simple page fixture:

```ts
test('keeps the latest message pinned through portrait relayout', async ({ page }) => {
```

```ts
test('keeps the same historical message position through portrait relayout', async ({ page }) => {
```

Delete both blocks:

```ts
  if (browserName === 'webkit') {
    await page.waitForTimeout(500);
  }
```

The existing `expect.poll` calls remain responsible for waiting until the
anchor settles.

- [ ] **Step 4: Run the static-policy test and verify it fails**

Serve current source on an alternate test port with the repository's fixture
credentials:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
NEXTAUTH_URL=http://localhost:3011 \
npx next dev --port 3011
```

In another shell, run:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  --grep "initial viewport policy" \
  --reporter=line
```

Expected: FAIL because the initial viewport does not contain
`maximum-scale=1`; after that assertion is implemented, the unchanged CSS
would also fail the expected `100%` text-size policy.

- [ ] **Step 5: Leave the failing tests uncommitted for Task 2**

Run:

```bash
git status --short
```

Expected: only `tests/mobile-responsive.spec.ts` is modified in addition to
the existing untracked `.agents-chat-storage.json`. Stop the exact temporary
dev-server process before proceeding.

### Task 2: Implement the Initial Policy and Remove Runtime Recovery

**Files:**
- Modify: `app/layout.tsx:42-47`
- Modify: `app/globals.css:39-44`
- Modify: `app/features/layout/components/ChatShell.tsx:3-6,40-44`
- Delete: `app/features/layout/hooks/useIOSOrientationScaleRecovery.ts`
- Delete: `app/features/layout/orientationScaleRecovery.ts`
- Delete: `tests/orientation-scale-recovery.spec.ts`
- Modify: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Emit the scale ceiling in initial viewport metadata**

Change the `Viewport` export in `app/layout.tsx` to:

```ts
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  interactiveWidget: 'resizes-content',
};
```

Do not add `userScalable: false`.

- [ ] **Step 2: Change the authored text adjustment to 100%**

Change the existing block in `app/globals.css` to:

```css
html,
.chatPageRoot,
.chatPageRoot * {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
```

Do not change feature font sizes or mobile breakpoints.

- [ ] **Step 3: Remove the hook integration from ChatShell**

Delete this import from
`app/features/layout/components/ChatShell.tsx`:

```ts
import { useIOSOrientationScaleRecovery } from '../hooks/useIOSOrientationScaleRecovery';
```

Delete this invocation:

```ts
  useIOSOrientationScaleRecovery();
```

Keep the existing effect that synchronizes `--app-viewport-height` and
`--app-viewport-offset-top`.

- [ ] **Step 4: Delete superseded recovery files**

Delete exactly:

```text
app/features/layout/hooks/useIOSOrientationScaleRecovery.ts
app/features/layout/orientationScaleRecovery.ts
tests/orientation-scale-recovery.spec.ts
```

Confirm no runtime references remain:

```bash
rg "useIOSOrientationScaleRecovery|buildScaleLockedViewportContent|isIOSDevice|RECOVERY_ERROR_PREFIX" app tests
```

Expected: no matches.

- [ ] **Step 5: Run focused policy and anchor tests**

Start the temporary current-source server as in Task 1 Step 4, then run
sequentially:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  --grep "initial viewport policy|latest message pinned|historical message position" \
  --reporter=line

ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  --grep "initial viewport policy|latest message pinned|historical message position" \
  --reporter=line
```

Expected: 3 tests pass in each project. Stop the exact temporary server
process.

- [ ] **Step 6: Run TypeScript and inspect the diff**

Run:

```bash
npx tsc --noEmit
git --no-pager diff --check
git status --short
```

Expected: TypeScript and diff checks pass. Status shows only the intended
modified/deleted implementation and test files plus untracked
`.agents-chat-storage.json`.

- [ ] **Step 7: Commit the replacement**

```bash
git add app/layout.tsx app/globals.css \
  app/features/layout/components/ChatShell.tsx \
  app/features/layout/hooks/useIOSOrientationScaleRecovery.ts \
  app/features/layout/orientationScaleRecovery.ts \
  tests/orientation-scale-recovery.spec.ts \
  tests/mobile-responsive.spec.ts
git commit -m "fix: establish iOS viewport scale at page load" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Validate, Build, Deploy, and Decide the Candidate

**Files:**
- Verify: `app/layout.tsx`
- Verify: `app/globals.css`
- Verify: `app/features/layout/components/ChatShell.tsx`
- Verify: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Run full mobile regression sequentially**

With current source on the alternate test port, run:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  --reporter=line

ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  --reporter=line
```

Expected: all tests pass in both projects. Run sequentially because parallel
mobile fixtures cause login timeouts on this machine.

- [ ] **Step 2: Run final static validation**

Run:

```bash
npx tsc --noEmit
git --no-pager diff --check
git status --short --branch
```

Expected: no TypeScript or whitespace errors; no tracked changes; only
`.agents-chat-storage.json` remains untracked. Restore `next-env.d.ts` from
`.next/dev/types/routes.d.ts` to `.next/types/routes.d.ts` if the dev server
changed it.

- [ ] **Step 3: Stop production and build**

Ask the user to run:

```bash
sudo systemctl stop agents-chat.service
```

Verify `systemctl is-active agents-chat.service` reports `inactive`, then run:

```bash
npm run build
```

Expected: the production build and TypeScript phase succeed.

- [ ] **Step 4: Start and smoke-test production**

Ask the user to run:

```bash
sudo systemctl start agents-chat.service
```

Then run:

```bash
systemctl is-active agents-chat.service
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:3010/login
```

Expected: service is `active`; `/login` returns HTTP `200`.

- [ ] **Step 5: Perform physical Safari acceptance**

On the same iPhone:

1. Open a Chat with visible Markdown at the latest message.
2. Rotate portrait to landscape and back to portrait.
3. Wait at least three seconds.
4. Confirm typography did not become or remain enlarged.
5. Confirm the latest message remains at the bottom.
6. Confirm pinch zoom works after rotation.
7. Repeat from an older message and confirm its anchor remains stable.

Expected: all seven checks pass in Safari.

- [ ] **Step 6: Perform physical iOS Chrome acceptance**

Repeat all seven checks from Step 5 in iOS Chrome.

Expected: Chrome does not remain enlarged in portrait and pinch zoom remains
available.

- [ ] **Step 7: Apply the acceptance decision**

If both browsers pass rotation, anchor, and pinch checks, keep the candidate
and record:

```bash
git status --short --branch
systemctl is-active agents-chat.service
```

Expected: only `.agents-chat-storage.json` is untracked and production is
active.

If either browser loses pinch zoom, do not accept the candidate. Remove
`maximumScale: 1`, rerun the focused viewport test with the expected rollback
policy, rebuild, and redeploy before starting the CSS inverse-scaling design.

If rotation scaling remains wrong, do not retain `maximumScale: 1`; roll back
the candidate for the same reason and proceed to the CSS inverse-scaling
investigation.
