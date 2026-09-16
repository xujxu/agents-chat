# iOS Orientation Scale Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reset stale iOS WebKit page scaling after device rotation while preserving Chat state, message position, and pinch zoom after recovery.

**Architecture:** Put deterministic iOS detection and viewport-content transformation in a pure layout helper. A focused client hook groups native orientation/viewport events, briefly applies the scale-1 viewport policy, restores the exact original declaration after two paint frames, and lets the existing Chat anchor hook respond to the resulting viewport events.

**Tech Stack:** Next.js 16 App Router, React 19 hooks, TypeScript 5 strict mode, Playwright mobile projects, browser `visualViewport` and viewport metadata APIs.

---

**Reference spec:** `docs/superpowers/specs/2026-09-16-ios-orientation-scale-recovery-design.md`

**Worktree note:** Keep the existing untracked `.agents-chat-storage.json` out of every commit.

## File Structure

- Create `app/features/layout/orientationScaleRecovery.ts`: pure iOS device detection and temporary viewport declaration construction.
- Create `app/features/layout/hooks/useIOSOrientationScaleRecovery.ts`: orientation generation, settling, viewport mutation/restoration, error reporting, and cleanup.
- Modify `app/features/layout/components/ChatShell.tsx`: invoke the focused hook before the existing viewport synchronization effect.
- Create `tests/orientation-scale-recovery.spec.ts`: fast policy tests that do not require a mobile fixture.
- Modify `tests/mobile-responsive.spec.ts`: observe viewport mutations and verify iOS lifecycle, non-iOS isolation, focus/draft retention, and message-anchor regressions.

### Task 1: Implement the Pure Recovery Policy

**Files:**
- Create: `tests/orientation-scale-recovery.spec.ts`
- Create: `app/features/layout/orientationScaleRecovery.ts`

- [ ] **Step 1: Write failing policy tests**

Create `tests/orientation-scale-recovery.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import {
  buildScaleLockedViewportContent,
  isIOSDevice,
} from '../app/features/layout/orientationScaleRecovery';

test('detects iPhone and desktop-UA iPadOS without matching Android', () => {
  expect(isIOSDevice({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 5,
  })).toBe(true);
  expect(isIOSDevice({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  })).toBe(true);
  expect(isIOSDevice({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7)',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
  })).toBe(false);
});

test('builds a temporary scale lock without losing unrelated directives', () => {
  expect(buildScaleLockedViewportContent(
    'width=device-width, initial-scale=1, interactive-widget=resizes-content',
  )).toBe(
    'width=device-width, interactive-widget=resizes-content, initial-scale=1, minimum-scale=1, maximum-scale=1',
  );
});

test('replaces every existing scale directive case-insensitively', () => {
  expect(buildScaleLockedViewportContent(
    'width=device-width, INITIAL-SCALE=2, minimum-scale=.5, maximum-scale=4, viewport-fit=cover',
  )).toBe(
    'width=device-width, viewport-fit=cover, initial-scale=1, minimum-scale=1, maximum-scale=1',
  );
});
```

- [ ] **Step 2: Run the policy tests and verify they fail**

Run:

```bash
npx playwright test --config tests/playwright.config.ts tests/orientation-scale-recovery.spec.ts --project=desktop-chromium
```

Expected: FAIL because `app/features/layout/orientationScaleRecovery.ts` does not exist.

- [ ] **Step 3: Implement the pure policy helper**

Create `app/features/layout/orientationScaleRecovery.ts`:

```ts
export type NavigatorIdentity = Pick<
  Navigator,
  'userAgent' | 'platform' | 'maxTouchPoints'
>;

const IOS_DEVICE_PATTERN = /iPad|iPhone|iPod/i;
const SCALE_DIRECTIVE_PATTERN =
  /^(?:initial-scale|minimum-scale|maximum-scale)\s*=/i;

export function isIOSDevice(identity: NavigatorIdentity): boolean {
  return IOS_DEVICE_PATTERN.test(identity.userAgent)
    || (identity.platform === 'MacIntel' && identity.maxTouchPoints > 1);
}

export function buildScaleLockedViewportContent(content: string): string {
  const retainedDirectives = content
    .split(',')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => !SCALE_DIRECTIVE_PATTERN.test(directive));

  return [
    ...retainedDirectives,
    'initial-scale=1',
    'minimum-scale=1',
    'maximum-scale=1',
  ].join(', ');
}
```

