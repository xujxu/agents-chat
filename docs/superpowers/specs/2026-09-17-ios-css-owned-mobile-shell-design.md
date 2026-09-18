# iOS CSS-Owned Mobile Shell Design

## Goal

Keep the agents-chat interface, Markdown typography, and visible Chat position
stable through iPhone orientation changes without disabling pinch zoom or
changing desktop behavior.

The mobile browser viewport, CSS application shell, and Chat transcript must
each have one clear owner:

- the browser owns viewport geometry and page scale;
- CSS owns application-shell geometry; and
- the Chat transcript controller owns message scroll position.

## Superseded Approaches

This design supersedes:

- `2026-09-16-ios-orientation-scale-recovery-design.md`; and
- `2026-09-16-ios-initial-viewport-stability-design.md`.

Both approaches passed automated policy and layout tests but failed acceptance
on the same physical iPhone:

- dynamically applying a temporary scale lock did not reliably reset WebKit;
- an initial `maximum-scale=1` declaration did not prevent rotation scaling;
- Safari still enlarged the rendered page in landscape; and
- iOS Chrome could retain an approximately 2x visual scale after returning to
  portrait.

Computed font sizes remained stable in both browsers. This does not by itself
exclude text autosizing or compositor scaling: computed CSS metrics are not
physical rendered glyph measurements. The failed viewport metadata workarounds must
be removed rather than combined with another scale-reset mechanism.

## Reference Architecture

OpenClaw uses one application and Chat structure across desktop and mobile,
with platform differences expressed as bounded layout states:

- `html` and `body` are full-height, non-scrolling roots;
- the application shell uses `100vh` with a `100dvh` enhancement;
- Chat has a continuous flex/grid height chain with `min-height: 0`;
- the transcript is the primary vertical scroll owner;
- the Composer remains in normal flow beside the transcript;
- navigation changes role through classes and media queries;
- ordinary browser tabs do not use a fixed body;
- `visualViewport` positions local portaled overlays only; and
- transcript size changes, rather than page viewport events, drive message
  anchor reconciliation.

The important contrast is that agents-chat currently makes the mobile page
`position: fixed` and rewrites its height and top offset from
`visualViewport` on every resize and scroll. Browser viewport layout and
application JavaScript therefore compete to control the same geometry during
rotation. That feedback loop is the selected root-cause hypothesis.

## Selected Approach

Adopt a CSS-owned mobile browser shell, modeled on the OpenClaw ownership
boundaries but fitted to the existing agents-chat React structure.

This change is deliberately mobile-only. The existing desktop grid, sidebar,
Agents pane, and viewport synchronization path remain unchanged.

### Orientation-safe mobile classification

Use the same query in layout state and feature CSS:

```css
(max-width: 900px), (max-width: 1100px) and (hover: none) and (pointer: coarse)
```

The second clause keeps large touch phones (including 932px landscape iPhones)
on the mobile path after rotation. Width alone must not switch those devices
back to JavaScript root sizing. Fine-pointer desktop layouts above 900px remain
unchanged. The initial viewport synchronization must check the actual media
query before subscribing, even before React's mobile state effect has run.

### Viewport metadata

Update the Next.js viewport export to:

- retain `width: "device-width"`;
- retain `initialScale: 1`;
- retain `interactiveWidget: "resizes-content"`;
- add `viewportFit: "cover"`; and
- remove the ineffective `maximumScale: 1`.

Do not add `user-scalable=no`, `minimum-scale`, or runtime viewport metadata
mutation. Pinch zoom remains available.

### Document root

Keep `html` and `body` at `height: 100%`. Change their overflow policy to:

```css
overflow: clip;
overscroll-behavior: none;
```

`overflow: clip` prevents document scrolling, rubber-band displacement, and
focus or `scrollIntoView` calls from leaving the application shell offset from
the viewport. Inner panes remain responsible for scrolling.

Retain:

```css
-webkit-text-size-adjust: 100%;
text-size-adjust: 100%;
```

These declarations preserve authored text metrics but are not treated as the
orientation fix.

### Mobile application shell

In the existing mobile layout only:

- stop making `.page` a fixed-position visual-viewport proxy;
- give `.page` a `100vh` fallback;
- use `100dvh` when supported;
- keep overflow inside the application shell; and
- remove its dependency on `--app-viewport-height` and
  `--app-viewport-offset-top`.

