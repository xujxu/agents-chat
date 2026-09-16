# iOS Viewport Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Temporarily deploy privacy-safe viewport telemetry on port 3010, collect Safari and iOS Chrome rotation evidence, then remove all telemetry and restore a debug-free production build.

**Architecture:** Add an uncommitted query-gated client component that passively samples viewport, overflow, and computed typography through the full three-second orientation settling window. Use a temporary uncommitted Playwright test to verify activation and report shape. After physical-device reports are captured, remove the component, test, import, mount, and styles before rebuilding production.

**Tech Stack:** Next.js 16 App Router, React 19, strict TypeScript, CSS, Visual Viewport API, Playwright.

---

## File Structure

All source and test files in this table are temporary and must remain
uncommitted:

| File | Responsibility |
|------|----------------|
| `app/features/layout/components/ViewportDiagnostics.tsx` | Query-gated recorder, metric snapshots, classification, copy/fallback UI, and cleanup. |
| `app/features/layout/components/ViewportDiagnostics.css` | Fixed diagnostic panel styling. |
| `app/features/chat/ChatPageClient.tsx` | Temporary import and mount only. |
| `tests/viewport-diagnostics.temp.spec.ts` | Temporary activation and sampling coverage. |

The only committed artifact from this investigation is this implementation
plan and its approved design document.

### Task 1: Build the temporary recorder

**Files:**
- Create temporarily: `app/features/layout/components/ViewportDiagnostics.tsx`
- Create temporarily: `app/features/layout/components/ViewportDiagnostics.css`
- Modify temporarily: `app/features/chat/ChatPageClient.tsx`
- Create temporarily: `tests/viewport-diagnostics.temp.spec.ts`

- [ ] **Step 1: Add a failing query-gate test**

Create `tests/viewport-diagnostics.temp.spec.ts`:

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

