# iOS Markdown Typography Across Orientation Changes

## Goal

Keep chat Markdown typography stable when an iPhone rotates between portrait
and landscape. On the reported device, Chrome enlarges Markdown text in
landscape and retains the enlargement after returning to portrait. Safari
enlarges it in landscape but restores the original size in portrait.

The user confirmed that header buttons and the composer do not noticeably
enlarge along with the Markdown. This points to text autosizing rather than
whole-page zoom, but physical-device measurements must confirm that diagnosis.

## Evidence and Prior Work

The current `MessageList.css` defines a 13.5px message font and relative
Markdown heading, table, and code sizes. Its responsive rules do not enlarge
the body font in landscape. `app/globals.css` does not declare
`text-size-adjust`.

`ChatShell.tsx` synchronizes visual viewport height and vertical offset.
`ChatShell.css` and `useMobileOverlayState.ts` use a 900px mobile breakpoint.
There is no current evidence that these mechanisms cause the reported
text-only enlargement.

Reference implementation: OpenClaw at commit
`6c6dc44250d66eb8ec84f949c4a433c2dfcd8059`.

- [Global typography policy](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/styles/base.css#L675-L693):
  `html, body` use both prefixed and unprefixed `text-size-adjust: 100%`.
- [Mobile layout](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/styles/layout.mobile.css):
  responsive container and navigation rules are separate from that policy.
- [Chat text styles](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/styles/chat/text.css):
  Markdown layout remains a feature responsibility.

This reference supports a design choice, not proof of identical behavior on
the user's device or of the precise OpenClaw version the user runs.

Earlier agents-chat experiments included `100%`, `none`, descendant overrides,
viewport scale recovery, and shell changes. They were excluded from the merged
mobile UX work after failing physical-device acceptance. In particular,
`7b9edb7` skipped actual WebKit viewport resizing in an orientation test, and
`b75373c` checked computed font sizes rather than actual text geometry.
Reintroducing a declaration without stronger evidence is not sufficient.

## Alternatives

1. Establish a global `100%` text-adjust policy and validate rendered text.
   This is the recommended candidate: small, independent of layout breakpoints,
   and consistent with OpenClaw's separation of responsibilities.
2. Apply the policy only to `.markdownBody`. This narrows the immediate change
   but leaves other text surfaces and Markdown renderers with different browser
   policies.
3. Repair orientation using JavaScript, viewport mutations, forced remounts,
   or font resets. Reject this approach without evidence that CSS cannot solve
   the issue: it adds timing, zoom, scroll, and streaming risks.

## Design

### Browser-Level Typography

Add `-webkit-text-size-adjust: 100%` and `text-size-adjust: 100%` to the existing
`html, body` rule in `app/globals.css`.

Keep the declaration unconditional so it remains active across orientation
changes and both sides of the 900px layout breakpoint. Descendants inherit the
policy; do not add universal descendant selectors or `!important` overrides.
Preserve the existing explicit font sizes and relative Markdown hierarchy.

The policy intentionally suppresses automatic text inflation throughout the
app, including file previews, share pages, and controls rendered through
portals. It does not impose one font size on those surfaces.

Do not add `user-scalable=no`, a maximum zoom restriction, gesture interception,
or viewport mutations. User-initiated browser zoom must remain available.
Do not claim that all browser or operating-system text preferences are
equivalent to pinch zoom; verify the target device's normal zoom separately.

### Preserve Existing Responsibilities

- Global CSS owns browser text-adjust normalization.
- Message CSS owns Markdown typography and content overflow.
- Layout CSS and the existing mobile hook own responsive navigation.
- `ChatShell` retains its current viewport sizing and keyboard behavior.

Do not modify the page composition, ACP protocol, persistence, React Markdown
rendering, layout breakpoints, or input font sizes as part of this candidate.
If measurements identify an additional defect, revise the scope explicitly
rather than restoring the previous broad orientation experiments.

There is no new application state, API, dependency, runtime listener, or error
handling path in the production fix.

## Verification Design

### Remote-Only Execution

Do not run tests, builds, type checks, package installation, or browser
automation on the development machine. Source inspection, editing, and Git
operations remain local.

Use an independent branch pushed to `origin`. Extend the existing GitHub
Actions validation plumbing so the branch runs the new regression cases,
production build, and TypeScript checks. Ensure test selectors include the
new spec on the intended mobile and desktop projects; do not leave a test
file silently excluded by `mobileSpecs`.

Use the existing supported Ubuntu runner and existing Playwright dependencies.
Preserve failure screenshots, traces, server logs, and typography measurements
as workflow artifacts. Validation failures remain visible and fail the job.

### Red/Green Evidence

Add the regression contract before the production CSS change and run it in
Actions against the unfixed state. The text-adjust policy assertion must fail
without the rule. Then apply the candidate and repeat the same test.

A failing policy assertion is not a reproduction of physical iOS text
inflation. Record separately whether the browser runner reproduces rendered
enlargement before the fix. Never label that bug reproduced merely because
the stylesheet contract fails.

### Content and Measurement

Reuse the existing route-mocked chat fixture and authentication patterns.
Cover user messages, ordinary agent messages, and agent text parts during
streaming and after completion. Include long prose, headings, nested lists,
tables, inline code, and fenced code. Keep fixture text and font readiness
deterministic.

At each viewport state record:

- Effective prefixed or unprefixed text-adjust value on root and Markdown.
- Computed font size and line height for representative Markdown elements.
- `Range` bounding rectangles of short, fixed text fragments within those
  elements, chosen not to wrap in any tested viewport.
- `window.innerWidth`, `window.innerHeight`, visual viewport width, height,
  and scale where supported.
- Representative header and composer dimensions and font sizes for diagnosis.

Compare identical text fragments within the same browser session after fonts
are ready. Fragment width and height must remain within 0.5 CSS pixels of
their initial values at default zoom. Computed Markdown font sizes must match
their initial values. In an unzoomed scenario, visual viewport scale must
remain within 0.01 of 1.

Do not compare entire paragraph widths or heights across orientation:
normal line wrapping changes those dimensions. Do not require header
typography to remain identical across existing responsive breakpoints.

Missing fixture elements or required measurements fail explicitly. An
unsupported browser API is reported as such, not replaced with a fabricated
successful value. Screenshot evidence complements geometric assertions;
computed font size or CSS declaration inspection alone is insufficient.

### Scenarios

- Portrait to landscape to portrait, repeated three times.
- Landscape first load, then portrait and back.
- At least one phone-sized landscape viewport below 900px and one above
  900px, without changing the existing layout policy.
- Collapsed and expanded long answers.
- Streaming content that continues updating across viewport changes.
- Input unfocused, and input focused with draft preserved.
- Desktop window resizing with unchanged Markdown typography.
- Representative file Markdown preview and shared conversation coverage
  for the global policy's reach.

Use actual Playwright viewport changes for Chromium and WebKit. Do not skip
WebKit resize, replace viewport changes with synthetic orientation events,
or substitute a mocked visual viewport for typography regression coverage.
Viewport resizing is still emulation, not physical rotation.

Run iPhone WebKit, Android Chromium, and desktop Chromium coverage in Actions.
Existing mobile navigation, composer, overflow, and desktop behavior tests
must continue to pass. No API behavior changes are planned, so no new API
test suite is required.

### Physical iPhone Acceptance

GitHub-hosted Playwright WebKit does not reproduce the entire iOS browser
stack, physical orientation changes, browser chrome, or software keyboard.
Passing Actions is necessary but not sufficient.

On the affected iPhone, record the model, iOS version, Safari and Chrome
versions, and tested application commit with the acceptance evidence.
These details are task evidence, not persistent user memory.

In both browsers, verify default-zoom cold loads in both orientations,
three portrait/landscape round trips, expanded and collapsed Markdown,
and focused/unfocused input. Text must not inflate in landscape or remain
enlarged after returning to portrait. Verify that manual pinch zoom remains
usable and is not reset by application code.

If physical enlargement persists, collect the same viewport and text
measurements through available device inspection rather than assuming a
scale fault or adding another reset hook. First distinguish actual text
inflation from viewport zoom or normal responsive reflow, then revise the
candidate based on that evidence.

## Completion Criteria

- Remote red/green contract evidence is available.
- Actions build, type checking, and targeted cross-browser regressions pass.
- Existing typography hierarchy, desktop layout, and mobile behavior remain
  intact.
- Physical Safari and Chrome acceptance passes on the affected iPhone.

Until the physical acceptance is complete, report the change as a candidate
validated in CI, not as a confirmed fix for the reported iPhone issue.