When `isMobileLayout` is true, `ChatShell` must not subscribe to
`visualViewport.resize` or `visualViewport.scroll` for root geometry and must
not write those viewport CSS variables. Entering mobile layout must clear any
desktop-authored values so stale inline properties cannot override the mobile
CSS shell.

The desktop branch retains its existing viewport synchronization and
listeners. Moving between mobile and desktop layouts must install only the
listeners for the active branch and clean up the previous branch.

### Mobile overlays and safe areas

Navigation backdrop, Chats/Files drawer, and Agents sheet remain overlays, but
their geometry must be derived from CSS `inset`, viewport units, and safe-area
tokens rather than root visual-viewport variables.

Define safe-area values once with `env(safe-area-inset-*)`. Each overlay,
header, and Composer surface consumes only the edges it owns. The application
must not calculate safe-area-adjusted root height in JavaScript.

Overlay positioning may remain `fixed` where viewport-level modality is
required. Fixed overlays do not make the application page itself fixed and do
not become a second owner of shell height.

### Chat layout and message position

Preserve the existing Chat structure:

- intermediate flex/grid containers are shrinkable with `min-height: 0`;
- the message list is the primary vertical scroll container; and
- the Composer remains in normal flex flow.

Preserve the current user-visible anchor semantics:

- if the user is at the bottom, remain at the latest message after resize;
- if the user is reading history, preserve the visible historical anchor; and
- do not move focus or discard the Composer draft.

The Chat scroll container's actual size is the authoritative resize signal.
Use its resize observation to schedule anchor restoration. Orientation events
may start or group a transition, but `visualViewport` must not determine root
geometry or directly determine the final scroll position.

Composer growth must use the same bottom-versus-history policy so it cannot
race a separate orientation restoration.

### Keyboard behavior

Where the browser supports content resizing for the keyboard, the path is:

1. `interactive-widget=resizes-content` asks the browser to resize content;
2. the changed layout viewport updates the CSS mobile shell;
3. the flex layout gives the transcript the remaining height; and
4. transcript resize reconciliation preserves its anchor.

The current test contract that makes the entire page follow mocked
`visualViewport.height` and `offsetTop` is invalid and must be replaced.

A keyboard does not necessarily change `dvh`, and iOS WebKit does not guarantee
support for `interactive-widget=resizes-content`. Desktop device emulation
cannot establish physical keyboard behavior.

A visual-viewport-only change must not change root page geometry. A layout
viewport change must resize the shell and keep the Composer visible.

If physical-device acceptance proves that a supported iOS keyboard still
obscures the Composer, add a focused Composer-only adjustment in a separate
change. Such an adjustment may read visual viewport bounds but must not resize,
translate, or reposition the application root.

### Local visual viewport consumers

Local portaled UI may continue to use `visualViewport` to:

- clamp a menu or popup to visible bounds;
- recompute a trigger or caret anchor; and
- limit a popover's available height.

Those consumers may write only their own geometry. They must not publish
visual viewport height, scale, or offsets to the application shell.

## Alternatives

### Lock the shell to `window.innerHeight`

This avoids the highest-frequency visual viewport feedback but retains
JavaScript as a second page-height authority. Browser chrome, keyboard, and
orientation changes would require additional synchronization rules. It is a
fallback only if the CSS-owned shell fails for a measured browser limitation.

### Use mobile document scrolling

Moving the entire mobile Chat to document scroll can be robust in Safari, but
it changes the current transcript ownership, Composer layout, and message
anchor model. It has a much larger regression surface and is reserved for a
separately designed fallback if the CSS-owned shell fails physical-device
acceptance.

### Apply inverse CSS scaling

Applying `zoom` or an inverse transform from `visualViewport.scale` is
rejected. Safari reports scale 1 while visibly enlarged, transforms alter
hit-testing and fixed positioning, and the approach treats a downstream
rendering symptom rather than removing the competing root geometry systems.

## Error and Fallback Behavior

No runtime scale recovery, retry timer, or viewport mutation is introduced.
Unsupported `dvh` implementations use the `100vh` fallback.

If `visualViewport` is unavailable, local overlays use their existing window
or element bounds fallback. Shell layout does not depend on that API.

If `ResizeObserver` is unavailable, the existing orientation/window resize
settling path may trigger Chat anchor reconciliation, but it must not calculate
or write root geometry from visual viewport values.

## Testing

Follow test-driven implementation. Update or add focused Playwright coverage
before changing product behavior.

### Mobile shell ownership

