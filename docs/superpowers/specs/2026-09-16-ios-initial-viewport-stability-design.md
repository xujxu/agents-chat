# iOS Initial Viewport Stability Design

## Goal

Keep Chat typography and message position stable through iPhone orientation
changes by establishing the scale policy during initial page parsing, while
retaining pinch zoom if iOS WebKit permits it.

## Superseded Approach

This design supersedes the selected implementation in
`2026-09-16-ios-orientation-scale-recovery-design.md`.

That implementation waited for orientation geometry to settle, temporarily
changed the existing viewport meta element to scale 1, and then restored its
original content. It passed deterministic Playwright lifecycle tests but
failed physical-device acceptance:

- Safari still enlarged text in landscape and restored it in portrait.
- iOS Chrome still enlarged in landscape and remained enlarged after returning
  to portrait.

iOS exposes visual viewport scale for observation but no supported API for
setting page zoom. Dynamic viewport metadata changes are not a reliable scale
reset on the tested iOS 18 WebKit versions, so the ineffective runtime recovery
must be removed rather than retained as dead complexity.

## Selected Approach

### Initial viewport policy

Add `maximumScale: 1` to the Next.js `Viewport` export in `app/layout.tsx`.
This places `maximum-scale=1` in the server-generated viewport declaration
before WebKit performs its initial layout. Unlike the failed runtime mutation,
the orientation lifecycle therefore starts with a defined scale ceiling.

Do not add `user-scalable=no`. Modern iOS Safari commonly ignores viewport
zoom restrictions to preserve accessibility zoom, but iOS Chrome behavior must
be confirmed on the physical device. This is an explicitly reversible
candidate: it becomes the final fix only if both browsers still permit pinch
zoom after deployment.

### Authored text-size policy

Change the existing application-wide declarations from:

```css
-webkit-text-size-adjust: none;
text-size-adjust: none;
```

to:

```css
-webkit-text-size-adjust: 100%;
text-size-adjust: 100%;
```

Apply the declarations to the same `html`, `.chatPageRoot`, and
`.chatPageRoot *` selectors. A fixed 100% adjustment tells WebKit to use the
authored font sizes while avoiding the physical Safari behavior observed with
`none`. Existing explicit mobile font sizes, including 16px interactive
controls, remain unchanged.

### Remove ineffective runtime recovery

Delete:

- `app/features/layout/orientationScaleRecovery.ts`;
- `app/features/layout/hooks/useIOSOrientationScaleRecovery.ts`; and
- `tests/orientation-scale-recovery.spec.ts`.

Remove the hook import and invocation from `ChatShell`. Remove the standalone
viewport-mutation helper functions and the recovery-specific lifecycle,
rapid-generation, platform-isolation, and missing-meta tests from
`tests/mobile-responsive.spec.ts`. The existing repeated-orientation test may
use a local `MutationObserver` to assert that no transient viewport mutation
occurs.

Keep the existing `ChatShell` native viewport synchronization and
`useChatOrientationScrollStability` behavior. The bottom and historical-message
anchor tests continue to verify message position after relayout.

## Alternatives

### CSS inverse scaling

Measure `visualViewport.scale` and apply an inverse transform or CSS `zoom` to
the application root. This could compensate for iOS Chrome, but Safari reports
scale 1 while visibly rendering text larger. It would require a separate
Safari heuristic, alter hit-testing and fixed positioning, and risk blank or
clipped layout regions. Use it only if the initial policy fails.

### Portrait-only fallback

Hide Chat behind a rotate-to-portrait surface in landscape. This avoids showing
Safari's enlarged landscape rendering but does not by itself repair Chrome's
stale portrait scale. Combining it with reload would be disruptive to Chat
state and unsent input, so it is not selected.

### Permanent zoom disablement regardless of accessibility

Combining `maximum-scale=1` with `user-scalable=no` may be stronger, but
intentionally removes pinch zoom. It is outside the approved constraints.

## Testing

### Automated

Update the existing repeated-orientation test to verify:

- the initial viewport contains `maximum-scale=1`;
- the viewport does not contain `user-scalable=no`;
- no script mutates the viewport declaration during repeated orientation
  events;
- `text-size-adjust` resolves to `100%` on `html`, the application root, and
  Markdown content;
- Markdown, header, and Composer computed font sizes stay unchanged;
- the Composer draft remains intact; and
- mobile layout widths return to their prior values.

Retain the existing bottom-pinned and historical-message anchor tests. Run the
full mobile responsive suite for both Android Chromium and iPhone WebKit, plus
strict TypeScript and the production build.

Playwright cannot reproduce the physical WebKit compositor and page-scale
defects. Passing automation proves policy authorship and regression safety,
not the final device outcome.

### Physical-device acceptance

On the same iPhone, test Safari and iOS Chrome independently:

1. Open a Chat with visible Markdown at the latest message.
2. Rotate portrait to landscape and back, then wait at least three seconds.
3. Confirm typography does not become or remain enlarged.
4. Confirm the latest message remains visible at the bottom.
5. Confirm pinch zoom still works after rotation.
6. Repeat from a historical reading position and confirm the same message
   remains anchored.

## Failure and Rollback

The candidate is accepted only if all physical checks pass in both browsers.

- If rotation scaling remains wrong, remove `maximumScale: 1`; the initial
  policy did not solve the root behavior, so retaining it adds no value.
- If rotation is fixed but pinch zoom is unavailable in either browser, remove
  `maximumScale: 1` immediately and proceed to the CSS inverse-scaling
  investigation.
- If only Safari remains wrong, retain no browser-wide zoom restriction solely
  for Chrome until its pinch behavior and accessibility impact are separately
  approved.

Rollback does not revert unrelated mobile UX, loading, typography-size, or
Chat-anchor improvements.

## Acceptance Criteria

- Safari does not enlarge Chat typography in landscape.
- iOS Chrome does not retain enlarged typography after returning to portrait.
- Bottom and historical Chat positions remain stable through rotation.
- Safari and iOS Chrome both permit pinch zoom after rotation.
- The viewport declaration contains no `user-scalable=no`.
- No runtime viewport metadata mutation or recovery timer remains.
- Android and desktop behavior remain unchanged.
