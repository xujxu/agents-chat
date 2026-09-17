# iOS CSS-Owned Mobile Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile root's visual-viewport-driven geometry with a CSS-owned viewport shell so iOS orientation changes preserve page scale, Chat position, keyboard usability, and desktop behavior.

**Architecture:** The browser owns viewport geometry, the mobile `.page` shell uses `100vh`/`100dvh`, and the Chat scroll container owns message anchoring through `ResizeObserver`. A focused hook preserves the current desktop viewport synchronization while explicitly clearing its inline variables in mobile layout. `visualViewport` remains available only to local overlays.

**Tech Stack:** Next.js 16 App Router, React 19, strict TypeScript, CSS media queries and dynamic viewport units, Playwright E2E.

---

## File Structure

**Create**

- `app/features/layout/hooks/useDesktopViewportSync.ts` — owns the existing desktop-only viewport CSS-variable synchronization and mobile cleanup boundary.
- `tests/desktop-viewport-shell.spec.ts` — focused regression coverage for desktop geometry and desktop/mobile branch transitions.

**Modify**

- `app/layout.tsx` — restore zoom-enabled viewport metadata and add safe-area viewport coverage.
- `app/globals.css` — establish non-scrolling document-root and shared safe-area tokens.
- `app/features/layout/components/ChatShell.tsx` — delegate viewport synchronization to the focused desktop hook.
- `app/features/layout/components/ChatShell.css` — make the mobile browser shell CSS-owned and remove visual viewport variables from mobile overlays.
- `app/features/agents/components/AgentsPanel.css` — size the mobile Agents sheet from CSS viewport geometry and safe-area tokens.
- `app/features/files/components/FileWorkspacePanel.css` — consume the shared bottom safe-area token.
- `app/features/chat/runtime/useChatOrientationScrollStability.ts` — observe transcript dimensions and stop using visual viewport events as the resize authority.
- `app/features/chat/ChatPageClient.tsx` — attach the transcript observer through a stable callback ref.
- `tests/mobile-composer-viewport.spec.ts` — separate visual-viewport isolation from layout-viewport keyboard behavior.
- `tests/mobile-responsive.spec.ts` — update viewport policy and orientation/anchor expectations.

**No new production dependency is required.**

## Test Environment

Run the source server in an attached background shell before Playwright:

```bash
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=admin123 \
NEXTAUTH_URL=http://localhost:3011 \
npx next dev --port 3011
```

Run focused Playwright commands with:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-composer-viewport.spec.ts \
  --project=iphone-webkit
```

After stopping the source server, restore `next-env.d.ts` if Next development
mode changed its generated types path:

```bash
git diff -- next-env.d.ts
```

If it changed only from `.next/types/routes.d.ts` to
`.next/dev/types/routes.d.ts`, restore the tracked form before committing.

### Task 1: Restore the Standards-Based Viewport Contract

**Files:**
- Modify: `tests/mobile-responsive.spec.ts:245-404`
- Modify: `app/layout.tsx:43-48`
- Modify: `app/globals.css:1-38`

- [ ] **Step 1: Change the mobile policy test to require the new viewport contract**

Rename the test to `uses a zoom-enabled viewport and stable authored typography`.
Replace the initial viewport assertions with:

```ts
const viewport = page.locator('meta[name="viewport"]');
const viewportContent = await viewport.getAttribute('content');
if (!viewportContent) throw new Error('Viewport content not found');
expect(viewportContent).toMatch(/width=device-width/i);
expect(viewportContent).toMatch(/initial-scale=1(?:\\.0)?/i);
expect(viewportContent).toMatch(/viewport-fit=cover/i);
expect(viewportContent).toMatch(/interactive-widget=resizes-content/i);
expect(viewportContent).not.toMatch(/maximum-scale/i);
expect(viewportContent).not.toMatch(/user-scalable/i);
```

Keep the existing mutation observer, typography measurements, repeated
orientation loop, draft assertion, and assertion that the viewport content is
unchanged after rotation. Remove the `browserName` test argument and always
call `page.setViewportSize(viewport)` inside the orientation loop; the new
contract tests real layout viewport changes on WebKit rather than substituting
mocked visual viewport height for root geometry.

- [ ] **Step 2: Run the focused policy test and verify it fails**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "uses a zoom-enabled viewport and stable authored typography"
```

