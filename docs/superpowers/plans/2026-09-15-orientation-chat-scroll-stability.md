# Orientation Chat Scroll Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a mobile chat's bottom-pinned or historical reading position across portrait/landscape viewport relayouts.

**Architecture:** Add a focused runtime hook that records the last stable message anchor and temporarily shields normal scroll intent from browser-generated viewport scroll changes. Wire the hook into the existing `ChatPageClient` stickiness calculation without changing message state, persistence, or `ChatShell` viewport sizing.

**Tech Stack:** React 19 hooks, TypeScript strict mode, DOM scroll geometry, Visual Viewport API, Playwright Android Chromium and iPhone WebKit.

---

### Task 1: Add Failing Orientation Scroll Position Coverage

**Files:**
- Modify: `tests/mobile-responsive.spec.ts:204-274`

- [ ] **Step 1: Add chat-position helpers**

Add these helpers below `expectExactlyOneActiveModal` in
`tests/mobile-responsive.spec.ts`:

```ts
async function getDistanceFromChatBottom(page: import('@playwright/test').Page) {
  return page.locator('.chatContainer').evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight
  );
}

async function getTopMessageAnchor(page: import('@playwright/test').Page) {
  return page.locator('.chatContainer').evaluate((container) => {
    const containerTop = container.getBoundingClientRect().top;
    const messages = Array.from(container.querySelectorAll<HTMLElement>('.message'));
    const index = messages.findIndex((message) =>
      message.getBoundingClientRect().bottom > containerTop
    );
    if (index < 0) return null;
    return {
      index,
      offsetTop: messages[index].getBoundingClientRect().top - containerTop,
    };
  });
}

async function triggerViewportRelayoutWithScrollDrift(
  page: import('@playwright/test').Page,
  nextHeight: number,
  scrollDrift: number,
) {
  await setTestVisualViewport(page, nextHeight, 0);
  await page.evaluate(({ drift }) => {
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('orientationchange'));
    const container = document.querySelector<HTMLElement>('.chatContainer');
    if (!container) throw new Error('Chat container not found');
    container.scrollTop = Math.max(
      0,
      Math.min(
        container.scrollTop + drift,
        container.scrollHeight - container.clientHeight,
      ),
    );
    container.dispatchEvent(new Event('scroll'));
  }, { drift: scrollDrift });
}
```

The explicit drift reproduces Safari changing `scrollTop` after a viewport
relayout and makes the regression deterministic in both browser engines.

- [ ] **Step 2: Add the bottom-pinned regression test**

Add after `prevents automatic zoom across repeated orientation changes`:

```ts
test('keeps the latest message pinned through portrait relayout', async ({ page }) => {
  const chat = page.locator('.chatContainer');
  await chat.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => getDistanceFromChatBottom(page)).toBeLessThanOrEqual(4);

  await triggerViewportRelayoutWithScrollDrift(page, 760, -180);

  await expect.poll(() => getDistanceFromChatBottom(page), {
    timeout: 2000,
  }).toBeLessThanOrEqual(4);
  await expect(page.getByRole('button', {
    name: 'Jump to latest messages',
  })).toHaveCount(0);
});
```

- [ ] **Step 3: Add the historical-anchor regression test**

Add:

```ts
test('keeps the same historical message position through portrait relayout', async ({ page }) => {
  const chat = page.locator('.chatContainer');
  await chat.evaluate((element) => {
    element.scrollTop = Math.round(
      (element.scrollHeight - element.clientHeight) * 0.55,
    );
    element.dispatchEvent(new Event('scroll'));
  });

  const before = await getTopMessageAnchor(page);
  expect(before).not.toBeNull();
  await expect(page.getByRole('button', {
    name: 'Jump to latest messages',
  })).toBeVisible();

  await triggerViewportRelayoutWithScrollDrift(page, 760, 140);

  await expect.poll(async () => {
    const after = await getTopMessageAnchor(page);
    if (!before || !after) return null;
    return {
      sameMessage: after.index === before.index,
      offsetDelta: Math.round(Math.abs(after.offsetTop - before.offsetTop)),
    };
  }, { timeout: 2000 }).toEqual({
    sameMessage: true,
    offsetDelta: 0,
  });
  await expect(page.getByRole('button', {
    name: 'Jump to latest messages',
  })).toBeVisible();
});
```