- [ ] **Step 4: Run the policy tests and type-check**

Run:

```bash
npx playwright test --config tests/playwright.config.ts tests/orientation-scale-recovery.spec.ts --project=desktop-chromium
npx tsc --noEmit
```

Expected: 3 tests pass; TypeScript exits with code 0.

- [ ] **Step 5: Commit the pure policy**

```bash
git add app/features/layout/orientationScaleRecovery.ts tests/orientation-scale-recovery.spec.ts
git commit -m "test: define iOS viewport recovery policy" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add the Orientation Recovery Lifecycle

**Files:**
- Create: `app/features/layout/hooks/useIOSOrientationScaleRecovery.ts`
- Modify: `app/features/layout/components/ChatShell.tsx:3-5,39-61`
- Modify: `tests/mobile-responsive.spec.ts:1-80,247-379`

- [ ] **Step 1: Add viewport mutation test helpers**

Change the first import in `tests/mobile-responsive.spec.ts` and add the helpers after `getTopMessageAnchor`:

```ts
import {
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test';

type ViewportMutationTestWindow = Window & {
  __viewportContentMutations?: string[];
};

async function startViewportMutationRecording(page: Page) {
  await page.evaluate(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) throw new Error('Viewport meta not found');
    const testWindow = window as ViewportMutationTestWindow;
    testWindow.__viewportContentMutations = [];
    new MutationObserver(() => {
      testWindow.__viewportContentMutations?.push(
        meta.getAttribute('content') ?? '',
      );
    }).observe(meta, {
      attributes: true,
      attributeFilter: ['content'],
    });
  });
}

async function getViewportMutations(page: Page) {
  return page.evaluate(() =>
    (window as ViewportMutationTestWindow).__viewportContentMutations ?? []
  );
}

async function clearViewportMutations(page: Page) {
  await page.evaluate(() => {
    (window as ViewportMutationTestWindow).__viewportContentMutations = [];
  });
}
```

- [ ] **Step 2: Write failing lifecycle and platform-isolation tests**

Add these tests after `prevents automatic zoom across repeated orientation changes`:

```ts
test('temporarily recovers iOS scale and restores the zoom-enabled viewport', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'iOS recovery requires the iPhone project');

  const viewport = page.locator('meta[name="viewport"]');
  const originalContent = await viewport.getAttribute('content');
  expect(originalContent).not.toBeNull();
  await startViewportMutationRecording(page);

  const textarea = page.locator('textarea.composerTextarea');
  await textarea.fill('draft survives viewport recovery');
  await textarea.focus();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('orientationchange'))
  );

  await expect.poll(async () =>
    (await getViewportMutations(page)).filter((content) =>
      /maximum-scale\s*=\s*1/i.test(content)
    )
  ).toHaveLength(1);
  await expect.poll(() => viewport.getAttribute('content')).toBe(originalContent);
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue('draft survives viewport recovery');
  expect(await viewport.getAttribute('content')).not.toMatch(
    /maximum-scale\s*=\s*1|user-scalable\s*=\s*no/i,
  );

  await clearViewportMutations(page);
  await page.evaluate(async () => {
    for (let index = 0; index < 3; index += 1) {
      window.dispatchEvent(new Event('orientationchange'));
      await new Promise((resolve) => window.setTimeout(resolve, 75));
    }
  });
  await expect.poll(async () =>
    (await getViewportMutations(page)).filter((content) =>
      /maximum-scale\s*=\s*1/i.test(content)
    )
  ).toHaveLength(1);
  await expect.poll(() => viewport.getAttribute('content')).toBe(originalContent);
});