Expected: FAIL because the generated viewport still contains
`maximum-scale=1` and does not contain `viewport-fit=cover`.

- [ ] **Step 3: Update Next.js viewport metadata**

Change the export in `app/layout.tsx` to:

```ts
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};
```

- [ ] **Step 4: Establish the document-root and safe-area policy**

Add the safe-area variables to `:root` in `app/globals.css`:

```css
:root {
  color-scheme: dark;
  --bg: #0a0e1a;
  --text: #e7edf8;
  --safe-area-top: env(safe-area-inset-top, 0px);
  --safe-area-right: env(safe-area-inset-right, 0px);
  --safe-area-bottom: env(safe-area-inset-bottom, 0px);
  --safe-area-left: env(safe-area-inset-left, 0px);
}
```

Replace the root overflow rule with:

```css
html,
body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  height: 100%;
  overflow: clip;
  overscroll-behavior: none;
  background: radial-gradient(circle at top, rgba(255, 255, 255, 0.05), transparent 28%), var(--bg);
  color: var(--text);
  font-family: 'Segoe UI Variable Text', 'Segoe UI', 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
}
```

Do not change the existing `text-size-adjust: 100%` declarations.

- [ ] **Step 5: Run the focused policy test and verify it passes**

Run the Step 2 command again.

Expected: 1 passed.

- [ ] **Step 6: Commit the viewport contract**

```bash
git add app/layout.tsx app/globals.css tests/mobile-responsive.spec.ts
git commit -m "fix: restore zoom-enabled mobile viewport" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Stop Visual Viewport Events From Owning the Mobile Root

**Files:**
- Create: `app/features/layout/hooks/useDesktopViewportSync.ts`
- Modify: `app/features/layout/components/ChatShell.tsx:1-76`
- Modify: `app/features/layout/components/ChatShell.css:1-10,1245-1334`
- Modify: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Add a failing mobile root-ownership assertion**

Add `keeps the mobile root independent from visual viewport events` to
`tests/mobile-responsive.spec.ts`. The shared fixture already installs the
mock visual viewport and loads a Chat. Capture the page's layout-owned
geometry and inline variables:

```ts
test('keeps the mobile root independent from visual viewport events', async ({ page }) => {
  const app = page.locator('.chatPageRoot .page');
  const initialRoot = await app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = (element as HTMLElement).style;
    return {
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      position: getComputedStyle(element).position,
      inlineHeight: style.getPropertyValue('--app-viewport-height'),
      inlineTop: style.getPropertyValue('--app-viewport-offset-top'),
    };
  });

  await setTestVisualViewport(page, 430, 24);

  await expect.poll(() => app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = (element as HTMLElement).style;
    return {
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      position: getComputedStyle(element).position,
      inlineHeight: style.getPropertyValue('--app-viewport-height'),
      inlineTop: style.getPropertyValue('--app-viewport-offset-top'),
    };
  })).toEqual(initialRoot);
  expect(initialRoot.position).not.toBe('fixed');
  expect(initialRoot.inlineHeight).toBe('');
  expect(initialRoot.inlineTop).toBe('');
});
```

- [ ] **Step 2: Run the root-ownership test and verify it fails**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "keeps the mobile root independent from visual viewport events"
```

Expected: FAIL because `ChatShell` writes the visual viewport height/top and
mobile `.page` is fixed.

- [ ] **Step 3: Extract desktop-only viewport synchronization**

Create `app/features/layout/hooks/useDesktopViewportSync.ts`:

```ts
'use client';

import { useEffect, type RefObject } from 'react';
import { APP_VIEWPORT_WILL_CHANGE_EVENT } from '../viewportEvents';

type UseDesktopViewportSyncOptions = {
  pageRef: RefObject<HTMLElement | null>;
  isMobileLayout: boolean;
};

export function useDesktopViewportSync({
  pageRef,
  isMobileLayout,
}: UseDesktopViewportSyncOptions) {
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;

    const clearViewportProperties = () => {
      page.style.removeProperty('--app-viewport-height');
      page.style.removeProperty('--app-viewport-offset-top');
    };

    if (isMobileLayout) {
      clearViewportProperties();
      return clearViewportProperties;
    }

    const visualViewport = window.visualViewport;
    const syncViewport = () => {
      const height = visualViewport?.height ?? window.innerHeight;
      const offsetTop = visualViewport?.offsetTop ?? 0;
      window.dispatchEvent(new Event(APP_VIEWPORT_WILL_CHANGE_EVENT));
      page.style.setProperty('--app-viewport-height', `${Math.round(height)}px`);
      page.style.setProperty('--app-viewport-offset-top', `${Math.round(offsetTop)}px`);
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    visualViewport?.addEventListener('resize', syncViewport);
    visualViewport?.addEventListener('scroll', syncViewport);
    return () => {
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      visualViewport?.removeEventListener('resize', syncViewport);
      visualViewport?.removeEventListener('scroll', syncViewport);
    };
  }, [isMobileLayout, pageRef]);
}
```