The implementation acceptance threshold is four pixels. Keep the initial test
strict at zero so any required browser tolerance is introduced only from
observed cross-engine evidence and never exceeds four.

- [ ] **Step 4: Run Android coverage and verify both tests fail**

Start the temporary server:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 NEXTAUTH_URL=http://localhost:3011 \
  npm run dev -- --port 3011
```

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  -g "pinned through portrait|historical message position"
```

Expected: the bottom test remains about 180 pixels above the latest message,
and/or the historical anchor moves because browser-generated scroll is treated
as user intent.

- [ ] **Step 5: Commit the failing tests**

```bash
git add tests/mobile-responsive.spec.ts
git commit -m "test: cover chat position during orientation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add the Orientation Scroll Stability Hook

**Files:**
- Create: `app/features/chat/runtime/useChatOrientationScrollStability.ts`
- Create: `app/features/layout/viewportEvents.ts`
- Modify: `app/features/layout/components/ChatShell.tsx:50-72`
- Modify: `app/features/chat/ChatPageClient.tsx:1-90,217-252`
- Test: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Create the hook types and anchor capture**

Create `app/features/chat/runtime/useChatOrientationScrollStability.ts`:

```ts
'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react';

const BOTTOM_THRESHOLD = 4;
const VIEWPORT_SETTLE_MS = 100;

type StableAnchor =
  | { kind: 'bottom'; scrollTop: number }
  | {
      kind: 'message';
      element: HTMLElement;
      offsetTop: number;
      scrollTop: number;
    };

type UseChatOrientationScrollStabilityOptions = {
  containerRef: RefObject<HTMLElement | null>;
  shouldStickToBottomRef: MutableRefObject<boolean>;
  lastScrollTopRef: MutableRefObject<number>;
  setShowScrollToBottom: (show: boolean) => void;
};

