# iOS Viewport Diagnostics Design

## Goal

Identify why Chat Markdown still changes size during orientation transitions on
physical iOS browsers after document- and application-level
`text-size-adjust: none` fixes, without leaving any diagnostic code in the
final production application.

## Observed Behavior

Physical-device results differ from Playwright emulation:

- Safari enlarges Chat Markdown in landscape and restores it in portrait.
- Safari may briefly enlarge framework text such as the header and Composer
  controls during rotation before restoring it.
- iOS Chrome enlarges Markdown in landscape. After returning to portrait, the
  text briefly returns to its original size and then enlarges again one or two
  seconds later.
- Applying `text-size-adjust: none` to `html`, `.chatPageRoot`, and its
  descendants did not remove the physical-device symptom.

The framework and Markdown do not always change together, so visual inspection
alone cannot distinguish WebKit text autosizing from visual-viewport scale,
layout-width fitting, or a delayed browser-chrome reflow.

## Constraints

- The diagnostic code must not be committed.
- The final production build must not contain a diagnostic component, query
  parameter switch, recorder, or debug styling.
- The phone cannot access a non-production port.
- The user permits a temporary diagnostic build on production port 3010,
  followed by complete removal and another production build.
- Diagnostics must not read or record Chat content, Chat IDs, user identity,
  Composer input, credentials, or agent configuration.
- User pinch zoom remains enabled.

## Design

### Temporary diagnostic component

Create an uncommitted client component and temporarily mount it from the layout
composition layer. It renders only when the URL contains
`viewportDebug=1`. A normal URL renders no panel and installs no diagnostic
event listeners.

The panel is a small fixed, collapsible surface at the bottom of the viewport.
It provides:

- Start recording;
- Stop recording;
- Copy diagnostics; and
- Clear.

The component reads metrics only. It never changes viewport metadata, font
sizes, focus, scroll position, layout variables, or browser scale.

### Recorded metrics

Each snapshot contains:

- elapsed time and triggering event;
- user agent and browser display mode;
- screen orientation and angle when available;
- `window.innerWidth` and `window.innerHeight`;
- document `clientWidth`, `clientHeight`, `scrollWidth`, and `scrollHeight`;
- `visualViewport.width`, `height`, `offsetLeft`, `offsetTop`, and `scale`;
- window scroll offsets;
- active element tag and computed font size, without its value or text;
- Markdown computed font size and bounding rectangle;
- message bubble computed font size and bounding rectangle;
- header computed font size and bounding rectangle;
- Composer computed font size and bounding rectangle; and
- the maximum horizontal overflow amount detected among application elements,
  plus the overflowing element's tag and class names only.

Missing elements are recorded as unavailable rather than replaced with a
default value.

### Sampling lifecycle

Recording captures a baseline immediately. It then listens to:

- `orientationchange`;
- window `resize`;
- `visualViewport.resize`; and
- `visualViewport.scroll`.

For the first event in each orientation sequence, it records:

1. the event-time snapshot;
2. the next animation frame;
3. 100 milliseconds;
4. 500 milliseconds;
5. 1.5 seconds; and
6. 3 seconds.

Repeated native events may add event snapshots, but scheduled checkpoints for
one sequence are deduplicated. This covers Safari's immediate transition and
iOS Chrome's observed delayed enlargement.

### Diagnostic classification

The copied report includes raw snapshots and a deterministic summary:

- `visualViewport.scale` changes while CSS font sizes remain stable:
  visual/page scale is changing.
- Markdown computed font size changes while viewport scale remains stable:
  WebKit text autosizing or a CSS typography transition is changing the
  content.
- document `scrollWidth` exceeds `clientWidth`, or an element crosses the root
  bounds: horizontal overflow may be triggering fit-to-width scaling.
- viewport offsets or dimensions remain unsettled at delayed checkpoints:
  browser chrome or keyboard viewport restoration is still active.
- all measured values remain stable despite visible enlargement: the next
  investigation must target compositor rendering or browser-level Page Zoom.

The classifier does not claim a root cause when multiple categories change; it
reports all matching signals.

## Temporary Production Workflow

1. Confirm the committed worktree is clean except for the existing untracked
   `.agents-chat-storage.json`.
2. Add the diagnostic component and mount as uncommitted changes.
3. Verify TypeScript and build.
4. Stop and restart `agents-chat.service` around the temporary production
   build.
5. Confirm the ordinary URL has no diagnostic panel.
6. Open the same URL with `?viewportDebug=1`.
7. Record portrait-to-landscape-to-portrait in Safari, waiting at least three
   seconds before stopping.
8. Repeat in iOS Chrome.
9. Copy both reports back into the development session.
10. Analyze the metrics and select a root-cause-specific production fix.
11. Remove every diagnostic source, import, mount, query flag, and style.
12. Search the worktree for diagnostic identifiers and verify none remain.
13. Build and deploy the root-cause fix, or restore the clean baseline first if
    more design work is required.

Diagnostic source changes are never committed. The design document may remain
as an audit record of the investigation.

## Failure Handling

- If Clipboard API access fails, the report remains visible in a selectable
  text area for manual copying.
- If no Markdown is visible, the panel says so and recording remains usable;
  the user must open a historical Chat containing Markdown before retrying.
- If `visualViewport` is unavailable, its fields are explicitly marked
  unavailable while document metrics continue recording.
- Starting a new recording cancels all scheduled samples from the previous
  recording.
- Unmounting removes every event listener and pending timer.
- Refreshing or closing the page discards all recorded data.

## Verification

### Temporary diagnostic verification

- TypeScript passes before deployment.
- A production build succeeds.
- A normal URL does not render the panel or attach diagnostic listeners.
- `?viewportDebug=1` renders the panel.
- Start, stop, clear, copy, and clipboard-failure fallback work.
- The report contains no Chat text, IDs, input values, or user identity.
- Rotation produces immediate and delayed samples through three seconds.

### Cleanup verification

After collecting the reports:

- remove the temporary component and every integration change;
- search for `viewportDebug`, component names, recorder event names, and debug
  CSS classes, expecting no matches outside this design document;
- confirm `git diff` contains only the intended root-cause fix, or is clean if
  the fix is not yet implemented;
- run TypeScript and the production build again; and
- verify the final production URL cannot activate diagnostics with the old
  query parameter.

## Acceptance Criteria

- Safari and iOS Chrome each produce a complete orientation report with
  samples through three seconds.
- The reports distinguish viewport scale, computed typography, overflow, and
  delayed viewport geometry rather than relying on visual guesses.
- No sensitive Chat or user data is recorded.
- Diagnostic code is never committed.
- The final production build contains no diagnostic functionality.
- The resulting evidence is sufficient to design a root-cause-specific fix
  without disabling pinch zoom by default.
