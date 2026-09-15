# Orientation Chat Scroll Stability Design

## Goal

Keep the user's chat reading position stable across mobile orientation changes:

- if the chat is at the latest message, it remains at the latest message;
- if the user is reading history, the same message remains at the same visual
  offset.

## Current Behavior and Root Cause

`ChatPageClient` tracks whether `.chatContainer` should stick to the bottom.
During an orientation change, browser layout reflows message content and
automatically changes `scrollTop`. The existing scroll handler observes that
decrease before the new layout settles and interprets it as a user scroll.
It clears the bottom-sticky intent, so the chat remains at an older position
after portrait layout increases message height.

Raw `scrollTop` is also insufficient for history reading because line wrapping
changes message heights between landscape and portrait.

## Design

### Intent-aware anchor snapshot

Add a focused chat-runtime hook responsible only for stabilizing scroll across
viewport relayouts. It receives the current chat container ref and the existing
bottom-stickiness refs/callbacks.

During normal scroll handling, the hook records:

- whether the container is bottom-pinned; and
- when detached from the bottom, the first message intersecting the top of the
  chat viewport, its DOM element, and its top offset relative to the container.

The element reference remains valid through a CSS reflow because React does
not remount unchanged messages.

### Viewport relayout lifecycle

The hook listens to:

- `window.resize`;
- `window.orientationchange`;
- `visualViewport.resize`; and
- `visualViewport.scroll`.

At the first event in a relayout sequence, it retains the last stable snapshot
instead of recalculating from already-reflowed geometry. While relayout is
active, scroll events caused by browser geometry changes do not update
bottom-stickiness or replace the anchor.

Each viewport event restarts a short settling timer. After the timer, two
animation frames allow CSS layout and the visual viewport variables to settle
before restoration:

- bottom-pinned snapshots set `scrollTop` to `scrollHeight`;
- historical anchors adjust `scrollTop` by the difference between the
  anchor's current and saved top offsets.

After restoration, the hook updates the existing last-scroll and jump-to-latest
state, then resumes ordinary scroll tracking.

### Fallback behavior

If the historical anchor element was removed or disconnected while relayout
was active, restore the saved `scrollTop` clamped between zero and the current
maximum. This avoids an arbitrary jump without relying on stale DOM.

If no snapshot exists, leave browser scroll behavior unchanged.

Unmounting cancels timers and animation frames. The hook does not change
message data, chat persistence, Composer focus, overlays, or viewport metadata.

## Component Boundaries

- `app/features/chat/runtime/useChatOrientationScrollStability.ts` owns anchor
  capture, relayout event handling, restoration, and cleanup.
- `ChatPageClient` wires its existing chat container and stickiness refs into
  the hook. Its normal scroll calculation remains the authority outside a
  viewport relayout.
- `MessageList` and `MessageBubble` require no new state. Existing `.message`
  elements are sufficient as stable DOM anchors.
- `ChatShell` continues to synchronize application viewport height/offset; it
  does not manage chat scroll.

## Interaction Rules

- A chat within four pixels of its bottom counts as bottom-pinned.
- Browser-generated scroll changes during viewport relayout do not count as
  user intent.
- Normal wheel/touch scrolling after restoration continues to detach or
  reattach bottom stickiness through existing behavior.
- New streamed messages continue to auto-scroll only when bottom stickiness is
  active.
- The jump-to-latest button remains hidden for bottom-pinned chats and visible
  when the user is reading history.
- Switching chats and switching between Chats and Files retain their existing
  independent scroll restoration behavior.

## Testing

Extend mobile Playwright coverage with a long conversation:

1. Scroll to the bottom in landscape, trigger the portrait viewport lifecycle,
   and assert the distance from the bottom remains within four pixels.
2. Scroll to a historical position, record the top-intersecting `.message` and
   its offset, trigger the portrait viewport lifecycle, and assert the same
element remains at the same offset within four CSS pixels.
3. Confirm the jump-to-latest button is visible in the historical case.
4. Repeat coverage in Android Chromium and iPhone WebKit. Where Playwright
   WebKit cannot mutate the fixed mobile screen width reliably, drive the
   visual viewport/orientation lifecycle without using its accumulating
   `setViewportSize` emulation artifact.
5. Run the existing complete responsive and visual viewport suites.

## Acceptance Criteria

- Landscape-to-portrait transition keeps a bottom-pinned chat at the latest
  message.
- Repeated orientation changes do not move a bottom-pinned chat into history.
- A user reading history remains anchored to the same message within four CSS
  pixels of its prior visual offset.
- Automatic viewport scroll events never overwrite the user's prior
  stickiness intent.
- Streaming, manual scrolling, jump-to-latest, chat switching, Files
  switching, Composer focus, and overlays preserve existing behavior.
