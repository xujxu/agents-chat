# Initial Chat Restore and Mobile Text Stability Design

## Goal

Fix two page-refresh and mobile-orientation defects:

1. After a full browser refresh, keep the Chat content area in a loading state
   until the last Chat's saved messages are ready.
2. Show the last Chat's real title as soon as Chat-list metadata is available,
   instead of temporarily replacing it with `New Chat`.
3. Prevent mobile Safari from automatically enlarging Chat text across
   orientation changes while preserving user-controlled pinch zoom.

## Current Behavior and Root Causes

### Initial Chat restore

`useChatRuntime` initializes `chatName` as `New Chat`, renders a welcome
message, and starts two requests from its mount effect:

1. `/api/chats` loads the Chat list and `lastChatId`.
2. `/api/chats?id=<lastChatId>` loads the selected Chat's details.

The first response sets `currentChatId` before the details are available, but
does not set `chatName`. `ChatSidebarList` treats that ID as current and
therefore replaces the list entry's saved name with the runtime `New Chat`
value. Meanwhile, the welcome message and Composer remain visible until the
detail request finishes. There is no explicit initial-restore lifecycle, even
though manual Chat selection already has a loading transition.

Assigning an unloaded Chat as the current persisted Chat also creates a race:
if the user selects another Chat before the initial detail request finishes,
the placeholder state can be saved over the historical Chat and the late
initial response can overwrite the user's newer selection.

### Orientation text enlargement

The document currently uses:

```css
-webkit-text-size-adjust: 100%;
text-size-adjust: 100%;
```

This fixes the adjustment percentage but still permits Safari's automatic text
inflation algorithm. On a physical iPhone, Safari can recalculate inflated
text during orientation changes, so repeated transitions may visually enlarge
Chat content even though the CSS font-size declarations have not changed.

The viewport intentionally allows user scaling and must continue to do so.
Disabling pinch zoom with `maximum-scale=1` or `user-scalable=no` is outside
the scope of this fix.

## Design

### Focused initial-restore lifecycle

Extract the mount-time Chat restoration into a focused runtime hook. It owns a
discriminated state with these outcomes:

- loading Chat-list metadata;
- loading a known Chat by ID and real title;
- failed, with enough metadata to retry; and
- complete, including the no-history case.

The hook receives narrow runtime adapters for normalizing Chat data, committing
messages and session metadata, hydrating orchestrations, and preparing session
resume. `ChatPageClient` remains a composition layer and consumes only the
resulting state and retry callback.

The restore flow is:

1. The first client render marks initial Chat restore as loading. The page
   shell and sidebars remain visible, but the central Chat area renders the
   existing `ChatLoadingView`; the Composer is hidden.
2. Fetch `/api/chats`. Populate `chatHistory` from the normalized list.
3. Resolve `lastChatId`, falling back to the newest Chat as today.
4. If there is no historical Chat, complete restoration and show the existing
   empty homepage.
5. If a historical Chat exists, find its list entry and immediately set
   `chatName` and `activeSidebarChatId` from that metadata. Update the loading
   label to the real title. Do not yet assign `currentChatId`.
6. Fetch the Chat details and apply the existing failed-send migration.
7. After the messages are ready, commit the title, messages, agent sessions,
   and `currentChatId` together, then end the Chat-area loading state. The
   historical messages and Composer appear in the same render.
8. Continue orchestration hydration and agent-session resume in the
   background. Those operations do not extend the visible history-loading
   state.

The list entry already contains the real title, and `chatName` is updated from
the same metadata. Therefore no selected sidebar title is rendered as
`New Chat` while details are pending.

### Selection and cancellation rules

Every initial restore attempt has a monotonic token or equivalent cancellation
guard. Starting a manual Chat selection, creating a Chat, or changing the
primary-agent filter cancels the active restore attempt.

Because `currentChatId` remains unset until initial details are ready:

- manual selection does not persist placeholder messages over the historical
  Chat;
- selecting the same sidebar Chat can use the normal selection flow; and
- late list, detail, orchestration, or resume work cannot overwrite a newer
  user-selected Chat.

The existing manual `useChatSelectionTransition` continues to own sidebar
selection loading. Initial restore and manual selection have distinct states,
but they share the same central loading presentation.

### Initial restore failure and retry

List or detail failures must not silently become an empty page or leave an
infinite spinner.

