# Initial Chat Restore and Mobile Text Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a correctly titled, cancellable Chat-area loading state during an F5 restore and stop iOS orientation changes from automatically inflating Chat text without disabling pinch zoom.

**Architecture:** Extract the initial `/api/chats` list/detail chain from `useChatRuntime` into a focused hook that owns loading, failure, retry, and stale-response cancellation. The runtime supplies narrow commit callbacks, while `ChatPageClient` only selects the loading, error, empty, or loaded presentation. Apply the text-inflation fix at the document CSS boundary and retain the existing viewport and scroll-stability behavior.

**Tech Stack:** Next.js 16 App Router, React 19 hooks, strict TypeScript, CSS, Playwright E2E, Android Chromium and iPhone WebKit projects.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `app/features/chat/runtime/useInitialChatRestore.ts` | Own initial list/detail requests, lifecycle state, retry, and cancellation token. |
| `app/features/chat/runtime/useChatRuntime.ts` | Adapt loaded API data into existing message, title, session, orchestration, and input-history state. |
| `app/features/chat/components/ChatLoadErrorView.tsx` | Render the accessible initial-load failure and Retry action. |
| `app/features/chat/components/ChatLoadErrorView.css` | Style the focused initial-load error state. |
| `app/features/chat/ChatPageClient.tsx` | Compose initial restore presentation and cancel it before explicit user navigation. |
| `tests/chat-selection-loading.spec.ts` | Cover F5 loading/title, no-history, retry, and stale initial response behavior. |
| `app/globals.css` | Disable automatic text inflation while retaining mobile input-size protection. |
| `tests/mobile-responsive.spec.ts` | Verify text-adjust policy, stable message font size, pinch zoom, and orientation layout invariants. |

Use a development server on port 3011 while implementing:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 \
NEXTAUTH_URL=http://localhost:3011 NEXT_PUBLIC_E2E_TESTS=1 \
npm run dev -- --port 3011
```

Run Playwright commands below with:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011
```

### Task 1: Initial F5 Chat restore lifecycle

**Files:**
- Create: `app/features/chat/runtime/useInitialChatRestore.ts`
- Create: `app/features/chat/components/ChatLoadErrorView.tsx`
- Create: `app/features/chat/components/ChatLoadErrorView.css`
- Modify: `app/features/chat/runtime/useChatRuntime.ts:1-18, 570-617, 696-731`
- Modify: `app/features/chat/ChatPageClient.tsx:20-29, 74-82, 265-296, 343-344`
- Test: `tests/chat-selection-loading.spec.ts`

- [ ] **Step 1: Add failing F5 restore tests**

Append these tests to `tests/chat-selection-loading.spec.ts`:

```ts
test('shows the saved title and masks Chat content during an F5 restore', async ({ page }) => {
  let releaseInitialChat!: () => void;
  const initialChatGate = new Promise<void>((resolve) => {
    releaseInitialChat = resolve;
  });
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'mobile-chat') await initialChatGate;
    await route.fallback();
  });

  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('status', { name: 'Loading Mobile coverage' })).toBeVisible();
  const activeChat = page.locator('.chatHistoryRow.active');
  await expect(activeChat).toContainText('Mobile coverage');
  await expect(activeChat).not.toContainText('New Chat');
  await expect(page.getByText('Existing mobile message')).toHaveCount(0);
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);

  releaseInitialChat();
  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
});

test('shows the empty homepage after an F5 restore with no chats', async ({ page }) => {
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, chats: [], lastChatId: null }),
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Agents Chat' })).toBeVisible();
  await expect(page.getByRole('status', { name: /Loading/ })).toHaveCount(0);
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);
});

test('shows an initial Chat load error and retries with the saved title', async ({ page }) => {
  let detailAttempts = 0;
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id !== 'mobile-chat' || detailAttempts++ > 0) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'temporarily unavailable' }),
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('alert', {
    name: 'Failed to load Mobile coverage',
  })).toBeVisible();
  await expect(page.locator('.chatHistoryRow.active')).toContainText('Mobile coverage');
  await expect(page.locator('textarea.composerTextarea')).toHaveCount(0);

  await page.getByRole('button', { name: 'Retry loading Mobile coverage' }).click();

  await expect(page.getByText('Existing mobile message')).toBeVisible();
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
});

test('does not let a delayed F5 restore replace a manual Chat selection', async ({ page }) => {
  let releaseInitialChat!: () => void;
  const initialChatGate = new Promise<void>((resolve) => {
    releaseInitialChat = resolve;
  });
  await page.route('**/api/chats**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'mobile-chat') await initialChatGate;
    await route.fallback();
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status', { name: 'Loading Mobile coverage' })).toBeVisible();

  await page.getByRole('button', { name: 'Second mobile chat' }).click();
  await expect(page.getByText('Second chat message')).toBeVisible();

  releaseInitialChat();
  await expect(page.getByText('Second chat message')).toBeVisible();
  await expect(page.getByText('Existing mobile message')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the tests and verify the current UI fails**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
tests/chat-selection-loading.spec.ts --project=desktop-chromium
```

