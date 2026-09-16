# iOS Orientation Scale Recovery Design

## Goal

Keep Chat typography and the visible message position stable when a physical
iPhone rotates between portrait and landscape, without refreshing the page or
permanently disabling pinch zoom.

## Evidence and Root Cause

Physical-device diagnostics established two WebKit behaviors that CSS-only
tests did not expose:

- iOS Chrome returns from landscape to portrait with
  `visualViewport.scale` changing from `1` to approximately `2.02`. The scale
  remains incorrect after three seconds even though the computed font sizes
  for Markdown, the header, and the Composer do not change.
- Safari reports `visualViewport.scale === 1` throughout the same transition,
  but visibly changes the rendered scale during orientation relayout while
  computed font sizes and the root document width remain stable.

The problem is therefore an iOS WebKit viewport/rendering transition, not a
Markdown font-size media query, root horizontal overflow, or the
`MessageBubble` collapsed-state calculation. `MessageBubble` decides whether
content is long from text length and line count only; it does not measure the
viewport.

## Constraints

- Pinch zoom must remain available after an orientation transition.
- It is acceptable to reset an intentional user zoom to 100% when the device
  rotates.
- Chat state, unsent Composer content, focus, and the current route must
  survive recovery.
- The fix must cover Safari and all iOS browsers, which use WebKit.
- The recovery must not manipulate the message list's scroll position
  directly or replace the existing message-anchor restoration behavior.
- Existing application-wide `text-size-adjust: none` rules remain as defense
  against ordinary WebKit text inflation.

## Considered Approaches

### Orientation-scoped viewport recovery

After an iOS orientation transition settles, temporarily constrain the
viewport to scale 1, then restore its original zoom-enabled declaration. This
addresses Chrome's measured stale visual scale and forces Safari to recompute
its unreported rendering scale. It does not reload the application and only
interrupts pinch zoom for the two rendering frames used by recovery.

This is the selected approach.

### Permanently disable zoom

Adding a permanent `maximum-scale=1` or `user-scalable=no` is simpler, but
removes a useful accessibility capability and violates the pinch-zoom
constraint.

### Reload after rotation

A full reload usually recreates the viewport at scale 1, but interrupts the
conversation, can discard unsent input, and makes orientation changes depend
on network and session restoration. It is too disruptive.

## Architecture

### Focused recovery hook

Add a focused hook under the layout feature and call it from `ChatShell`. The
hook owns only iOS orientation scale recovery:

- detect iOS, including iPadOS devices that present a desktop-style user
  agent;
- observe `orientationchange`, window `resize`, and
  `visualViewport.resize`;
- group those events into one orientation generation;
- wait until viewport geometry has been quiet for 250 milliseconds, with a
  two-second maximum wait;
- perform one viewport reset for that generation; and
- cancel timers, animation frames, and listeners during cleanup.

The hook remains inactive on Android and desktop platforms. It does not add
React state or cause application rerenders.

### Viewport recovery

At the start of an orientation generation, dispatch the existing
`APP_VIEWPORT_WILL_CHANGE_EVENT` so the Chat message list captures its stable
bottom or message anchor before viewport mutation.

When the generation settles:

1. Find the document's `meta[name="viewport"]`.
2. Preserve its complete `content` value exactly.
3. Create a temporary declaration that retains the existing width and
   interactive-widget behavior while setting `initial-scale=1`,
   `minimum-scale=1`, and `maximum-scale=1`.
4. Apply the temporary declaration once.
5. Wait for two `requestAnimationFrame` callbacks so WebKit commits the scale
   correction.
6. Restore the exact original declaration, returning the page to its normal
   zoom-enabled policy.

Recovery runs after every settled iOS orientation transition rather than only
when `visualViewport.scale` is abnormal. This is necessary because Safari's
public viewport API reports scale 1 while the visible rendering is wrong.

The current `ChatShell` viewport synchronization continues to update
`--app-viewport-height` and `--app-viewport-offset-top` for each native or
recovery-induced resize. The existing Chat orientation stability hook sees
those events, waits for its own 100-millisecond settling period, and restores
the captured message anchor after the final viewport change.

### Repeated transitions

Each orientation event starts a new monotonically increasing generation.
Later events cancel the previous generation's pending settle timer and
animation frames. An in-progress viewport declaration is restored before a
new generation can modify it. Consequently, rapid portrait-landscape-portrait
changes cannot leave a stale scale lock or run an old callback against a new
orientation.

## Failure Handling

- If no viewport meta element exists when recovery is needed, leave the page
  unchanged and emit one explicit console error for that generation.
- Preserve the original viewport string rather than reconstructing the final
  declaration, so unknown or future Next.js viewport directives are not lost.
- Use cleanup and a `finally`-equivalent restoration path so unmounting or a
  callback failure cannot leave `maximum-scale=1` active.
- Ignore resize noise when no orientation generation is active. Keyboard,
  browser chrome, and ordinary responsive resizing must not reset user zoom.
- Do not retry a failed generation indefinitely. A later physical orientation
  change starts a fresh recovery attempt.

## Verification

### Deterministic Playwright coverage

Extend the mobile responsive tests to:

- emulate the supported iOS detection paths;
- rotate portrait to landscape and back;
- observe viewport meta mutations and confirm the temporary scale-1
  declaration is applied exactly once per settled orientation generation;
- confirm the complete original viewport declaration is restored;
- verify the final declaration has no permanent `maximum-scale=1` or
  `user-scalable=no`;
- cover rapid repeated orientation changes and confirm stale callbacks do not
  leave the viewport locked;
- verify the latest message remains at the bottom when it was initially
  pinned there;
- verify a visible historical message remains anchored when the user was not
  at the bottom; and
- retain the existing delayed assertions that Markdown, header, and Composer
  computed font sizes do not change.

Run the focused mobile responsive suite for the existing Android and iPhone
projects. The Android run verifies that the iOS-only recovery does not alter
other mobile behavior.

### Physical-device acceptance

Browser emulation cannot reproduce the measured iOS WebKit rendering defect,
so deployment is not complete until the same physical iPhone passes:

1. In Safari, open a Chat with visible Markdown at the newest message, rotate
   portrait to landscape and back to portrait, then wait at least three
   seconds.
2. Repeat in iOS Chrome.
3. In both browsers, confirm the Markdown and application chrome remain at
   the expected visual size, the newest message remains visible at the
   bottom, and pinch zoom still works after rotation.
4. Repeat while viewing an older message and confirm that message remains the
   visible anchor.

## Acceptance Criteria

- Safari and iOS Chrome no longer leave Chat Markdown or application chrome
  visually enlarged after either direction of an orientation transition.
- A bottom-pinned Chat remains bottom-pinned; a historical reading position
  remains anchored to the same message.
- No page reload occurs, and Chat state, focus, and unsent Composer content
  remain intact.
- The viewport declaration returns to its original zoom-enabled value after
  every recovery, including rapid rotations and component cleanup.
- Pinch zoom works after orientation recovery.
- Android and desktop behavior remain unchanged.