test('only enables viewport diagnostics through the explicit query flag', async ({ page }) => {
  await expect(page.getByRole('region', { name: 'Viewport diagnostics' })).toHaveCount(0);

  await page.goto('/?viewportDebug=1');

  await expect(page.getByRole('region', { name: 'Viewport diagnostics' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start viewport recording' })).toBeVisible();
});

test('records immediate and delayed viewport samples without Chat content', async ({ page }) => {
  await page.goto('/?viewportDebug=1');
  await page.getByRole('button', { name: 'Start viewport recording' }).click();

  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await page.waitForTimeout(3_200);
  await page.getByRole('button', { name: 'Stop viewport recording' }).click();

  const report = await page.getByLabel('Viewport diagnostic report').inputValue();
  expect(report).toContain('"reason": "baseline"');
  expect(report).toContain('"reason": "orientationchange"');
  expect(report).toContain('"reason": "settle-3000ms"');
  expect(report).toContain('"visualViewport"');
  expect(report).toContain('"markdown"');
  expect(report).not.toContain('Existing mobile message');
  expect(report).not.toContain('mobile-chat');
});
```

- [ ] **Step 2: Run the temporary test and verify it fails**

Start a dev server on 3011:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
NEXTAUTH_URL=http://localhost:3011 NEXT_PUBLIC_E2E_TESTS=1 \
npm run dev -- --port 3011
```

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
tests/viewport-diagnostics.temp.spec.ts --project=desktop-chromium
```

Expected: both tests fail because the diagnostic region does not exist.

- [ ] **Step 3: Create the complete temporary recorder**

Create `app/features/layout/components/ViewportDiagnostics.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './ViewportDiagnostics.css';

type ElementMetric = {
  available: boolean;
  fontSize?: string;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  width?: number;
  height?: number;
};

type ViewportSnapshot = {
  elapsedMs: number;
  reason: string;
  orientation: { type: string; angle: number | null };
  window: {
    innerWidth: number;
    innerHeight: number;
    scrollX: number;
    scrollY: number;
  };
  document: {
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
  };
  visualViewport: {
    available: boolean;
    width?: number;
    height?: number;
    offsetLeft?: number;
    offsetTop?: number;
    scale?: number;
  };
  activeElement: { tag: string; fontSize: string | null };
  markdown: ElementMetric;
  message: ElementMetric;
  header: ElementMetric;
  composer: ElementMetric;
  overflow: { pixels: number; element: string | null };
};

const SETTLE_DELAYS = [100, 500, 1_500, 3_000] as const;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function readElement(selector: string): ElementMetric {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return { available: false };
  const rect = element.getBoundingClientRect();
  return {
    available: true,
    fontSize: getComputedStyle(element).fontSize,
    left: round(rect.left),
    right: round(rect.right),
    top: round(rect.top),
    bottom: round(rect.bottom),
    width: round(rect.width),
    height: round(rect.height),
  };
}

function safeElementName(element: Element): string {
  const classes = typeof element.className === 'string'
    ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 4)
    : [];
  return [element.tagName.toLowerCase(), ...classes.map((name) => `.${name}`)].join('');
}

function readOverflow(): { pixels: number; element: string | null } {
  const rootWidth = document.documentElement.clientWidth;
  let maximum = 0;
  let source: Element | null = null;
  for (const element of Array.from(document.querySelectorAll('.chatPageRoot *'))) {
    const rect = element.getBoundingClientRect();
    const overflow = Math.max(0, -rect.left, rect.right - rootWidth);
    if (overflow > maximum) {
      maximum = overflow;
      source = element;
    }
  }
  return {
    pixels: round(maximum),
    element: source ? safeElementName(source) : null,
  };
}

function takeSnapshot(startedAt: number, reason: string): ViewportSnapshot {
  const root = document.documentElement;
  const active = document.activeElement;
  const activeElement = active instanceof HTMLElement
    ? { tag: active.tagName.toLowerCase(), fontSize: getComputedStyle(active).fontSize }
    : { tag: active?.nodeName?.toLowerCase() || 'none', fontSize: null };
  const viewport = window.visualViewport;
  return {
    elapsedMs: Math.round(performance.now() - startedAt),
    reason,
    orientation: {
      type: screen.orientation?.type || 'unavailable',
      angle: typeof screen.orientation?.angle === 'number' ? screen.orientation.angle : null,
    },
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: round(window.scrollX),
      scrollY: round(window.scrollY),
    },
    document: {
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
    },
    visualViewport: viewport ? {
      available: true,
      width: round(viewport.width),
      height: round(viewport.height),
      offsetLeft: round(viewport.offsetLeft),
      offsetTop: round(viewport.offsetTop),
      scale: round(viewport.scale),
    } : { available: false },
    activeElement,
    markdown: readElement('.messageContent.markdownBody'),
    message: readElement('.message'),
    header: readElement('.chatPageRoot .header h1'),
    composer: readElement('.composerTextarea'),
    overflow: readOverflow(),
  };
}

function classify(snapshots: ViewportSnapshot[]): string[] {
  if (snapshots.length < 2) return ['Insufficient samples'];
  const baseline = snapshots[0];
  const messages: string[] = [];
  const scales = snapshots
    .map((snapshot) => snapshot.visualViewport.scale)
    .filter((scale): scale is number => typeof scale === 'number');
  if (scales.some((scale) => Math.abs(scale - (scales[0] ?? scale)) > 0.01)) {
    messages.push('visualViewport.scale changed');
  }
  if (snapshots.some((snapshot) =>
    snapshot.markdown.fontSize !== baseline.markdown.fontSize)) {
    messages.push('Markdown computed font size changed');
  }
  if (snapshots.some((snapshot) =>
    snapshot.header.fontSize !== baseline.header.fontSize
    || snapshot.composer.fontSize !== baseline.composer.fontSize)) {
    messages.push('Framework computed font size changed');
  }
  if (snapshots.some((snapshot) =>
    snapshot.document.scrollWidth > snapshot.document.clientWidth
    || snapshot.overflow.pixels > 1)) {
    messages.push('Horizontal overflow detected');
  }
  if (messages.length === 0) messages.push('Measured values remained stable');
  return messages;
}

export function ViewportDiagnostics() {
  const [enabled, setEnabled] = useState(false);
  const [recording, setRecording] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [snapshots, setSnapshots] = useState<ViewportSnapshot[]>([]);
  const [copyStatus, setCopyStatus] = useState('');
  const startedAtRef = useRef(0);
  const recordingRef = useRef(false);
  const sequenceActiveRef = useRef(false);
  const framesRef = useRef<number[]>([]);
  const timersRef = useRef<number[]>([]);

  const clearScheduledSamples = useCallback(() => {
    for (const frame of framesRef.current) window.cancelAnimationFrame(frame);
    for (const timer of timersRef.current) window.clearTimeout(timer);
    framesRef.current = [];
    timersRef.current = [];
    sequenceActiveRef.current = false;
  }, []);

  const capture = useCallback((reason: string) => {
    if (!recordingRef.current) return;
    const snapshot = takeSnapshot(startedAtRef.current, reason);
    setSnapshots((current) => [...current, snapshot]);
  }, []);

  const scheduleSequence = useCallback((reason: string) => {
    capture(reason);
    if (sequenceActiveRef.current) return;
    sequenceActiveRef.current = true;
    const frame = window.requestAnimationFrame(() => capture('settle-animation-frame'));
    framesRef.current.push(frame);
    for (const delay of SETTLE_DELAYS) {
      timersRef.current.push(window.setTimeout(() => {
        capture(`settle-${delay}ms`);
        if (delay === 3_000) sequenceActiveRef.current = false;
      }, delay));
    }
  }, [capture]);

  useEffect(() => {
    setEnabled(new URLSearchParams(window.location.search).get('viewportDebug') === '1');
  }, []);

  useEffect(() => {
    if (!enabled || !recording) return;
    const viewport = window.visualViewport;
    const onOrientation = () => scheduleSequence('orientationchange');
    const onWindowResize = () => scheduleSequence('window-resize');
    const onViewportResize = () => scheduleSequence('visual-viewport-resize');
    const onViewportScroll = () => capture('visual-viewport-scroll');
    window.addEventListener('orientationchange', onOrientation);
    window.addEventListener('resize', onWindowResize);
    viewport?.addEventListener('resize', onViewportResize);
    viewport?.addEventListener('scroll', onViewportScroll);
    return () => {
      window.removeEventListener('orientationchange', onOrientation);
      window.removeEventListener('resize', onWindowResize);
      viewport?.removeEventListener('resize', onViewportResize);
      viewport?.removeEventListener('scroll', onViewportScroll);
      clearScheduledSamples();
    };
  }, [capture, clearScheduledSamples, enabled, recording, scheduleSequence]);

  const start = () => {
    clearScheduledSamples();
    startedAtRef.current = performance.now();
    recordingRef.current = true;
    setSnapshots([takeSnapshot(startedAtRef.current, 'baseline')]);
    setCopyStatus('');
    setRecording(true);
  };

  const stop = () => {
    recordingRef.current = false;
    clearScheduledSamples();
    setRecording(false);
  };

  const report = JSON.stringify({
    metadata: {
      userAgent: enabled ? navigator.userAgent : '',
      standalone: enabled ? window.matchMedia('(display-mode: standalone)').matches : false,
    },
    summary: classify(snapshots),
    snapshots,
  }, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Copy failed; select the report below');
    }
  };

  if (!enabled) return null;

  return (
    <section
      className={`viewportDiagnostics${collapsed ? ' isCollapsed' : ''}`}
      aria-label="Viewport diagnostics"
    >
      <header className="viewportDiagnosticsHeader">
        <strong>Viewport diagnostics</strong>
        <button type="button" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </header>
      {!collapsed ? (
        <>
          <div className="viewportDiagnosticsActions">
            <button
              type="button"
              aria-label="Start viewport recording"
              disabled={recording}
              onClick={start}
            >
              Start
            </button>
            <button
              type="button"
              aria-label="Stop viewport recording"
              disabled={!recording}
              onClick={stop}
            >
              Stop
            </button>
            <button type="button" onClick={() => void copy()} disabled={snapshots.length === 0}>
              Copy diagnostics
            </button>
            <button
              type="button"
              onClick={() => {
                stop();
                setSnapshots([]);
                setCopyStatus('');
              }}
            >
              Clear
            </button>
          </div>
          <div className="viewportDiagnosticsSummary">
            {classify(snapshots).join(' | ')}
          </div>
          <textarea
            aria-label="Viewport diagnostic report"
            readOnly
            value={report}
          />
          {copyStatus ? <div role="status">{copyStatus}</div> : null}
        </>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 4: Add temporary diagnostic styling**

Create `app/features/layout/components/ViewportDiagnostics.css`:

```css
.viewportDiagnostics {
  position: fixed;
  z-index: 1000;
  right: max(8px, env(safe-area-inset-right));
  bottom: max(8px, env(safe-area-inset-bottom));
  left: max(8px, env(safe-area-inset-left));
  max-height: min(52vh, 420px);
  display: grid;
  gap: 8px;
  padding: 10px;
  overflow: auto;
  border: 2px solid #ffcc00;
  border-radius: 10px;
  background: rgba(8, 12, 20, 0.96);
  color: #fff;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
}

.viewportDiagnostics.isCollapsed {
  left: auto;
}

.viewportDiagnosticsHeader,
.viewportDiagnosticsActions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.viewportDiagnosticsHeader {
  justify-content: space-between;
}

.viewportDiagnostics button {
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid #667085;
  border-radius: 6px;
  background: #1d2939;
  color: #fff;
  font: inherit;
}

.viewportDiagnostics button:disabled {
  opacity: 0.45;
}

.viewportDiagnosticsSummary {
  color: #ffdd55;
  overflow-wrap: anywhere;
}

.viewportDiagnostics textarea {
  width: 100%;
  min-height: 160px;
  resize: vertical;
  border: 1px solid #667085;
  background: #000;
  color: #d1fadf;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

- [ ] **Step 5: Mount the temporary component**

In `app/features/chat/ChatPageClient.tsx`, add:

```ts
import { ViewportDiagnostics } from '../layout/components/ViewportDiagnostics';
```

Change only the outer return boundary:

```diff
-return <div className="chatPageRoot"><ChatShell
+return <div className="chatPageRoot"><ChatShell
   ...
-/></div>;
+/><ViewportDiagnostics /></div>;
```

Do not move Chat runtime logic or alter `ChatShell` props.

- [ ] **Step 6: Run the temporary tests**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
tests/viewport-diagnostics.temp.spec.ts --project=desktop-chromium
```

Expected: 2 passed.

- [ ] **Step 7: Run TypeScript and verify the privacy boundary**

Run:

```bash
npx tsc --noEmit
rg -n "textContent|innerText|innerHTML|currentChatId|chatName|composer.*value" \
  app/features/layout/components/ViewportDiagnostics.tsx
git --no-pager status --short
```

Expected: TypeScript passes; the privacy search returns no matches; status
shows the three temporary source changes, temporary test, and the pre-existing
untracked `.agents-chat-storage.json`. Do not stage or commit any of them.

### Task 2: Temporarily deploy and collect physical reports

**Files:**
- Temporary build inputs from Task 1 only
- No commits

- [ ] **Step 1: Stop the development server**

Stop the exact 3011 development-server process or its known Bash session.
Verify:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:3011/login
```

Expected: `000`.

- [ ] **Step 2: Ask the user to stop production**

Ask the user to run:

```bash
sudo systemctl stop agents-chat.service
```

Verify:

```bash
systemctl is-active agents-chat.service
```

Expected: `inactive`.

- [ ] **Step 3: Build the temporary diagnostic version**

Run:

```bash
npm run build
```

Expected: the production build and TypeScript checks succeed.

- [ ] **Step 4: Ask the user to start production**

Ask the user to run:

```bash
sudo systemctl start agents-chat.service
```

Verify:

```bash
systemctl is-active agents-chat.service
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:3010/login
```

Expected: `active` and `200`.

- [ ] **Step 5: Verify the query gate**

Using Playwright or HTTP plus a browser:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3010 \
npx playwright test --config tests/playwright.config.ts \
tests/viewport-diagnostics.temp.spec.ts --project=desktop-chromium
```

Expected: 2 passed. A normal URL has no panel; `?viewportDebug=1` does.

- [ ] **Step 6: Collect the Safari report**

In Safari:

1. Open a historical Chat containing Markdown.
2. Append `?viewportDebug=1` to the URL.
3. Tap **Start** while in portrait.
4. Rotate to landscape and wait one second.
5. Rotate back to portrait and wait at least three seconds.
6. Tap **Stop**, then **Copy diagnostics**.
7. Send the copied report back to this session.

Expected: the report contains baseline, event, and delayed snapshots through
`settle-3000ms`.

- [ ] **Step 7: Collect the iOS Chrome report**

Repeat the exact Step 6 sequence in iOS Chrome and send its report separately,
labelled `iOS Chrome`.

Expected: both reports are available before cleanup begins.

### Task 3: Remove diagnostics and restore clean production

**Files:**
- Delete temporary: `app/features/layout/components/ViewportDiagnostics.tsx`
- Delete temporary: `app/features/layout/components/ViewportDiagnostics.css`
- Delete temporary: `tests/viewport-diagnostics.temp.spec.ts`
- Restore: `app/features/chat/ChatPageClient.tsx`

- [ ] **Step 1: Analyze and save only non-sensitive conclusions**

Compare baseline, landscape, portrait-immediate, and portrait-delayed samples.
Record in the session:

```text
Safari:
- scale changed: yes/no
- Markdown computed font changed: yes/no
- framework computed font changed: yes/no
- horizontal overflow: yes/no and source
- delayed viewport geometry: yes/no

iOS Chrome:
- scale changed: yes/no
- Markdown computed font changed: yes/no
- framework computed font changed: yes/no
- horizontal overflow: yes/no and source
- delayed viewport geometry: yes/no
```

Do not commit raw user-agent reports.

- [ ] **Step 2: Remove every temporary diagnostic change**

Delete only the three known temporary files with `apply_patch`:

```text
app/features/layout/components/ViewportDiagnostics.tsx
app/features/layout/components/ViewportDiagnostics.css
tests/viewport-diagnostics.temp.spec.ts
```

Remove the `ViewportDiagnostics` import and `<ViewportDiagnostics />` mount from
`app/features/chat/ChatPageClient.tsx` with `apply_patch`.

- [ ] **Step 3: Verify complete cleanup**

Run:

```bash
rg -n "viewportDebug|ViewportDiagnostics|viewportDiagnostics|Start viewport recording|Viewport diagnostic report" \
  app tests \
  --glob '!docs/**'
git --no-pager diff --check
git --no-pager status --short
npx tsc --noEmit
```

Expected: ripgrep returns no matches; there are no tracked source changes;
only `.agents-chat-storage.json` is untracked; TypeScript passes.

- [ ] **Step 4: Restore debug-free production immediately**

Ask the user to stop `agents-chat.service`, run:

```bash
npm run build
```

Ask the user to start the service, then run:

```bash
systemctl is-active agents-chat.service
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:3010/login
```

Expected: build succeeds, service is `active`, and `/login` returns `200`.

- [ ] **Step 5: Verify the old debug URL is inert**

Open `/?viewportDebug=1` against production and verify:

```ts
await expect(
  page.getByRole('region', { name: 'Viewport diagnostics' }),
).toHaveCount(0);
```

Expected: the query parameter has no effect because no diagnostic source
remains.

- [ ] **Step 6: Start a root-cause-specific design**

Use the two report summaries to create a focused follow-up design:

- scale changes → visual viewport/page-scale recovery;
- font changes with stable scale → WebKit content autosizing containment;
- overflow → fix the exact overflowing element;
- delayed geometry only → defer layout synchronization until viewport
  settling;
- stable metrics with visible change → compositor/Page Zoom investigation.

Do not implement the final fix until that focused design is approved.