test('does not mutate viewport metadata for Android orientation events', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'Android isolation uses the Chromium project');
  await startViewportMutationRecording(page);

  await page.evaluate(() =>
    window.dispatchEvent(new Event('orientationchange'))
  );
  await page.waitForTimeout(500);

  expect(await getViewportMutations(page)).toEqual([]);
});
```

- [ ] **Step 3: Run the lifecycle tests and verify they fail**

Run:

```bash
npx playwright test --config tests/playwright.config.ts tests/mobile-responsive.spec.ts \
  --project=iphone-webkit --grep "temporarily recovers iOS scale"
npx playwright test --config tests/playwright.config.ts tests/mobile-responsive.spec.ts \
  --project=android-chromium --grep "does not mutate viewport metadata"
```

Expected: the iPhone test FAILS because no temporary `maximum-scale=1` mutation
occurs; the Android isolation test PASSES.

- [ ] **Step 4: Implement the focused recovery hook**

Create `app/features/layout/hooks/useIOSOrientationScaleRecovery.ts`:

```ts
'use client';

import { useEffect } from 'react';
import {
  buildScaleLockedViewportContent,
  isIOSDevice,
} from '../orientationScaleRecovery';
import { APP_VIEWPORT_WILL_CHANGE_EVENT } from '../viewportEvents';

const ORIENTATION_SETTLE_MS = 250;
const ORIENTATION_MAX_WAIT_MS = 2_000;
const RECOVERY_ERROR_PREFIX =
  '[viewport] Failed to recover iOS orientation scale.';

type OriginalViewport = {
  element: HTMLMetaElement;
  content: string;
  hadContentAttribute: boolean;
};