Expected: the four new tests fail because initial restore has no loading/error
lifecycle, temporarily uses `New Chat`, and permits a late response to replace
the manual selection.

- [ ] **Step 3: Create the guarded initial restore hook**

Create `app/features/chat/runtime/useInitialChatRestore.ts`:

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatHistoryEntry, ChatMessage } from '../chatTypes';

export type InitialChatRecord = {
  name?: string;
  ts?: number;
  messages?: ChatMessage[];
  agentSessions?: Record<string, string>;
};

export type InitialChatTarget = {
  chatId: string;
  chatName: string;
};

export type InitialChatRestoreState =
  | { status: 'loading'; chatId: string | null; chatName: string | null }
  | { status: 'failed'; chatId: string | null; chatName: string | null; error: string }
  | { status: 'complete' };

type ChatListResponse = {
  ok?: boolean;
  chats?: ChatHistoryEntry[];
  lastChatId?: string | null;
  error?: string;
};

type ChatDetailResponse = {
  ok?: boolean;
  chat?: InitialChatRecord;
  error?: string;
};

type UseInitialChatRestoreParams = {
  onChatListLoaded: (data: ChatListResponse) => InitialChatTarget | null;
  onChatIdentified: (target: InitialChatTarget) => void;
  onChatLoaded: (
    target: InitialChatTarget,
    chat: InitialChatRecord,
    isCurrent: () => boolean,
  ) => void;
};

function responseError(
  response: Response,
  error: string | undefined,
  fallback: string,
): Error {
  return new Error(error || (response.ok ? fallback : `${fallback} (${response.status})`));
}

export function useInitialChatRestore(params: UseInitialChatRestoreParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const sequenceRef = useRef(0);
  const [state, setState] = useState<InitialChatRestoreState>({
    status: 'loading',
    chatId: null,
    chatName: null,
  });

  const restore = useCallback(async () => {
    const sequence = ++sequenceRef.current;
    const isCurrent = () => sequenceRef.current === sequence;
    let target: InitialChatTarget | null = null;
    setState({ status: 'loading', chatId: null, chatName: null });

    try {
      const listResponse = await fetch('/api/chats');
      const listData = await listResponse.json() as ChatListResponse;
      if (!listResponse.ok || !listData.ok || !Array.isArray(listData.chats)) {
        throw responseError(listResponse, listData.error, 'Failed to load chats');
      }
      if (!isCurrent()) return;

      target = paramsRef.current.onChatListLoaded(listData);
      if (!target) {
        setState({ status: 'complete' });
        return;
      }

      paramsRef.current.onChatIdentified(target);
      setState({
        status: 'loading',
        chatId: target.chatId,
        chatName: target.chatName,
      });

      const detailResponse = await fetch(
        `/api/chats?id=${encodeURIComponent(target.chatId)}`,
      );
      const detailData = await detailResponse.json() as ChatDetailResponse;
      if (!detailResponse.ok || !detailData.ok || !detailData.chat) {
        throw responseError(detailResponse, detailData.error, 'Failed to load chat');
      }
      if (!isCurrent()) return;

      paramsRef.current.onChatLoaded(target, detailData.chat, isCurrent);
      if (isCurrent()) setState({ status: 'complete' });
    } catch (error) {
      if (!isCurrent()) return;
      setState({
        status: 'failed',
        chatId: target?.chatId ?? null,
        chatName: target?.chatName ?? null,
        error: error instanceof Error ? error.message : 'Failed to load chat',
      });
    }
  }, []);

  const cancel = useCallback(() => {
    sequenceRef.current++;
    setState({ status: 'complete' });
  }, []);

  useEffect(() => {
    void restore();
    return () => {
      sequenceRef.current++;
    };
  }, [restore]);

  return {
    state,
    retry: restore,
    cancel,
  };
}
```

- [ ] **Step 4: Add the explicit retry view**

Create `app/features/chat/components/ChatLoadErrorView.tsx`:

```tsx
'use client';

