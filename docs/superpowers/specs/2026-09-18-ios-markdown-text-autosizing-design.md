# iOS Markdown Typography Across Orientation Changes

## Review Status

Revised after source-level comparison with OpenClaw and the excluded agents-chat
orientation experiments. The architecture direction is appropriate, but the
two CSS declarations alone are **not an established fix**. They repeat a
previously attempted policy; adding `body` to an inherited root declaration
is not evidence of a new solution.

This design authorizes a diagnostic baseline and a narrowly controlled
candidate, not an unconditional production rollout or a shell rewrite.
Implementation planning must preserve the evidence gates below.

Implementation status: the CSS candidate and remote regression suite are
available on `fix/ios-markdown-text-autosizing`. Baseline `372b676` and candidate
`90439cd` have revision-specific Actions artifacts; the candidate passed 104
applicable checks. See the
[implementation record](../plans/2026-09-18-ios-markdown-text-autosizing.md#execution-record)
for run links and evidence limitations. The reported physical iPhone symptom
was not reproduced in CI, and on-device A/B acceptance is still pending.

The user subsequently authorized a PROD deployment for physical testing.
The first attempt was automatically rolled back: the built CSS had lost the
iOS prefix even though source-policy checks passed. Revision `79781d5` adds
the compiler-target correction below, passed all 104 checks including the
new delivered-CSS assertions, and is now deployed to PROD. Physical iPhone
acceptance remains pending.

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
- [Chat typography and scroll containers](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/styles/chat/startup-layout.css#L32-L140):
  Markdown layout remains a feature responsibility.

This reference supports a design choice, not proof of identical behavior on
the user's device or of the precise OpenClaw version the user runs.

Earlier agents-chat experiments included `100%`, `none`, descendant overrides,
viewport scale recovery, and shell changes. They were excluded from the merged
mobile UX work after failing physical-device acceptance. In particular,
`7b9edb7` skipped actual WebKit viewport resizing in an orientation test, and
`b75373c` checked computed font sizes rather than actual text geometry.
However, the later `6aa39c6` experiment already included native resize and
glyph-range measurements. Improved measurement is necessary, but it is not
new proof that the current candidate will work. Reintroducing a declaration
without stronger evidence is not sufficient.

## OpenClaw Compatibility Architecture

The reference is the ordinary browser Control UI, not a native macOS host,
an embedded WKWebView, or an installed standalone app. Those modes have
different rules and must not be mixed when comparing implementations.

| Responsibility | OpenClaw at the pinned commit | Fit for agents-chat |
| --- | --- | --- |
| Browser text inflation | Unconditional `100%` on `html, body` | Suitable baseline policy; efficacy still requires an A/B result |
| Authored typography | `--control-ui-text-scale`, semantic text sizes, and `--chat-text-size`; `.chat-text` consumes the chat font and size | Preserve the existing message font and `em` hierarchy; do not add a new typography settings system |
| Navigation layout | Browser query is `(max-width: 900px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)`; native web chrome has a separate 600px threshold | Record the current 900px state during rotation; do not mistake crossing it for whole-page zoom |
| Compact content layout | Some chat CSS uses 768px plus the same short-landscape clause, separately from navigation | Navigation and content density are different decisions; do not mechanically replace every breakpoint |
| Ordinary browser shell | CSS grid, `100vh` enhanced to `100dvh`, clipped root, and shrinkable inner scroll containers | Keep the current grid and transcript scroll owner; changing visual-viewport sizing is a separate, evidence-gated experiment |
| Standalone shell | `display-mode: standalone` can make `body` fixed and apply safe-area padding | Do not infer that fixed positioning is universally wrong from the ordinary-browser implementation |
| Touch input zoom | Coarse-pointer inputs have a minimum 16px size, independent of viewport width | Current composer is 15px; focused-input zoom is a separate possible confounder, not proof of Markdown autosizing |

Additional source references:

- [Typography tokens and input size](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/styles/base.css#L230-L247)
- [Mobile navigation classification](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/app/mobile-nav-layout.ts)
- [CSS-owned browser shell](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/styles/layout.css#L7-L85)
- [Touch input and standalone rules](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/styles/base.css#L739-L817)
- [Shared chat typography coverage](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/src/e2e/chat-side-chat-typography.e2e.test.ts)

The last test verifies typography consistency and an explicit user text
scale across reading surfaces. It is not physical iPhone rotation coverage.
CSS custom properties are a useful single source of authored values, not
an intrinsic defense against WebKit autosizing. The transferable principle
is to separate authored text size, browser inflation, layout classification,
and viewport geometry.

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

### Stage 1: Establish the Baseline

Use the unchanged production behavior from `7f8c292` as variant A, with only
test/diagnostic additions. Capture the reported unfocused-input scenario on
the affected iPhone in both browsers, including portrait cold load,
landscape, return to portrait, and landscape cold load.

Identify the exact served application revision and resource set. Use an
isolated, revision-identifiable preview or approved deployment of the
Actions-built artifact; a local checkout or successful workflow does not
prove which JavaScript and CSS the phone loaded. Do not test a stale deployed
build against a newly edited source tree. Do not replace the shared running
service or deploy over production without approval.

Playwright route mocks do not exist in a normal phone browser. For physical
acceptance, populate an isolated test instance with the same synthetic
conversation through the existing authenticated chat persistence/API path.
Do not add a public fixture endpoint or depend on a live agent producing
identical output. If no approved preview/deployment is available, report the
physical comparison as blocked rather than dropping the gate.

Capture only synthetic fixture content and geometry. A read-only diagnostic
helper may be kept under the test helpers and used through supported device
inspection. It must not upload conversation text, modify layout, reset zoom,
force scrolling, or introduce a permanent production diagnostic panel.
If device inspection is unavailable, retain a screen recording with the
tested revision and mark DOM measurements unavailable; do not invent them.

Compare DOM layout measurements with visible text relative to nearby
unchanged chrome in the recording. A `Range` rectangle is a browser layout
metric, not an independent measurement of painted glyphs or compositor scale.
Even unchanged ranges and `visualViewport.scale === 1` do not rule out a
physical-device rendering defect.

### Stage 2: Evaluate One Production Variable

Build variant B with exactly the root text-adjust policy below. Use the same
fixture, theme, browser settings, and device as A. Independently cold-load
each variant at the same user zoom, rather than changing a stylesheet in a
tab that may retain enlarged text state. Verify the loaded revision again.

If A visibly reproduces and B prevents enlargement through the same rotation
sequence, keep B as the selected fix, subject to regression and accessibility
acceptance. If both behave alike or A does not reproduce, there is no causal
result: do not mark the candidate successful from a policy-test green light.

If B fails, do not ship it as the resolution of this issue. Retain evidence
and isolate the next variable:

- Failure only when crossing 900px: compare matched-width cold loads and
  layout state transitions before proposing a navigation classification change.
- Failure following focus, with a changed viewport scale: investigate input
  focus zoom separately, using the existing 15px composer as a hypothesis.
- Visible inflation while computed text metrics remain unchanged: preserve
  screenshot/video evidence and investigate browser rendering/containing
  layout, rather than assigning the cause to viewport scale.
- A measured root-geometry correlation: evaluate shell ownership separately;
  do not assume `100dvh` alone handles the iOS software keyboard.

Any wider change requires a revised, approved design. No inverse scaling,
viewport locks, rotation retries, or automatic font-reset patches are fallback
steps in this design.

### Browser-Level Typography

Add `-webkit-text-size-adjust: 100%` and `text-size-adjust: 100%` to the existing
`html, body` rule in `app/globals.css`.

Keep the declaration unconditional so it remains active across orientation
changes and both sides of the 900px layout breakpoint. Descendants inherit the
policy; do not add universal descendant selectors or `!important` overrides.
Preserve the existing explicit font sizes and relative Markdown hierarchy.

The policy is intended to suppress automatic text inflation throughout the
app, including file previews, share pages, and controls rendered through
portals. It does not impose one font size on those surfaces. Its actual effect
on the reported device remains the Stage 2 question.

Do not add `user-scalable=no`, a maximum zoom restriction, gesture interception,
or viewport mutations. User-initiated browser zoom must remain available.
Do not claim that all browser or operating-system text preferences are
equivalent to pinch zoom; verify the target device's normal zoom separately.

### Build-Time Browser Compatibility

The production-origin artifact for `f47f1b9` exposed a build-pipeline gap:
its root rule contained `-moz-text-size-adjust:100%;text-size-adjust:100%`,
but no WebKit declaration. Next.js 16.2.3 defaults to Chrome 111, Edge 111,
Firefox 111, and desktop Safari 16.4; it does not include iOS Safari.
Its supported-browser loader reads project Browserslist configuration.

Lightning CSS's
[prefix selection](https://github.com/parcel-bundler/lightningcss/blob/c6a0c3cebf3395635e61075d2c81a96a710d4910/src/prefixes.rs)
only emits the WebKit text-adjust prefix when an iOS Safari target is present.
OpenClaw's [Vite configuration](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/vite.config.ts)
uses a different build pipeline, so matching source declarations alone does
not establish equivalent delivered CSS.

Use `.browserslistrc` to preserve all four existing desktop targets and add
`ios_saf 16.4`. This makes the build aware of the supported mobile engine
without introducing runtime browser detection or changing layout ownership.
Review these explicit targets when upgrading Next.js.

The policy regression must fetch the stylesheets linked by the built page
and assert both declarations in the compiled root rule, retaining the raw
CSS as evidence. Source checks and empty Linux WebKit computed values are
not substitutes. Deployment must independently verify the served assets
and roll back if the iOS declaration is absent. This is a correction to
delivery of the same typography policy, not proof of physical acceptance.

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
handling path in the production candidate.

## Verification Design

### Remote-Only Execution

Do not run tests, builds, type checks, package installation, or browser
automation or start a test server on the development machine. Source
inspection, editing, and Git operations remain local.

Use an independent branch pushed to `origin`. Extend the existing GitHub
Actions validation plumbing so the branch runs the new regression cases,
production build, and TypeScript checks. Ensure test selectors include the
new spec on the intended mobile and desktop projects; do not leave a test
file silently excluded by `mobileSpecs`.

Use the existing supported Ubuntu runner and existing Playwright dependencies.
Retain measurements and representative screenshots for both baseline and
candidate even on successful runs; retain traces on failure. Record commit,
Playwright version, browser engine version, device descriptor, and actual
viewport dimensions. A mobile user-agent string is not an engine version.
Validation failures remain visible and fail the job.

### Red/Green Evidence

Add the regression contract and measurements before the production CSS change
and run them in Actions against variant A. The text-adjust policy assertion
must fail without the rule. Keep that contract test separate from the
measurement cases so its expected failure does not prevent baseline evidence
collection through fail-fast behavior. Apply the candidate and repeat the
same tests against variant B.

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
- `Range` client rectangles of short, fixed text fragments within those
  elements, chosen not to wrap in any tested viewport. Assert a nonzero,
  single-line rectangle; do not inject no-wrap wrappers or other styles that
  could change the browser's autosizing decision.
- `window.innerWidth`, `window.innerHeight`, visual viewport width, height,
  and scale where supported.
- Representative header and composer dimensions and font sizes for diagnosis.
- The 900px media-query match, root/page/message container bounds, document
  horizontal overflow, orientation, and device pixel ratio.

Compare identical text fragments within the same browser session after fonts
are ready and responsive transitions have settled. Do not compare different
operating-system fonts across engines. Poll for stable observations over at
least three samples spanning 300ms, with a bounded 10-second timeout; record
transition samples as diagnostics rather than ignoring all intermediate
behavior. On a physical device, record the transition and the state at least
three seconds after it.

For stable, unchanged Markdown text at default zoom, fragment width and height
must remain within 0.5 CSS pixels of their initial values; computed font sizes
must match. Establish an unfocused scale-1 baseline before asserting that
visual viewport scale remains within 0.01 of 1. If the baseline is already
scaled, report it as a different starting condition rather than calling it a
rotation regression.

For focused-input and user-zoom scenarios, capture their own pre-rotation
baseline; do not require scale 1. The existing 15px composer can cause native
focus zoom independently of Markdown. Do not add a 16px input change to the
candidate merely to make a scale assertion pass. New failures relative to
variant A block rollout; pre-existing focus behavior is recorded separately
and does not establish a typography cause.

Do not compare entire paragraph widths or heights across orientation:
normal line wrapping changes those dimensions. Do not require header
typography to remain identical across existing responsive breakpoints.

Missing fixture elements or required geometric measurements fail explicitly.
If a browser does not expose the computed text-adjust property, report that
capability limitation and check the stylesheet declaration in the separate
policy contract; never label a CSSOM declaration as an effective computed
value. Continue geometric coverage rather than skipping that engine.
Screenshot evidence complements geometry; neither DOM metrics nor policy
assertions establish physical painted-glyph stability on their own.

### Scenarios

Use a bounded matrix rather than every possible combination: exercise all
message rendering paths in the primary rotation case; add focused cases for
the wide-landscape breakpoint, streaming, collapse state, and other routes.
Keep measurement helpers shared, without changing the application's markup.

- Portrait to landscape to portrait, repeated three times.
- Landscape first load, then portrait and back.
- Use coherent portrait/landscape pairs, including 390x844 / 844x390 and
  430x932 / 932x430. Record responsive state, without changing the existing
  900px layout policy in this candidate.
- Collapsed and expanded long answers.
- Streaming content that continues updating across viewport changes.
- Input unfocused, and input focused with draft preserved.
- Desktop window resizing with unchanged Markdown typography, unchanged
  baseline grid/sidebar behavior, and browser zoom still available.
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
and focused/unfocused input with its own baseline as described above.
Without a new user zoom action or focus-induced scale change, text must not
inflate in landscape or remain enlarged after returning to portrait. Verify
that manual pinch zoom remains usable and is not reset by application code.

If physical enlargement persists, collect the same viewport and text
measurements through available device inspection rather than assuming a
scale fault or adding another reset hook. First distinguish actual text
inflation from viewport zoom or normal responsive reflow, then revise the
candidate based on that evidence.

## Completion Criteria

- Variant A reproduces the reported physical symptom and variant B removes it
  in a revision-verified comparison, not merely in a stylesheet contract test.
- Remote red/green contract evidence is available.
- Actions build, type checking, and targeted cross-browser regressions pass.
- Existing typography hierarchy, desktop layout, and mobile behavior remain
  intact.
- Physical Safari and Chrome acceptance passes on the affected iPhone.

Until the physical acceptance is complete, report the change as a candidate
validated in CI, not as a confirmed fix for the reported iPhone issue.