export function useChatOrientationScrollStability({
  containerRef,
  shouldStickToBottomRef,
  lastScrollTopRef,
  setShowScrollToBottom,
}: UseChatOrientationScrollStabilityOptions) {
  const stableAnchorRef = useRef<StableAnchor | null>(null);
  const relayoutActiveRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const firstFrameRef = useRef(0);
  const secondFrameRef = useRef(0);

  const captureStableAnchor = useCallback((container: HTMLElement) => {
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= BOTTOM_THRESHOLD) {
      stableAnchorRef.current = {
        kind: 'bottom',
        scrollTop: container.scrollTop,
      };
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const messages = Array.from(
      container.querySelectorAll<HTMLElement>('.message'),
    );
    const anchor = messages.find((message) =>
      message.getBoundingClientRect().bottom > containerTop
    );
    stableAnchorRef.current = anchor
      ? {
          kind: 'message',
          element: anchor,
          offsetTop: anchor.getBoundingClientRect().top - containerTop,
          scrollTop: container.scrollTop,
        }
      : null;
  }, []);
```

- [ ] **Step 2: Implement bounded restoration**

Continue the hook with:

```ts
  const restoreStableAnchor = useCallback(() => {
    const container = containerRef.current;
    const anchor = stableAnchorRef.current;
    if (!container || !anchor) {
      relayoutActiveRef.current = false;
      return;
    }

    const maxScrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    let nextScrollTop: number;
    if (anchor.kind === 'bottom') {
      nextScrollTop = maxScrollTop;
    } else if (anchor.element.isConnected) {
      const containerTop = container.getBoundingClientRect().top;
      const currentOffset =
        anchor.element.getBoundingClientRect().top - containerTop;
      nextScrollTop = container.scrollTop + currentOffset - anchor.offsetTop;
    } else {
      nextScrollTop = anchor.scrollTop;
    }

    container.scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const pinnedToBottom =
      anchor.kind === 'bottom' || distanceFromBottom <= BOTTOM_THRESHOLD;
    shouldStickToBottomRef.current = pinnedToBottom;
    lastScrollTopRef.current = container.scrollTop;
    setShowScrollToBottom(!pinnedToBottom);
    relayoutActiveRef.current = false;
    captureStableAnchor(container);
  }, [
    captureStableAnchor,
    containerRef,
    lastScrollTopRef,
    setShowScrollToBottom,
    shouldStickToBottomRef,
  ]);
```

- [ ] **Step 3: Implement debounced viewport lifecycle handling**

Create `app/features/layout/viewportEvents.ts`:

```ts
export const APP_VIEWPORT_WILL_CHANGE_EVENT = 'agents-chat:viewport-will-change';
```

In `ChatShell.tsx`, import the constant and dispatch it immediately before
writing the viewport CSS variables:

```ts
window.dispatchEvent(new Event(APP_VIEWPORT_WILL_CHANGE_EVENT));
page.style.setProperty('--app-viewport-height', `${Math.round(height)}px`);
page.style.setProperty('--app-viewport-offset-top', `${Math.round(offsetTop)}px`);
```

This captures the stable anchor before the CSS write can synchronously reflow
the chat and generate a scroll event.

Continue:

```ts
  const scheduleRestore = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (shouldStickToBottomRef.current) {
      stableAnchorRef.current = {
        kind: 'bottom',
        scrollTop: container.scrollTop,
      };
    } else if (!stableAnchorRef.current) {
      captureStableAnchor(container);
    }
    relayoutActiveRef.current = true;

    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }
    window.cancelAnimationFrame(firstFrameRef.current);
    window.cancelAnimationFrame(secondFrameRef.current);

    settleTimerRef.current = window.setTimeout(() => {
      firstFrameRef.current = window.requestAnimationFrame(() => {
        secondFrameRef.current = window.requestAnimationFrame(
          restoreStableAnchor,
        );
      });
    }, VIEWPORT_SETTLE_MS);
  }, [
    captureStableAnchor,
    containerRef,
    restoreStableAnchor,
    shouldStickToBottomRef,
  ]);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    const captureBeforeRelayout = () => {
      const container = containerRef.current;
      if (container) captureStableAnchor(container);
      scheduleRestore();
    };
    const continueActiveRelayout = () => {
      if (relayoutActiveRef.current) scheduleRestore();
    };

    window.addEventListener(APP_VIEWPORT_WILL_CHANGE_EVENT, captureBeforeRelayout);
    window.addEventListener('resize', scheduleRestore);
    window.addEventListener('orientationchange', scheduleRestore);
    visualViewport?.addEventListener('resize', scheduleRestore);
    visualViewport?.addEventListener('scroll', continueActiveRelayout);
    return () => {
      window.removeEventListener(APP_VIEWPORT_WILL_CHANGE_EVENT, captureBeforeRelayout);
      window.removeEventListener('resize', scheduleRestore);
      window.removeEventListener('orientationchange', scheduleRestore);
      visualViewport?.removeEventListener('resize', scheduleRestore);
      visualViewport?.removeEventListener('scroll', continueActiveRelayout);
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      window.cancelAnimationFrame(firstFrameRef.current);
      window.cancelAnimationFrame(secondFrameRef.current);
    };
  }, [captureStableAnchor, containerRef, scheduleRestore]);

  const handleRelayoutScroll = useCallback(() =>
    relayoutActiveRef.current, []);

  return {
    captureStableAnchor,
    handleRelayoutScroll,
  };
}
```

`visualViewport.scroll` extends an already active orientation restoration but
does not initiate one, so intentional pinch-zoom panning is not treated as a
chat relayout.

- [ ] **Step 4: Wire the hook into `ChatPageClient`**

Import:

```ts
import { useChatOrientationScrollStability } from './runtime/useChatOrientationScrollStability';
```

After `showScrollToBottom` state is declared, initialize:

```ts
  const orientationScroll = useChatOrientationScrollStability({
    containerRef: chatContainerRef,
    shouldStickToBottomRef,
    lastScrollTopRef: lastChatScrollTopRef,
    setShowScrollToBottom,
  });