This intentionally preserves the old desktop behavior. Do not generalize it
into a mobile viewport hook.

- [ ] **Step 4: Delegate the effect from ChatShell**

In `app/features/layout/components/ChatShell.tsx`:

- retain `useEffect` for overlay focus;
- remove the `APP_VIEWPORT_WILL_CHANGE_EVENT` import;
- import `useDesktopViewportSync`; and
- replace the first `useEffect` with:

```ts
useDesktopViewportSync({ pageRef, isMobileLayout });
```

- [ ] **Step 5: Give the mobile page a CSS-owned shell**

Change the base fallback in `ChatShell.css`:

```css
.chatPageRoot .page {
  position: relative;
  height: var(--app-viewport-height, 100vh);
  min-height: var(--app-viewport-height, 100vh);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg-accent);
  color: var(--text);
  transition: background 220ms ease, color 220ms ease;
}

@supports (height: 100dvh) {
  .chatPageRoot .page {
    height: var(--app-viewport-height, 100dvh);
    min-height: var(--app-viewport-height, 100dvh);
  }
}
```

Replace the mobile `.page` fixed geometry with:

```css
@media (max-width: 900px) {
  .chatPageRoot .page {
    --mobile-header-height: 68px;
    position: relative;
    top: auto;
    right: auto;
    left: auto;
    width: 100%;
    height: 100vh;
    min-height: 100vh;
  }

  @supports (height: 100dvh) {
    .chatPageRoot .page {
      height: 100dvh;
      min-height: 100dvh;
    }
  }
}
```

- [ ] **Step 6: Run the root-ownership test and verify it passes**

Run the Step 2 command again.

Expected: 1 passed.

- [ ] **Step 7: Commit the shell ownership boundary**

```bash
git add \
  app/features/layout/hooks/useDesktopViewportSync.ts \
  app/features/layout/components/ChatShell.tsx \
  app/features/layout/components/ChatShell.css \
  tests/mobile-responsive.spec.ts
git commit -m "fix: make mobile viewport shell CSS-owned" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Move Mobile Overlays and Keyboard Coverage Onto the CSS Shell

**Files:**
- Modify: `app/features/layout/components/ChatShell.css:1301-1389`
- Modify: `app/features/agents/components/AgentsPanel.css:305-321`
- Modify: `app/features/files/components/FileWorkspacePanel.css:160-168`
- Modify: `tests/mobile-composer-viewport.spec.ts`
- Modify: `tests/mobile-responsive.spec.ts:170-245`

- [ ] **Step 1: Split visual viewport isolation from keyboard/layout resize**

Rename the existing test in `tests/mobile-composer-viewport.spec.ts` to
`keeps composer controls and overlays inside a reduced layout viewport`.

After creating the Chat and filling the textarea, shrink the real Playwright
layout viewport rather than only the visual viewport:

```ts
await page.setViewportSize({ width: 430, height: 430 });
await setTestVisualViewport(page, 430, 0);