On failure, the Chat content area renders an explicit load error and Retry
action while keeping the known real Chat title and navigation visible. The
Composer remains hidden because no valid current Chat has been committed.
Retry starts a new guarded restore attempt. A successful retry follows the
normal atomic commit path.

If list metadata cannot be loaded, the error uses a generic Chat-loading label.
If the list succeeded but details failed, the error retains the selected Chat
ID and real title.

### Disable automatic text inflation, not user zoom

Change the document policy to:

```css
-webkit-text-size-adjust: none;
text-size-adjust: none;
```

This disables Safari's automatic text inflation across viewport and
orientation changes. It does not change declared message font sizes or
breakpoint typography.

Keep the existing viewport metadata unchanged:

- `width=device-width`;
- `initial-scale=1`;
- `interactive-widget=resizes-content`; and
- no `maximum-scale` or `user-scalable=no`.

Pinch zoom therefore remains available. The mobile 16px minimum for editable
controls also remains in place to prevent focus-triggered iOS auto-zoom.
Existing visual-viewport sizing and Chat scroll-anchor restoration remain
responsible for layout and message position only; they do not manipulate page
scale.

## Component Boundaries

- A focused hook under `app/features/chat/runtime/` owns initial restore state,
  request ordering, cancellation, retry, and runtime commits.
- `useChatRuntime` exposes the initial restore state and retry callback with
  the rest of the runtime API. Its body no longer embeds the full mount-time
  Chat-fetch chain.
- `ChatPageClient` chooses between initial restore, manual selection loading,
  Files content, empty state, and loaded messages. It does not implement the
  restore workflow.
- `ChatLoadingView` remains the shared loading presentation. A focused error
  view handles the retry action without adding error behavior to the spinner.
- `ChatSidebarList` keeps using list metadata and requires no independent
  fetching.
- `globals.css` owns the document-level text inflation policy.

## Testing

### Full-page refresh restoration

Add Playwright coverage with a delayed initial Chat-detail response:

1. Reload the whole page, equivalent to pressing F5.
2. Assert the Chat content area immediately renders an accessible loading
   status.
3. After list metadata arrives, assert the active sidebar entry and loading
   label show the saved title and never show `New Chat`.
4. Assert placeholder/previous messages and the Composer are absent while
   details are pending.
5. Release the detail response and assert saved messages and the Composer
   appear together.

Cover the no-history path, detail failure with Retry, successful retry, and a
manual selection that supersedes a delayed initial restore. The late initial
response must not replace the manually selected Chat.

Run the existing manual selection-loading and `lastChatId` restoration tests
to preserve their behavior.

### Mobile typography stability

For Android Chromium and iPhone WebKit mobile projects:

- record a Chat message's computed font size;
- drive repeated portrait/landscape viewport lifecycles;
- assert the computed message font size remains unchanged;
- where the browser implements `text-size-adjust`, assert its computed value
  is `none`;
- assert mobile editable controls remain at least 16px; and
- assert the viewport still contains no setting that disables pinch zoom.

Linux Playwright WebKit does not implement `text-size-adjust`, so its test must
explicitly accept only that unsupported-engine case rather than treating it as
proof of Safari behavior. Chromium and a CSS declaration regression cover the
policy automatically. A physical iPhone Safari check remains required to
confirm the device-specific visual symptom is resolved.

Run the existing orientation, visual-viewport, scroll-anchor, and full mobile
responsive suites serially against one development server.

## Acceptance Criteria

- An F5 refresh shows a loading state in the Chat content area until saved
  messages are ready.
- The page shell and navigation remain visible during initial restoration.
- As soon as Chat-list metadata is available, the selected Chat uses its real
  title everywhere; it never temporarily displays as `New Chat`.
- The Composer and placeholder messages remain hidden during initial restore.
- Saved messages and the Composer appear together when detail loading
  succeeds.
- No-history, failure, Retry, and superseding manual-selection paths terminate
  deterministically without stale responses overwriting newer state.
- Initial loading ends when historical messages are rendered; orchestration
  and agent-session resume continue without blocking the Chat UI.
- Repeated orientation changes do not automatically enlarge Chat text on
  mobile Safari.
- User pinch zoom remains enabled, mobile input auto-zoom protection remains
  active, and existing scroll-position stability is preserved.