```

Update `updateChatStickiness`:

```ts
  function updateChatStickiness(container: HTMLElement) {
    if (orientationScroll.handleRelayoutScroll()) return;
    const previous = lastChatScrollTopRef.current;
    const distance =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distance <= 4;
    const movedUp = container.scrollTop < previous - 1;
    shouldStickToBottomRef.current = nearBottom
      || (shouldStickToBottomRef.current && !movedUp);
    setShowScrollToBottom(!nearBottom);
    lastChatScrollTopRef.current = container.scrollTop;
    orientationScroll.captureStableAnchor(container);
  }
```

Do not move viewport sizing into this hook. Keep the existing message effect,
chat-switch restoration, Files restoration, `scrollToLatest`, and send behavior
unchanged.

- [ ] **Step 5: Run the targeted Android tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  -g "pinned through portrait|historical message position"
```

Expected: 2 tests pass. Bottom distance is at most four pixels and the
historical anchor delta is at most four pixels.

- [ ] **Step 6: Run the targeted iPhone tests**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "pinned through portrait|historical message position"
```

Expected: 2 tests pass using the deterministic relayout lifecycle.

- [ ] **Step 7: Run existing scroll behavior coverage**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/test-ui.spec.ts \
  --project=desktop-chromium \
  -g "should not force-scroll to bottom after user scrolls up during streaming"
```

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/test-filter-scroll-history.spec.ts \
  --project=desktop-chromium \
  -g "should scroll to bottom when switching between chats"
```

Expected: both existing tests pass.

- [ ] **Step 8: Commit the implementation**

```bash
git add \
  app/features/chat/runtime/useChatOrientationScrollStability.ts \
  app/features/layout/viewportEvents.ts \
  app/features/layout/components/ChatShell.tsx \
  app/features/chat/ChatPageClient.tsx
git commit -m "fix: preserve chat position on orientation change" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Full Mobile Validation and Production Deployment

**Files:**
- Verify: `app/features/chat/runtime/useChatOrientationScrollStability.ts`
- Verify: `app/features/chat/ChatPageClient.tsx`
- Verify: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Run TypeScript and diff validation**

```bash
npx tsc --noEmit
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete Android responsive suite**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts \
  --project=android-chromium
```

Expected: all Android tests pass.

- [ ] **Step 3: Run the complete iPhone responsive suite**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts tests/mobile-composer-viewport.spec.ts \
  --project=iphone-webkit
```

Expected: all iPhone tests pass. If a test fails before login completes, rerun
that exact test once to distinguish fixture startup timing from a product
failure.

- [ ] **Step 4: Restore the generated Next.js type reference**

If development changes `next-env.d.ts` to:

```ts
import "./.next/dev/types/routes.d.ts";
```

restore it to:

```ts
import "./.next/types/routes.d.ts";
```

Do not commit the generated change.

- [ ] **Step 5: Stop the temporary development server**

Stop the specific 3011 process started in Task 1. Do not use `pkill` or
`killall`.

- [ ] **Step 6: Stop production before rebuilding `.next`**

Ask the user to run:

```bash
sudo systemctl stop agents-chat.service
```

Verify:

```bash
systemctl is-active agents-chat.service
```

Expected: `inactive`.

- [ ] **Step 7: Build production**

```bash
npm run build
```

Expected: Next.js production build and TypeScript checks succeed. Existing NFT
trace and middleware deprecation warnings may remain, but no errors are
allowed.

- [ ] **Step 8: Restart and verify production**

Ask the user to run:

```bash
sudo systemctl start agents-chat.service
```

Verify:

```bash
systemctl is-active agents-chat.service
systemctl show agents-chat.service --property=MainPID,User --no-pager
curl --silent --show-error --output /dev/null \
  --write-out 'HTTP %{http_code}\n' http://localhost:3010/login
```

Expected:

```text
active
User=xujx
HTTP 200
```

- [ ] **Step 9: Verify the final worktree**

```bash
git status --short
git log -6 --oneline
```

Expected: no tracked changes remain. The pre-existing untracked
`.agents-chat-storage.json` remains uncommitted.