const app = page.locator('.chatPageRoot .page');
await expect.poll(() => app.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { top: Math.round(rect.top), height: Math.round(rect.height) };
})).toEqual({ top: 0, height: 430 });
```

Retain the existing assertions for:

- Send, Stop, and model controls;
- horizontal target-pill scrolling;
- model listbox visibility;
- navigation drawer and backdrop bounds; and
- returning to the original layout height.

For each Composer control and overlay, compare against `window.innerHeight`
or the `.page` bounding box, not a visual-viewport-sized root.

Before opening overlays, inject nonzero safe-area tokens so the test verifies
that each owner consumes them rather than bypassing the shared policy:

```ts
await page.evaluate(() => {
  const root = document.documentElement.style;
  root.setProperty('--safe-area-top', '17px');
  root.setProperty('--safe-area-right', '11px');
  root.setProperty('--safe-area-bottom', '13px');
  root.setProperty('--safe-area-left', '7px');
});
```

After opening navigation, assert its computed padding includes the mobile
header and left safe area:

```ts
await expect.poll(() => page.locator('.participantsSidebar').evaluate((element) => {
  const style = getComputedStyle(element);
  return {
    paddingTop: style.paddingTop,
    paddingLeft: style.paddingLeft,
  };
})).toEqual({
  paddingTop: '69px',
  paddingLeft: '19px',
});
```

Add main Agents-panel and nested settings-sheet checks:

```ts
await page.getByRole('button', { name: 'More actions' }).click();
await page.getByRole('menuitem', { name: 'Agents' }).click();
const agentsPanel = page.locator('.agentsSidebar.mobilePanelVisible');
await expect(agentsPanel).toBeVisible();
await expect.poll(() => agentsPanel.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return {
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
  };
})).toEqual({ top: 0, bottom: 430 });

await agentsPanel.getByText('Alpha Agent', { exact: true }).click();
const agentsSheet = page.getByRole('dialog', { name: /Alpha Agent settings/ });
await expect(agentsSheet).toBeVisible();
await expect.poll(() => agentsSheet.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    paddingTop: style.paddingTop,
    paddingRight: style.paddingRight,
    paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft,
  };
})).toEqual({
  top: 0,
  bottom: 430,
  paddingTop: '31px',
  paddingRight: '25px',
  paddingBottom: '27px',
  paddingLeft: '21px',
});
```

- [ ] **Step 2: Run the reduced-layout test and verify it fails**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-composer-viewport.spec.ts \
  --project=iphone-webkit \
  -g "keeps composer controls and overlays inside a reduced layout viewport"
```

Expected: FAIL because the existing rules read `env(safe-area-inset-*)`
directly and ignore the injected shared safe-area tokens.

- [ ] **Step 3: Remove root viewport variables from mobile overlays**

In the mobile block of `ChatShell.css`, use:

```css
.chatPageRoot .mobilePanelBackdrop {
  display: block;
  position: fixed;
  inset: 0;
  height: auto;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(3px);
  z-index: 21;
}

.chatPageRoot .page .participantsSidebar,
.chatPageRoot .page .agentsSidebar {
  display: block;
  position: fixed;
  top: 0;
  bottom: 0;
  height: auto;
  box-sizing: border-box;
  padding-top: calc(var(--mobile-header-height) + var(--safe-area-top));
  padding-bottom: var(--safe-area-bottom);
  padding-left: calc(12px + var(--safe-area-left));
  padding-right: calc(12px + var(--safe-area-right));
  z-index: 22;
  box-shadow: var(--shadow);
  transition: transform 180ms ease;
}
```

Replace the remaining safe-area expressions in the same block:

```css
max-width: calc(100vw - 20px - var(--safe-area-left) - var(--safe-area-right));
padding: 6px 12px calc(6px + var(--safe-area-bottom));
```

- [ ] **Step 4: Make the mobile header safe-area-aware**

In the `max-width: 900px` block, update the header:

```css
.chatPageRoot .header {
  z-index: 23;
  padding:
    calc(14px + var(--safe-area-top))
    calc(16px + var(--safe-area-right))
    14px
    calc(16px + var(--safe-area-left));
}
```

In the `max-width: 560px` block, replace the compact header padding with:

```css
.chatPageRoot .header {
  flex-wrap: nowrap;
  gap: 8px;
  padding:
    calc(6px + var(--safe-area-top))
    calc(10px + var(--safe-area-right))
    6px
    calc(10px + var(--safe-area-left));
  min-height: calc(52px + var(--safe-area-top));
}
```

- [ ] **Step 5: Update Agents and Files mobile safe-area consumers**

Replace the Agents sheet geometry in `AgentsPanel.css` with:

