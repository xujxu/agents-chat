# Minimal Native Viewport Reproduction

## Decision and Scope

The user approved the isolated HTML design after the preventive candidate
failed its first eligible physical trial. This is an investigation, not a
new recovery mechanism or an ordinary-page fix. Implementation requires
review of this written specification; production deployment requires
separate authorization.

Upload `3bb9f538-2eeb-4fa8-9957-ad94d6f72618` recorded a completed native
preparation before rotation, followed by persistent portrait scale
2.018817186355591 with visual/document widths 428/428. Stop that candidate:
do not add history retries, reactive fallback or CSS compensation.

Determine whether the affected pinch/rotation sequence reproduces in a
document without the agents-chat client runtime. A reproduction would
show that chat-specific code is not necessary to trigger the symptom.
A negative result would not establish that chat code causes it.

## Alternatives

1. **Recommended: isolated HTML response.** Bypass the App root layout,
   React, providers, global CSS and chat runtime while retaining the same
   browser, origin and authentication environment.
2. **Further reduced chat page.** Easier reuse, but retained framework and
   layout behavior would weaken isolation.
3. **Immediate upstream report.** Defer until a useful independent
   reproduction exists. Do not automatically publish logs or source.

## Page and Isolation

Serve `/diagnostics/viewport-minimal` through a thin GET Route Handler
returning a complete HTML document, not an App Router page. Use focused
server-side template and browser-script helpers under
`lib/viewportReproduction/`; keep HTML/script logic out of the route.

The page remains behind the existing middleware login gate. Send an
explicit HTML content type and `Cache-Control: no-store`. Include a
build-bound client revision that can be checked against the downloaded
artifact and uploaded server build ID.

The document contains:

- Fixed 16px text, ordinary block flow and a labeled 100 CSS-pixel
  reference block. Keep all content within the document width.
- Ordinary viewport metadata equivalent to `APP_VIEWPORT`:
  device width, initial scale 1, interactive widget resizes-content.
- Both prefixed and unprefixed `text-size-adjust: 100%`, preserving the
  accepted typography policy without introducing scale restrictions.
- Start, Stop and Upload controls, a static instruction area and a
  fixed-size status/result area. No editable inputs or chat content.

Do not load React, Next client bundles, providers, external fonts,
analytics, chat APIs, global styles or the existing recovery controllers.
Do not use dynamic viewport-height layout, fixed overlays, transforms,
CSS zoom, viewport rewriting, History API writes/traversals, automatic
navigation or reload recovery. Do not intercept native touch gestures.

An explicit fresh document for each comparison is permitted; reloading
after an anomaly to conceal or recover it is not part of the experiment.
No fresh-history-length requirement or artificial history entry is needed.

## Passive Recording

The small native browser script only observes. While recording, do not
update visible readings or layout. Mark the start before recording and
render results only after freezing the record. Install passive touch
listeners; never call `preventDefault`.

Each recording lasts at most 30 seconds, or ends on explicit Stop.
Take an initial sample, periodic samples every 200 ms, samples for
touch start/end/cancel, viewport resize, orientation and lifecycle changes,
and a final sample. Coalesce bursty events within a frame with a bounded
allowlisted event set rather than enqueue unbounded callbacks.

Keep at most 256 samples including initial/final measurements and reject
payloads above 256 KiB. Preserve the initial measurement separately and
bound the remaining buffer. Count overwritten samples explicitly.
Record relative monotonic timestamps: the nominal interval is not a
claim of uninterrupted sampling. Mark hidden/pagehide recordings as
interrupted and freeze without automatic submission or navigation.
Unavailable VisualViewport support is an explicit unsupported state,
not substituted scale 1.

Measurements include:

- Raw VisualViewport scale, width, height and offsets.
- Window inner dimensions, document client/scroll dimensions, screen
  dimensions and device pixel ratio.
- Reference-block bounding dimensions, fixed-text computed font size,
  orientation and current touch count.
- Allowlisted event identities, timestamps and lifecycle state.

Read-only computed style/geometry sampling can itself affect layout
timing. Document this limitation; do not claim the instrumented page is
equivalent to a JavaScript-free browser test.