import './ChatLoadErrorView.css';

type ChatLoadErrorViewProps = {
  chatName: string | null;
  error: string;
  onRetry: () => void;
};

export function ChatLoadErrorView({
  chatName,
  error,
  onRetry,
}: ChatLoadErrorViewProps) {
  const target = chatName || 'chat';
  return (
    <div
      className="chatLoadErrorView"
      role="alert"
      aria-label={`Failed to load ${target}`}
    >
      <strong>Could not load {target}</strong>
      <span className="chatLoadErrorDetail">{error}</span>
      <button
        type="button"
        className="chatLoadRetryButton"
        aria-label={`Retry loading ${target}`}
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}
```

Create `app/features/chat/components/ChatLoadErrorView.css`:

```css
.chatPageRoot .chatLoadErrorView {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  color: var(--text);
  background: var(--panel-bg);
}

.chatPageRoot .chatLoadErrorDetail {
  max-width: min(80vw, 480px);
  color: var(--muted);
  font-size: 13px;
}

.chatPageRoot .chatLoadRetryButton {
  min-height: 36px;
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  cursor: pointer;
}
```

- [ ] **Step 5: Move the mount restore chain into the hook**

In `app/features/chat/runtime/useChatRuntime.ts`, import:

```ts
import {
  useInitialChatRestore,
  type InitialChatRecord,
  type InitialChatTarget,
} from './useInitialChatRestore';
```

Keep the local-storage input-history effect, but remove the existing nested
`fetch('/api/chats').then(...)` mount chain. Replace that mount section with:

```ts
useEffect(() => {
  try {
    const savedInputHistory = window.localStorage.getItem(STORAGE_INPUT_HISTORY);
    if (savedInputHistory) inputHistoryRef.current = JSON.parse(savedInputHistory) || {};
  } catch { /* ignore invalid local UI history */ }
}, []);

const initialChatRestore = useInitialChatRestore({
  onChatListLoaded(data): InitialChatTarget | null {
    const history = normalizeChatHistory(data.chats || []);
    setChatHistory(history);
    const lastChatId = data.lastChatId || history[0]?.id || null;
    if (!lastChatId) return null;
    return {
      chatId: lastChatId,
      chatName: history.find((chat) => chat.id === lastChatId)?.name || lastChatId,
    };
  },
  onChatIdentified(target) {
    setChatName(target.chatName);
    setActiveSidebarChatId(target.chatId);
  },
  onChatLoaded(target, chat: InitialChatRecord, isCurrent) {
    const agentSessions = chat.agentSessions || {};
    const isReviewChat = target.chatId.startsWith('comment-review:');
    const migration = migrateFailedSendWarnings(
      chat.messages || [],
      agentSessions,
      { inferLatestUserFailure: !isReviewChat },
    );
    const restoredMessages = migration.messages.length > 0
      ? migration.messages
      : [{
          id: 'welcome',
          type: 'system' as const,
          content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.',
          ts: 0,
        }];
    const restoredName = chat.name || target.chatName;

    currentChatIdRef.current = target.chatId;
    currentAgentSessionsRef.current = agentSessions;
    setMessagesForChat(target.chatId, restoredMessages);
    setChatName(restoredName);
    setCurrentChatId(target.chatId);
    setActiveSidebarChatId(target.chatId);
    needsContextRestoreRef.current = true;

    void (async () => {
      await hydrateOrchestrationsForChat(target.chatId);
      if (!isCurrent() || currentChatIdRef.current !== target.chatId) return;
      setLoadedChatIdForResume(target.chatId);

      if (migration.changed) {
        void persistHandlers.persistLoadedChatMigration(
          target.chatId,
          restoredName,
          chat.ts || Date.now(),
          migration.messages,
          agentSessions,
        );
      }

      if (!inputHistoryRef.current[target.chatId]) {
        const userTexts = migration.messages
          .filter((message) => message.type === 'user' && message.content)
          .map((message) => message.content as string)
          .filter((text) => text.trim().length > 0);
        if (userTexts.length > 0) {
          inputHistoryRef.current[target.chatId] = userTexts.slice(-100);
          try {
            window.localStorage.setItem(
              STORAGE_INPUT_HISTORY,
              JSON.stringify(inputHistoryRef.current),
            );
          } catch { /* ignore unavailable local UI history */ }
        }
      }
    })();
  },
});
```

Expose these fields from the runtime return object:

```ts
initialChatRestore: initialChatRestore.state,
retryInitialChatRestore: initialChatRestore.retry,
cancelInitialChatRestore: initialChatRestore.cancel,
```

Do not change the existing session-resume effect; it will still start only
after `setLoadedChatIdForResume(target.chatId)`.

- [ ] **Step 6: Compose loading/error UI and cancel restore on explicit navigation**

In `app/features/chat/ChatPageClient.tsx`, import:

```ts
import { ChatLoadErrorView } from './components/ChatLoadErrorView';
```

Add these fields to the runtime destructuring:

```ts
initialChatRestore,
retryInitialChatRestore,
cancelInitialChatRestore,
```

Cancel the cold-start attempt before each explicit Chat action:

```ts
function switchAgentFilter(agentId: string | null) {
  if (agentId === registry.selectedAgentFilter) return;
  cancelInitialChatRestore();
  void saveCurrentChatToHistory();
  registry.setSelectedAgentFilter(agentId);
  currentChatIdRef.current = '';
  setCurrentChatId('');
  setActiveSidebarChatId('');
  setChatName('New Chat');
  clearChatMessages({ clearAgentFilter: false });
  currentAgentSessionsRef.current = {};
}

async function loadChat(chatId: string) {
  setOpenChatMenuId(null);
  if (chatId === currentChatId) {
    if (mobile.isMobileLayout) mobile.close();
    else setShowChatsPanel(false);
    requestAnimationFrame(() => chatContainerRef.current?.focus({ preventScroll: true }));
    return;
  }
  cancelInitialChatRestore();
}

async function createNewChat() {
  cancelInitialChatRestore();
  setOpenChatMenuId(null);
  await runtimeCreateNewChat(registry.selectedAgentFilter);
}
```

Replace the existing same-current early-return block with the block above, then
keep the existing selection-loading statements after `cancelInitialChatRestore()`.
This avoids cancelling background resume work when the user merely reopens the
already-current Chat.
Before the `ChatShell` return, derive:

```ts
const initialChatLoading = initialChatRestore.status === 'loading';
const initialChatFailed = initialChatRestore.status === 'failed';
const initialChatLabel = initialChatLoading
  ? initialChatRestore.chatName || 'chat'
  : 'chat';
```

Make initial restore the first Chat-content branch by changing the start of the
existing `messages` expression as follows; leave the existing Files, empty
homepage, and loaded-message branches after it:

```diff
-messages={chatSelection.loadingSelection ? (
+messages={initialChatLoading ? (
+  <ChatLoadingView ref={chatLoadingRef} chatName={initialChatLabel} />
+) : initialChatFailed ? (
+  <ChatLoadErrorView
+    chatName={initialChatRestore.chatName}
+    error={initialChatRestore.error}
+    onRetry={() => void retryInitialChatRestore()}
+  />
+) : chatSelection.loadingSelection ? (
   <ChatLoadingView
     ref={chatLoadingRef}
     chatName={chatSelection.loadingSelection.chatName}
   />
 ) : leftSidebarTab === 'files' && mdEditorOpen && mdSelectedFile ? (
```

Gate the start of the existing Composer condition with the initial restore
lifecycle; retain the existing `ChatComposer` element and props:

```diff
-composer={!chatSelection.loadingSelection && currentChatId
+composer={!initialChatLoading
+  && !initialChatFailed
+  && !chatSelection.loadingSelection
+  && currentChatId
   && !(leftSidebarTab === 'files' && mdEditorOpen && mdSelectedFile)
   ? <ChatComposer
```

- [ ] **Step 7: Run the focused restore tests**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
tests/chat-selection-loading.spec.ts --project=desktop-chromium
```

Expected: all six tests in `chat-selection-loading.spec.ts` pass, including the
two pre-existing manual-selection tests.

- [ ] **Step 8: Run the existing persisted last-Chat regression**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts tests/test-ui.spec.ts \
--project=desktop-chromium -g "should save and restore lastChatId from server on reload"
```

Expected: 1 passed.

- [ ] **Step 9: Commit the initial restore change**

```bash
git add \
  app/features/chat/runtime/useInitialChatRestore.ts \
  app/features/chat/runtime/useChatRuntime.ts \
  app/features/chat/components/ChatLoadErrorView.tsx \
  app/features/chat/components/ChatLoadErrorView.css \
  app/features/chat/ChatPageClient.tsx \
  tests/chat-selection-loading.spec.ts
git commit -m "fix: stabilize initial chat restoration" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Mobile text inflation prevention

**Files:**
- Modify: `tests/mobile-responsive.spec.ts:247-316`
- Modify: `app/globals.css:38-42`

- [ ] **Step 1: Tighten the orientation typography test**

In `tests/mobile-responsive.spec.ts`, update the
`prevents automatic zoom across repeated orientation changes` test before the
viewport loop:

```ts
const viewportContent = await page.locator('meta[name="viewport"]').getAttribute('content');
expect(viewportContent).not.toMatch(/maximum-scale=1|user-scalable=no/);

await expect.poll(() => page.locator('html').evaluate((element) => {
  const style = getComputedStyle(element);
  const supported = CSS.supports('text-size-adjust', 'none')
    || CSS.supports('-webkit-text-size-adjust', 'none');
  const value = style.getPropertyValue('text-size-adjust')
    || style.getPropertyValue('-webkit-text-size-adjust');
  return { supported, value };
})).toEqual(await page.evaluate(() => (
  CSS.supports('text-size-adjust', 'none')
    || CSS.supports('-webkit-text-size-adjust', 'none')
    ? { supported: true, value: 'none' }
    : { supported: false, value: '' }
)));

const message = page.locator('.message').first();
const initialMessageFontSize = await message.evaluate((element) =>
  getComputedStyle(element).fontSize
);

await expect.poll(() => textarea.evaluate((element) =>
  Number.parseFloat(getComputedStyle(element).fontSize)
)).toBeGreaterThanOrEqual(16);
await expect.poll(() => page.locator(
  '.chatPageRoot input:visible, .chatPageRoot textarea:visible, .chatPageRoot select:visible',
).evaluateAll((elements) =>
  elements.every((element) => Number.parseFloat(getComputedStyle(element).fontSize) >= 16)
)).toBe(true);
```

Inside the existing viewport loop, after the layout assertion, add:

```ts
await expect.poll(() => message.evaluate((element) =>
  getComputedStyle(element).fontSize
)).toBe(initialMessageFontSize);
```

Keep the existing draft, navigation, repeated viewport, containment, and width
assertions unchanged.

- [ ] **Step 2: Run the Android test and verify it fails on the current 100% policy**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
tests/mobile-responsive.spec.ts --project=android-chromium \
-g "prevents automatic zoom across repeated orientation changes"
```

Expected: FAIL because the supported engine computes text-size adjustment as
`100%`, not `none`.

- [ ] **Step 3: Disable document-level automatic text inflation**

In `app/globals.css`, replace:

```css
html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
```

with:

```css
html {
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
}
```

Do not modify `app/layout.tsx`; pinch zoom must remain enabled. Do not remove
the mobile 16px `input`, `textarea`, and `select` rule.

- [ ] **Step 4: Run the typography test in both mobile projects**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
tests/mobile-responsive.spec.ts \
--project=android-chromium --project=iphone-webkit \
-g "prevents automatic zoom across repeated orientation changes"
```

Expected: 2 passed. Android Chromium computes `none`; Linux WebKit follows the
explicit unsupported-engine branch. Both preserve stable message font size,
16px editable controls, layout containment, draft state, and pinch zoom.

- [ ] **Step 5: Commit the text stability change**

```bash
git add app/globals.css tests/mobile-responsive.spec.ts
git commit -m "fix: disable mobile text inflation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Cross-feature regression verification

**Files:**
- Verify: `tests/chat-selection-loading.spec.ts`
- Verify: `tests/mobile-responsive.spec.ts`
- Verify: `tests/mobile-composer-viewport.spec.ts`
- Verify: `tests/test-ui.spec.ts`
- Verify: `next-env.d.ts`

- [ ] **Step 1: Run desktop restore and selection regressions**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
tests/chat-selection-loading.spec.ts --project=desktop-chromium
```

Expected: all tests pass.

- [ ] **Step 2: Run the complete Android mobile suite**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
--project=android-chromium
```

Expected: all Android tests pass.

- [ ] **Step 3: Run the complete iPhone mobile suite serially**

Run this only after the Android command finishes:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
npx playwright test --config tests/playwright.config.ts \
--project=iphone-webkit
```

Expected: all iPhone tests pass. Do not run both mobile projects concurrently
against the same development server.

- [ ] **Step 4: Check the worktree and generated Next.js type reference**

Run:

```bash
git --no-pager diff --check
git --no-pager status --short
git --no-pager diff -- next-env.d.ts
```

Expected: no whitespace errors, only intentional files are changed, and
`.agents-chat-storage.json` remains untracked. If `next dev` changed
`next-env.d.ts` from `./.next/types/routes.d.ts` to
`./.next/dev/types/routes.d.ts`, restore only that generated line with
`apply_patch` before continuing.

- [ ] **Step 5: Build against the production `.next` directory**

Ask the user to run:

```bash
sudo systemctl stop agents-chat.service
```

After the user confirms the service is stopped, run:

```bash
npm run build
```

Expected: the Next.js production build succeeds with no TypeScript errors.

- [ ] **Step 6: Restart and verify the production service**

Ask the user to run:

```bash
sudo systemctl start agents-chat.service
```

Then run:

```bash
systemctl is-active agents-chat.service
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:3010/login
```

Expected: `active` and HTTP `200`.

- [ ] **Step 7: Perform the physical iPhone acceptance check**

On physical iPhone Safari:

1. Open a historical Chat and press refresh.
2. Confirm the Chat area shows loading while the sidebar immediately retains
   the real Chat title.
3. Confirm history and Composer appear together.
4. Rotate portrait to landscape and back at least twice.
5. Confirm message text does not grow after either transition.
6. Confirm pinch zoom still works.

Expected: all six acceptance checks succeed. If the physical font still grows,
capture whether browser chrome/page dimensions also scale; do not add
`maximum-scale=1` or `user-scalable=no`.