Verify on the mobile projects that:

- the viewport declaration includes `viewport-fit=cover` and
  `interactive-widget=resizes-content`;
- it contains no `maximum-scale` or `user-scalable=no`;
- mobile `.page` is not fixed;
- its height follows the layout viewport through portrait and landscape;
- repeated `visualViewport.resize` and `visualViewport.scroll` events do not
  change root top, height, inline style, or viewport metadata; and
- repeated orientation transitions do not accumulate page scaling styles.
- portrait/landscape cycles include 932px-wide touch viewports, not only
  widths below the old 900px breakpoint;
- glyph-range height and width for unchanged text remain stable alongside
  computed typography; these are browser-layout checks, not proof about the
  physical iOS compositor.

Keep the native `ResizeObserver` active in integration tests. Instrument it
without replacing delivery with a global manual mock. Observe real transcript
resizing during rotation and Composer growth; preserve pre-resize anchors
rather than recapturing already reflowed geometry. User scroll input must take
priority over pending automatic restoration.

### Chat and keyboard

Verify that:

- a bottom-pinned transcript remains at the latest message;
- a historical transcript preserves its visible anchor;
- Composer drafts and focus survive orientation changes;
- a layout viewport reduction keeps the Composer visible;
- a visual-viewport-only change does not resize the root; and
- local model menus and other covered overlays remain inside visible bounds.

### Navigation and overlays

Verify that:

- Chats and Files drawers cover the mobile shell and honor safe areas;
- selecting a Chat or file still closes the drawer;
- the Agents sheet and backdrop cover the intended mobile viewport; and
- overlay open/close behavior remains correct after rotation.

### Desktop isolation

Add desktop regression coverage for:

- root and page geometry at initial load;
- window resize;
- sidebar grid width and collapse behavior;
- Agents pane placement; and
- absence of mobile shell rules and mobile-only inline cleanup effects.

Existing desktop behavior is the baseline. A mobile fix that changes desktop
geometry is rejected.

### Validation sequence

Run:

1. the focused viewport, keyboard, anchor, overlay, and desktop tests;
2. the complete Android mobile suite;
3. the complete iPhone WebKit suite;
4. strict TypeScript checking; and
5. the production build.

Android and iPhone suites run sequentially to avoid resource contention.

Use the bounded `iOS viewport validation` workflow on Ubuntu 24.04 for final
automation. Ubuntu 20.04 selects Playwright's older WebKit revision override;
package version or an emulated user-agent string does not identify the binary.
Run the two outstanding WebKit cases first, fail fast, and retain separate
trace directories for each stage rather than repeatedly overwriting
`test-results/`. Do not loosen timing or geometry assertions to compensate for
a stalled test runner.

Automated tests prove ownership boundaries and regression safety but cannot
reproduce the physical iOS compositor defect.

## Physical-Device Acceptance

Deploy the production build and test the same iPhone in Safari and iOS Chrome:

1. Open a Chat at the latest message.
2. Rotate portrait to landscape and back, waiting at least three seconds after
   each transition.
3. Confirm the application and Markdown remain at the expected visual scale.
4. Confirm iOS Chrome does not retain an approximately 2x scale in portrait.
5. Confirm the latest message remains visible.
6. Repeat while reading a historical message and confirm its anchor remains.
7. Confirm pinch zoom still works after rotation.
8. Open and dismiss the keyboard; confirm the Composer remains visible and the
   transcript anchor is preserved.
9. Open the Chats/Files drawer, Agents sheet, and model menu in both
   orientations and confirm their bounds and safe-area spacing.

The implementation is accepted only if both browsers pass. If it fails, retain
the diagnostic evidence, remove any ineffective candidate behavior, and
design the document-scroll fallback rather than layering another root viewport
workaround onto this architecture.

## Acceptance Criteria

- Safari and iOS Chrome do not visually enlarge the application or Markdown
  after either orientation transition.
- iOS Chrome does not retain an approximately 2x portrait scale.
- Pinch zoom remains available.
- The mobile application root is not fixed and is not sized or positioned from
  `visualViewport`.
- Visual viewport events affect only local overlays that explicitly consume
  them.
- Bottom and historical Chat positions remain stable.
- Composer drafts, focus, keyboard visibility, drawers, sheets, menus, and
  safe areas remain correct.
- Desktop root geometry, grid navigation, and Agents pane behavior remain
  unchanged.
- No runtime viewport metadata mutation or scale-recovery code remains.