export function useIOSOrientationScaleRecovery() {
  useEffect(() => {
    if (!isIOSDevice(navigator)) return;

    const visualViewport = window.visualViewport;
    let generation = 0;
    let orientationActive = false;
    let settleTimer: number | null = null;
    let maximumTimer: number | null = null;
    let firstFrame = 0;
    let secondFrame = 0;
    let originalViewport: OriginalViewport | null = null;

    const reportError = (error: unknown) => {
      console.error(RECOVERY_ERROR_PREFIX, error);
    };

    const restoreOriginalViewport = () => {
      if (!originalViewport) return;
      const { element, content, hadContentAttribute } = originalViewport;
      originalViewport = null;
      try {
        if (hadContentAttribute) element.setAttribute('content', content);
        else element.removeAttribute('content');
      } catch (error) {
        reportError(error);
      }
    };

    const cancelScheduledWork = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (maximumTimer !== null) window.clearTimeout(maximumTimer);
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      settleTimer = null;
      maximumTimer = null;
      firstFrame = 0;
      secondFrame = 0;
    };

    const recoverSettledOrientation = (targetGeneration: number) => {
      if (!orientationActive || targetGeneration !== generation) return;
      orientationActive = false;
      cancelScheduledWork();

      const viewport = document.querySelector<HTMLMetaElement>(
        'meta[name="viewport"]',
      );
      if (!viewport) {
        reportError(new Error('Viewport meta element was not found.'));
        return;
      }

      const originalContent = viewport.getAttribute('content') ?? '';
      originalViewport = {
        element: viewport,
        content: originalContent,
        hadContentAttribute: viewport.hasAttribute('content'),
      };

      try {
        viewport.setAttribute(
          'content',
          buildScaleLockedViewportContent(originalContent),
        );
        firstFrame = window.requestAnimationFrame(() => {
          firstFrame = 0;
          secondFrame = window.requestAnimationFrame(() => {
            secondFrame = 0;
            restoreOriginalViewport();
          });
        });
      } catch (error) {
        restoreOriginalViewport();
        reportError(error);
      }
    };

    const scheduleSettledRecovery = () => {
      if (!orientationActive) return;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      const targetGeneration = generation;
      settleTimer = window.setTimeout(
        () => recoverSettledOrientation(targetGeneration),
        ORIENTATION_SETTLE_MS,
      );
    };

    const beginOrientationRecovery = () => {
      generation += 1;
      cancelScheduledWork();
      restoreOriginalViewport();
      orientationActive = true;
      window.dispatchEvent(new Event(APP_VIEWPORT_WILL_CHANGE_EVENT));
      scheduleSettledRecovery();
      const targetGeneration = generation;
      maximumTimer = window.setTimeout(
        () => recoverSettledOrientation(targetGeneration),
        ORIENTATION_MAX_WAIT_MS,
      );
    };

    window.addEventListener('orientationchange', beginOrientationRecovery);
    window.addEventListener('resize', scheduleSettledRecovery);
    visualViewport?.addEventListener('resize', scheduleSettledRecovery);
    return () => {
      generation += 1;
      orientationActive = false;
      window.removeEventListener(
        'orientationchange',
        beginOrientationRecovery,
      );
      window.removeEventListener('resize', scheduleSettledRecovery);
      visualViewport?.removeEventListener('resize', scheduleSettledRecovery);
      cancelScheduledWork();
      restoreOriginalViewport();
    };
  }, []);
}
```

- [ ] **Step 5: Wire the hook before ChatShell viewport synchronization**

Add the import to `app/features/layout/components/ChatShell.tsx`:

```ts
import { useIOSOrientationScaleRecovery } from '../hooks/useIOSOrientationScaleRecovery';
```

Call it as the first statement in `ChatShell`, before the existing viewport
effect is registered:

```ts
}: ChatShellProps) {
  useIOSOrientationScaleRecovery();
  const pageRef = useRef<HTMLElement | null>(null);
```

This registration order lets the recovery hook dispatch
`APP_VIEWPORT_WILL_CHANGE_EVENT` before `ChatShell` handles the native
`orientationchange`.

- [ ] **Step 6: Run lifecycle tests and type-check**

Run:

```bash
npx playwright test --config tests/playwright.config.ts tests/mobile-responsive.spec.ts \
  --project=iphone-webkit --grep "temporarily recovers iOS scale"
npx playwright test --config tests/playwright.config.ts tests/mobile-responsive.spec.ts \
  --project=android-chromium --grep "does not mutate viewport metadata"
npx tsc --noEmit
```

Expected: both selected tests pass; TypeScript exits with code 0.

- [ ] **Step 7: Commit the recovery lifecycle**

```bash
git add app/features/layout/hooks/useIOSOrientationScaleRecovery.ts \
  app/features/layout/components/ChatShell.tsx \
  tests/mobile-responsive.spec.ts
git commit -m "fix: recover iOS viewport scale after rotation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Verify Failure Cleanup and Chat Anchor Integration

**Files:**
- Modify: `tests/mobile-responsive.spec.ts:381-430`

- [ ] **Step 1: Add a missing-viewport error test**

Add this test beside the recovery lifecycle tests:

```ts
test('reports a missing viewport meta without leaving recovery active', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'iOS recovery requires the iPhone project');
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.locator('meta[name="viewport"]').evaluate((meta) => meta.remove());
  await page.evaluate(() =>
    window.dispatchEvent(new Event('orientationchange'))
  );

  await expect.poll(() =>
    errors.some((message) =>
      message.includes('[viewport] Failed to recover iOS orientation scale.')
    )
  ).toBe(true);
  await page.waitForTimeout(500);
  expect(errors.filter((message) =>
    message.includes('[viewport] Failed to recover iOS orientation scale.')
  )).toHaveLength(1);
});
```

- [ ] **Step 2: Make the existing anchor assertions cover completed iOS recovery**

Change both existing tests to receive `browserName`:

```ts
test('keeps the latest message pinned through portrait relayout', async ({
  page,
  browserName,
}) => {
```

```ts
test('keeps the same historical message position through portrait relayout', async ({
  page,
  browserName,
}) => {
```

Immediately after each `triggerViewportRelayoutWithScrollDrift(...)` call, add:

```ts
  if (browserName === 'webkit') {
    await page.waitForTimeout(500);
  }
```

The 500-millisecond wait covers the 250-millisecond recovery settle period,
two animation frames, the existing 100-millisecond Chat anchor settle period,
and normal timer jitter before making the final position assertion.

- [ ] **Step 3: Run focused cleanup and anchor tests**

Run:

```bash
npx playwright test --config tests/playwright.config.ts tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  --grep "missing viewport meta|latest message pinned|historical message position"
```

Expected: 3 tests pass. The error test observes exactly one explicit recovery
error, and both Chat position tests pass after the recovery window.

- [ ] **Step 4: Run the corresponding Android anchor regression**

Run:

```bash
npx playwright test --config tests/playwright.config.ts tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  --grep "latest message pinned|historical message position"
```

Expected: 2 tests pass without the iOS recovery delay or viewport mutation.

- [ ] **Step 5: Commit the resilience coverage**

```bash
git add tests/mobile-responsive.spec.ts
git commit -m "test: cover viewport recovery resilience" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Validate, Build, Deploy, and Perform Physical Acceptance

**Files:**
- Verify: `app/features/layout/orientationScaleRecovery.ts`
- Verify: `app/features/layout/hooks/useIOSOrientationScaleRecovery.ts`
- Verify: `app/features/layout/components/ChatShell.tsx`
- Verify: `tests/orientation-scale-recovery.spec.ts`
- Verify: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Run all focused recovery and mobile responsive tests**

Run:

```bash
npx playwright test --config tests/playwright.config.ts \
  tests/orientation-scale-recovery.spec.ts \
  --project=desktop-chromium
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit
```

Expected: all selected tests pass. Treat fixture login/server latency as an
environment failure only when the failure occurs before the tested UI loads;
rerun only the affected project after confirming the service is responsive.

- [ ] **Step 2: Run strict TypeScript validation**

Run:

```bash
npx tsc --noEmit
```

Expected: exit code 0 with no diagnostics.

- [ ] **Step 3: Confirm the intended diff and protected untracked file**

Run:

```bash
git --no-pager diff --check
git status --short
git --no-pager log -4 --oneline
```

Expected: no whitespace errors; no tracked implementation changes remain
uncommitted; `.agents-chat-storage.json` remains untracked and uncommitted.

- [ ] **Step 4: Stop production before building**

Ask the user to run:

```bash
sudo systemctl stop agents-chat.service
```

Then verify:

```bash
systemctl is-active agents-chat.service
```

Expected: `inactive`.

- [ ] **Step 5: Build the production application**

Run:

```bash
npm run build
```

Expected: Next.js production build succeeds. If a development run changed
`next-env.d.ts` to `.next/dev/types/routes.d.ts`, restore the tracked production
form `.next/types/routes.d.ts` before proceeding and confirm `git status`.

- [ ] **Step 6: Start and smoke-test production**

Ask the user to run:

```bash
sudo systemctl start agents-chat.service
```

Then verify:

```bash
systemctl is-active agents-chat.service
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:3010/login
```

Expected: service is `active`; `/login` returns HTTP `200`.

- [ ] **Step 7: Complete physical Safari acceptance**

On the same iPhone used for diagnostics:

1. Open a Chat whose latest message contains visible Markdown.
2. Confirm the Chat is at the latest message.
3. Rotate portrait to landscape, return to portrait, and wait at least three
   seconds.
4. Confirm Markdown and application chrome did not remain enlarged.
5. Confirm the latest message remains visible at the bottom.
6. Pinch zoom after rotation and confirm zoom still works.
7. Scroll to an older message, repeat the rotation, and confirm the same
   message remains anchored.

Expected: every check passes in Safari.

- [ ] **Step 8: Complete physical iOS Chrome acceptance**

Repeat the exact seven checks from Step 7 in iOS Chrome.

Expected: no delayed approximately 2x enlargement appears after returning to
portrait, every position check passes, and post-recovery pinch zoom works.

- [ ] **Step 9: Record final repository and service state**

Run:

```bash
git status --short --branch
systemctl is-active agents-chat.service
```

Expected: branch is `feat/mobile-responsive`; the only worktree entry is the
existing untracked `.agents-chat-storage.json`; the service is `active`.