Start requires visible state, no active contacts, no editable focus,
finite original-scale geometry within the existing 0.01 scale / 2 CSS
pixel width tolerance, and no root overflow beyond 2 pixels. Otherwise
show a specific refusal without changing native scale. Starting a new
recording clears only the recorder, never browser state.

After Stop/timeout/interruption, freeze the complete record. Upload and
retries use that identical snapshot. Do not reread geometry into a frozen
record or automatically resume recording after failure.

## Data Contract and Storage

Use a distinct minimal-reproduction schema, not simulated chat metrics or
manual/reactive/preventive probe evidence. Define it in a focused module
under `lib/viewportReproduction/` with literal identity
`experiment: 'native-viewport-minimal'` and its own `version: 1`.

Validate exact keys, bounded finite metrics, chronological timestamps,
allowlisted events/stop reasons, counters, sample limits and revision
format. Browser/OS version parsing follows the existing diagnostic
approach; do not record raw user agents, URLs, cookies, tokens, arbitrary
DOM, chat content or input contents.

Add a thin POST `/api/diagnostics/viewport/minimal` using the existing
authentication/admin, origin, JSON content-type and bounded-body policy.
Reuse the private diagnostic store and retention queue through a typed
union of accepted log shapes; do not weaken the existing schema-5
validator or reinterpret earlier logs. Share focused admission helpers
where needed instead of duplicating the existing upload policy.

Storage retains the current private permissions, server receive time,
server build ID, seven-day retention and 100-file bound. Existing
schema-5 collectors continue to work. Upload errors are visible and
logged through the established API conventions; no silent fallback,
automatic third-party submission or public log endpoint.

## Remote Validation

No local installations, builds, type checks, tests or browser automation.
Use the existing GitHub Actions workflow and direct inline implementation,
without subagents. Provide progress at least every 15 minutes during
long active work.

Use test-first policy/schema/API coverage and Playwright browser coverage:

- HTML isolation: no framework bootstrap/client bundles, chat network
  calls, global CSS or unexpected subresources; expected viewport and
  typography declarations are present in served HTML.
- No history entries/writes, viewport mutations or recovery operations
  after starting, pinching, rotating, stopping and uploading.
- Native pinch remains possible. Chromium CDP can check actual scale
  departure without claiming to reproduce the affected iOS rotation bug.
- Bounded periodic/event capture, unchanged display during recording,
  overflow accounting, unsupported/invalid baseline admission,
  deadline, lifecycle interruption and frozen retry behavior.
- Exact minimal schema and schema-5 compatibility; authorization,
  origin/body limits, invalid records and explicit storage failures.
- Existing typography and recovery diagnostics remain unchanged.

Record exact red/green revisions, workflow and artifact identities.
Review the compiled response, not just source-level isolation assertions.
Passing automated tests establishes recorder correctness, not physical
reproduction or a repair.

## Physical Decision Tree

After separate deployment approval, use a fresh minimal page in the
affected iPhone Chrome. Start at healthy 1x in landscape, record, pinch
larger, shrink back to 1x, release, rotate to portrait and wait at least
three seconds before Stop/upload. Do not require another successful
preparation or run any history recovery.

- If enlarged geometry or persistent contradictory scale/width recurs,
  retain the short record. Then run the same page and sequence in Safari
  for a browser comparison. Do not infer the exact native component at
  fault solely from browser branding or a raw scale value.
- If only transient contradictory readings occur, report that narrower
  result rather than equating it with the persistent target.
- If the target does not reproduce, do not infer causation or launch
  indefinite retries. First confirm whether the existing non-recovery
  chat baseline still reproduces on the same device. Any additional
  single-variable layout/framework experiments require separate scope.
- Missing baseline/departure evidence, interruptions or dropped samples
  make the relevant conclusion limited or inconclusive. Sparse sampling
  cannot exclude a transient visual jump; preserve user observations.

The outcome is a documented isolation result with raw evidence, not a
promise of webpage-level recovery. Ordinary-page changes, new recovery
candidates and upstream publication remain outside this scope.