```css
.chatPageRoot .agentMobileSheet {
  position: fixed;
  inset: 0;
  width: 100%;
  height: auto;
  max-height: none;
  border-radius: 0;
  padding:
    calc(14px + var(--safe-area-top))
    calc(14px + var(--safe-area-right))
    calc(14px + var(--safe-area-bottom))
    calc(14px + var(--safe-area-left));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

In `FileWorkspacePanel.css`, change the mobile viewer padding to:

```css
.mobileMarkdownViewer {
  padding: 16px 14px calc(24px + var(--safe-area-bottom));
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
```

- [ ] **Step 6: Run focused keyboard and mobile overlay tests**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-composer-viewport.spec.ts tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "mobile root|reduced layout viewport|navigation, composer, and overlays usable in landscape|only one mobile overlay"
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit overlay geometry**

```bash
git add \
  app/features/layout/components/ChatShell.css \
  app/features/agents/components/AgentsPanel.css \
  app/features/files/components/FileWorkspacePanel.css \
  tests/mobile-composer-viewport.spec.ts \
  tests/mobile-responsive.spec.ts
git commit -m "fix: anchor mobile overlays to CSS viewport" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Make Transcript Size the Message-Anchor Authority

**Files:**
- Modify: `app/features/chat/runtime/useChatOrientationScrollStability.ts`
- Modify: `app/features/chat/ChatPageClient.tsx:70-90,245-258,347-351`
- Modify: `tests/mobile-responsive.spec.ts:40-77,406-458`

- [ ] **Step 1: Add a failing assertion that the transcript is observed**

Before `loginMobileFixture(page)` in the existing `beforeEach`, install a
test-only wrapper around the native observer:

```ts
await page.addInitScript(() => {
  const NativeResizeObserver = window.ResizeObserver;
  const testWindow = window as Window & {
    __chatContainerResizeObserved?: boolean;
  };
  window.ResizeObserver = class extends NativeResizeObserver {
    observe(target: Element, options?: ResizeObserverOptions) {
      if (target.classList.contains('chatContainer')) {
        testWindow.__chatContainerResizeObserved = true;
      }
      super.observe(target, options);
    }
  };
});
```

Add:

```ts
test('observes transcript geometry as the scroll anchor authority', async ({ page }) => {
  await expect.poll(() => page.evaluate(() =>
    (window as Window & {
      __chatContainerResizeObserved?: boolean;
    }).__chatContainerResizeObserved ?? false
  )).toBe(true);
});
```

- [ ] **Step 2: Run the observer test and verify it fails**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "observes transcript geometry"
```

Expected: FAIL because no production `ResizeObserver` observes
`.chatContainer`.

- [ ] **Step 3: Update anchor tests to resize the layout viewport**

Replace `triggerViewportRelayoutWithScrollDrift` with:

```ts
async function triggerLayoutRelayoutWithScrollDrift(
  page: import('@playwright/test').Page,
  nextViewport: { width: number; height: number },
  scrollDrift: number,
) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('orientationchange'));
  });
  await page.setViewportSize(nextViewport);
  await page.evaluate(({ drift }) => {
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

Update both anchor tests to call:

```ts
await triggerLayoutRelayoutWithScrollDrift(
  page,
  { width: 430, height: 760 },
  -180,
);
```

and:

```ts
await triggerLayoutRelayoutWithScrollDrift(
  page,
  { width: 430, height: 760 },
  140,
);
```

Before each call, first set a different real layout height:

```ts
await page.setViewportSize({ width: 430, height: 820 });
```

This guarantees that the transcript `ResizeObserver` receives a real size
change.

- [ ] **Step 4: Add transcript attachment and ResizeObserver ownership**

In `useChatOrientationScrollStability.ts`:

- change `containerRef` to `MutableRefObject<HTMLElement | null>`;
- add `resizeObserverRef` and `observedContainerRef`;
- remove the `visualViewport.resize` and `visualViewport.scroll` listeners;
- retain `APP_VIEWPORT_WILL_CHANGE_EVENT`, `window.resize`, and
  `orientationchange` as transition grouping/fallback signals; and
- return a stable callback that attaches the actual transcript element.

Add these refs:

```ts
const resizeObserverRef = useRef<ResizeObserver | null>(null);
const observedContainerRef = useRef<HTMLElement | null>(null);
```

Add this callback after `scheduleRestore`:

```ts
const observeContainer = useCallback((container: HTMLElement | null) => {
  resizeObserverRef.current?.disconnect();
  resizeObserverRef.current = null;
  observedContainerRef.current = container;
  containerRef.current = container;
  if (!container) return;

  captureStableAnchor(container);
  if (typeof ResizeObserver === 'undefined') return;

  const observer = new ResizeObserver(() => {
    if (observedContainerRef.current === container) scheduleRestore();
  });
  observer.observe(container);
  resizeObserverRef.current = observer;
}, [captureStableAnchor, containerRef, scheduleRestore]);
```

The effect cleanup must include:

```ts
resizeObserverRef.current?.disconnect();
resizeObserverRef.current = null;
observedContainerRef.current = null;
```

Return:

```ts
return {
  captureStableAnchor,
  handleRelayoutScroll,
  observeContainer,
};
```

Do not make the observer callback write shell styles or inspect
`visualViewport`.

- [ ] **Step 5: Attach the transcript through a stable callback ref**

In `ChatPageClient.tsx`, after creating `orientationScroll`, add:

```ts
const setChatContainer = useCallback((element: HTMLElement | null) => {
  orientationScroll.observeContainer(element);
}, [orientationScroll.observeContainer]);
```

Change the message section from:

```tsx
<section className="chatContainer" ref={chatContainerRef}
```

to:

```tsx
<section className="chatContainer" ref={setChatContainer}
```

The hook writes the same `chatContainerRef`, so existing Chat selection,
stickiness, saved-position, focus, and send logic continue using the current
element.

- [ ] **Step 6: Run the observer and anchor tests repeatedly**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "observes transcript geometry|latest message pinned|same historical message position" \
  --repeat-each=6
```

Expected: 18 passed, with the bottom test hiding the jump button and the
history test preserving both message identity and zero-pixel anchor delta.

- [ ] **Step 7: Commit transcript-owned resize stability**

```bash
git add \
  app/features/chat/runtime/useChatOrientationScrollStability.ts \
  app/features/chat/ChatPageClient.tsx \
  tests/mobile-responsive.spec.ts
git commit -m "fix: anchor chat scroll to transcript resize" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Prove Desktop Isolation and Responsive Branch Handoffs

**Files:**
- Create: `tests/desktop-viewport-shell.spec.ts`

The current Playwright configuration already limits mobile projects to
`mobile-responsive.spec.ts` and `mobile-composer-viewport.spec.ts`, so the new
file is collected by `desktop-chromium` only.

- [ ] **Step 1: Write a desktop geometry and branch-handoff test**

Create `tests/desktop-viewport-shell.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import {
  installMobileChatFixture,
  loginMobileFixture,
} from './helpers/mobileChatFixture';

test.beforeEach(async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
});

test('keeps desktop geometry while clearing viewport overrides in mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });

  const app = page.locator('.chatPageRoot .page');
  const sidebar = page.locator('.participantsSidebar');
  const desktopGeometry = await app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      inlineHeight: (element as HTMLElement).style.getPropertyValue('--app-viewport-height'),
    };
  });
  expect(desktopGeometry).toEqual({
    top: 0,
    height: 720,
    inlineHeight: '720px',
  });
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.sidebarResizeHandle')).toBeVisible();

  const expandedSidebarWidth = await sidebar.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)
  );
  expect(expandedSidebarWidth).toBeGreaterThanOrEqual(260);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect.poll(() => sidebar.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)
  )).toBeLessThanOrEqual(60);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect.poll(() => sidebar.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)
  )).toBeGreaterThanOrEqual(260);

  await page.locator('button[title="Agents"]').click();
  const desktopAgents = page.locator('.agentsSidebar');
  await expect(desktopAgents).toBeVisible();
  const agentsBox = await desktopAgents.boundingBox();
  expect(agentsBox).not.toBeNull();
  expect(agentsBox!.x).toBeGreaterThan(900);

  await page.setViewportSize({ width: 880, height: 700 });
  await expect.poll(() => app.evaluate((element) => ({
    position: getComputedStyle(element).position,
    inlineHeight: (element as HTMLElement).style.getPropertyValue('--app-viewport-height'),
    inlineTop: (element as HTMLElement).style.getPropertyValue('--app-viewport-offset-top'),
  }))).toEqual({
    position: 'relative',
    inlineHeight: '',
    inlineTop: '',
  });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 680 });
  await expect.poll(() => app.evaluate((element) => ({
    height: Math.round(element.getBoundingClientRect().height),
    inlineHeight: (element as HTMLElement).style.getPropertyValue('--app-viewport-height'),
  }))).toEqual({
    height: 680,
    inlineHeight: '680px',
  });
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.sidebarResizeHandle')).toBeVisible();
});
```

- [ ] **Step 2: Run the desktop test**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/desktop-viewport-shell.spec.ts \
  --project=desktop-chromium
```

Expected: 1 passed. If the test exposes asynchronous matchMedia handoff, wait
with `expect.poll`; do not add arbitrary production delays.

- [ ] **Step 3: Run the existing desktop sidebar regression**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/test-ui.spec.ts \
  --project=desktop-chromium \
  -g "chat actions usable after sidebar resize"
```

Expected: 1 passed.

- [ ] **Step 4: Commit desktop isolation coverage**

```bash
git add tests/desktop-viewport-shell.spec.ts
git commit -m "test: protect desktop viewport layout" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 6: Run Cross-Platform Regression and Production Validation

**Files:**
- Modify only if a validation failure identifies a defect directly caused by this implementation.

- [ ] **Step 1: Verify no mobile root consumer remains**

Run:

```bash
rg -n --glob '*.{ts,tsx,css}' \
  'app-viewport-(height|offset-top)|visualViewport' \
  app/features app/globals.css
```

Expected:

- `--app-viewport-*` appears only in the base desktop fallback and
  `useDesktopViewportSync.ts`;
- no mobile media-query rule consumes those variables; and
- remaining `visualViewport` uses are the desktop sync, Chat transition
  fallback if explicitly retained, or local overlay positioning.

- [ ] **Step 2: Run focused viewport coverage on all relevant projects**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  tests/mobile-composer-viewport.spec.ts tests/mobile-responsive.spec.ts \
  --project=android-chromium --project=iphone-webkit \
  -g "viewport|typography|landscape|latest message pinned|same historical message position"
```

Expected: all selected tests pass.

- [ ] **Step 3: Run the complete Android mobile suite**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  --project=android-chromium
```

Expected: all Android mobile tests pass.

- [ ] **Step 4: Run the complete iPhone WebKit suite**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
npx playwright test --config tests/playwright.config.ts \
  --project=iphone-webkit
```

Expected: all iPhone WebKit mobile tests pass.

- [ ] **Step 5: Run strict TypeScript**

Run:

```bash
npx tsc --noEmit
```

Expected: exit code 0 with no diagnostics.

- [ ] **Step 6: Build production safely**

Before building, stop the production service so Next.js does not race over the
same `.next` output:

```bash
sudo systemctl stop agents-chat.service
npm run build
sudo systemctl start agents-chat.service
systemctl is-active agents-chat.service
curl -k -sS -o /dev/null -w '%{http_code}\n' https://localhost:3010/login
```

Expected:

- build exits successfully;
- service status is `active`; and
- `/login` returns HTTP 200.

- [ ] **Step 7: Perform physical-device acceptance**

On the same iPhone, test Safari and iOS Chrome:

1. Open a Chat at the latest message.
2. Rotate portrait to landscape and back; wait at least three seconds after
   each transition.
3. Confirm the application and Markdown never become enlarged.
4. Confirm Chrome does not retain an approximately 2x portrait scale.
5. Confirm the latest message remains visible.
6. Repeat from a historical reading position and confirm the same message
   remains anchored.
7. Confirm pinch zoom works after rotation.
8. Open and dismiss the keyboard; confirm Composer visibility and message
   anchoring.
9. Open Chats/Files navigation, Agents, and the model menu in both
   orientations; confirm bounds and safe areas.

Expected: all checks pass in both browsers. Do not add another viewport meta
or root scaling workaround if a check fails; preserve the evidence and return
to the document-scroll fallback design.

- [ ] **Step 8: Commit only validation-driven corrections**

If Steps 1-7 required a directly related correction:

```bash
git add \
  app/layout.tsx \
  app/globals.css \
  app/features/layout/hooks/useDesktopViewportSync.ts \
  app/features/layout/components/ChatShell.tsx \
  app/features/layout/components/ChatShell.css \
  app/features/agents/components/AgentsPanel.css \
  app/features/files/components/FileWorkspacePanel.css \
  app/features/chat/runtime/useChatOrientationScrollStability.ts \
  app/features/chat/ChatPageClient.tsx \
  tests/mobile-composer-viewport.spec.ts \
  tests/mobile-responsive.spec.ts \
  tests/desktop-viewport-shell.spec.ts
git commit -m "fix: complete mobile viewport stabilization" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no correction was required, do not create an empty commit.
