# Repeatable Native Rotation Recovery Experiment

## Decision and Evidence

The user approved the direction and boundaries of a repeatable automatic
diagnostic experiment, then approved this written specification and direct
inline implementation. Implementation at `e927428` passed remote validation
in Actions `35427133737`; the implementation plan records exact evidence.
Automatic deployment still requires separate authorization, and physical
iOS Chrome acceptance is pending. Approval does not authorize changing
ordinary page behavior.

The existing manual experiment at revision `7104363` has demonstrated:

- Two physical native scale restorations from 2.16355 to 1, with correct
  832-pixel landscape visual/document widths and retained chat DOM.
- Functional native pinch after restoration.
- Recurrence after another pinch-back-to-100% and rotation, within one
  continuous recording that retains all preceding samples.

The [manual experiment record](../plans/2026-09-19-chrome-native-history-probe.md)
contains upload identities, exact measurements, CI and deployment provenance.
A one-time correction is insufficient. The manual panel's terminal
`restored` phase is not a continuing guarantee about later geometry.

## Selected Approach and Limits

Use reactive correction after a confirmed rotation anomaly, based on the
physically demonstrated same-document restoration primitive. Reuse one owned
checkpoint/working-entry pair so successful cycles do not accumulate history.

The alternative, resetting native view state immediately after every
pinch-back before rotation, might reduce visible enlargement but has not
demonstrated prevention on the affected iPhone. It is not included in this
experiment. Keeping only a manual recovery button does not address the
requested ongoing UX.

This is correction, not a promise that no enlarged frame will ever appear.
It may briefly show enlargement before native restoration completes. It
also adds one same-document browser history entry. These limitations must
remain visible when enabling the experiment.

The supported intent for this trial is returning to 100% before rotation.
Do not force a user who intentionally retains another zoom level back to 1.
This guard does not claim to fix Chrome's own behavior when rotating at
other intentional zoom levels; that remains outside this trial's acceptance.

No reload, CSS zoom/transform compensation, viewport scale locks, synthetic
pinch gestures, or native-gesture interception is permitted.

## Route and Feature Boundaries

Add `/diagnostics/viewport-auto`, rendering the existing `ChatPageClient`.
Use ordinary `APP_VIEWPORT` metadata and baseline shell synchronization.
Do not combine the trial with minimum-scale or the isolated-shell candidate.

Enable controls only for:

`/diagnostics/viewport-auto?viewportDiagnostics=baseline`

Require an explicit **Enable automatic recovery** action in a fresh,
history-clean tab before the first pinch. The manual route and all existing
diagnostic modes retain their current behavior. Ordinary chat pages do not
create checkpoints or run automatic navigation.

Keep route and chat composition shells thin. Introduce a focused pure
automatic controller alongside the manual controller. Extract the shared
browser history/identity adapter and settled-geometry helpers where needed
to avoid duplicating ownership checks; preserve the manual controller's
one-shot policy and regression tests.

The adapter owns browser reads, passive input tracking, native history
operations, lifecycle listeners and cleanup. Controllers own decisions and
deadlines. Controls and the recorder consume typed evidence; neither owns
navigation policy.

## Admission and History Ownership

Retain the manual experiment's initial prerequisites:

- Current history length is exactly 1, with an existing App Router-owned
  state and no probe marker.
- Native scale is within 0.01 of 1; visual/document widths match within
  2 CSS pixels; readings are finite and stable for at least 300 ms with
  at least three observations.
- No active touches, focused editable field, open mobile overlay, or
  document/shell/composer identity change.

Refuse unsafe admission with an explicit reason and a new-tab link. Never
clear existing history or manufacture the router's ownership flag.

Capture shell/composer identities at explicit enablement, after loading.
Preserve opaque router state. Mark the current entry as checkpoint A, then
push one same-URL working entry B. Use document-scoped ownership and cycle
markers internally; never upload their raw values or the full history state.
The resulting history length is exactly 2.

Each later operation rechecks URL, router state, entry role/cycle, history
length and live DOM identities immediately before acting. Missing ownership
stops automatic behavior; there is no navigation-based repair.

## Tracking User Intent

Maintain an intent state independent of raw browser scale:
`unknown`, `original`, or `intentional-nonunit`.

Successful initial establishment sets `original`. A new multi-touch gesture
invalidates that inference immediately. After all contacts are released and
geometry settles, native scale near 1 with matching width sets `original`;
consistent non-unit scale sets `intentional-nonunit`. If readings remain
inconsistent, intent remains `unknown`.

Do not learn user intent from a scale change caused only by rotation.
In particular, native scale 2 with full-width visual geometry is neither
proof of deliberate zoom nor a reliable enlargement measurement. The
physical recordings contain such inconsistent intermediate readings.
If a consistent non-unit scale settles without a pinch or an intervening
orientation boundary after the last accepted 100% baseline, treat intent
as unknown rather than assuming a browser-induced anomaly. This protects
unobserved zoom actions such as browser UI controls from a forced reset.

An editable focus/keyboard transition invalidates eligibility for the current
rotation. It is not a reason to reset zoom. After focus leaves, establish
an original-scale baseline only from settled, consistent 100% geometry,
outside the active rotation window. Non-unit or ambiguous readings must
not be silently converted to 100% intent.

Any active contact blocks navigation. A new gesture during a rotation
assessment cancels that assessment instead of racing the user's pinch.

## Rotation Assessment

Require a browser orientation-change boundary, not merely a resize event;
keyboard and browser-toolbar resizes must not trigger recovery. Deduplicate
the platform orientation notifications for a single direction change.
Keep an orientation epoch so asynchronous work cannot correct a later
rotation using an earlier decision.

Assess only if the last known user intent before that boundary was
`original`. Allow at most three seconds after the boundary to obtain stable,
consistent geometry. Resizes and scroll events do not extend this deadline.

To confirm an unintended enlargement, require all of:

- Native scale is greater than 1.01.
- Visual width multiplied by native scale agrees with document client width
  within `max(2, scale)` CSS pixels, accommodating integer viewport rounding.
- There is no root horizontal overflow beyond 2 CSS pixels.
- Scale, visual width, document width and orientation are stable for at least
  300 ms with at least three observations.
- Intent remains `original`, no contacts or editable focus are active, and
  history/document ownership remains valid.

If native scale and geometry already show 100%, return to watching without
navigating. If measurements stay inconsistent, explicitly record that the
rotation could not be assessed and skip it. A later genuine orientation
boundary may be assessed using the still-known intent, provided no new
gesture or focus transition invalidated it.

Do not hardcode the observed 2.16355 multiplier or device dimensions.
Do not correct on a delayed timer after the assessment was cancelled,
superseded or timed out.

## Recovery and Re-Arming

For a confirmed anomaly, issue exactly one `history.back()` from B to A.
Require the expected owned checkpoint popstate within three seconds.
Then require stable native scale 1 and matching visual/document width
within a separate three-second settling deadline, using the same live
identity and no-active-input guards as the manual experiment.

A missing acknowledgment, wrong entry, failed native correction, history
exception, new gesture during restoration, or ownership loss stops the
automatic controller with an explicit error. Do not retry that rotation,
call forward, reload, or add another fallback mechanism.

After successful restoration, retain the stable current orientation and
100% intent. Recheck that A is still current, the owned pair is intact and
there has been no external navigation. Update the owned cycle marker and
push the next working entry B at the same URL. This replaces only the known
forward B entry from the completed cycle; total history length remains 2.
There is no accumulation of additional entries across successful cycles.

Re-arming is part of the completed restoration transaction, not a response
to an arbitrary popstate. If a user presses Back, Forward, or opens a mobile
overlay that modifies history, invalidate the transaction and stop. The
existing mobile overlay hook legitimately uses pushState/back; do not
override it, intercept its popstate, or delete its entries.

There is no fixed lifetime cycle cap: independently confirmed future
rotations can recover while ownership remains intact. Safety is bounded
per rotation by one traversal, fixed deadlines and no automatic retry on
failure. Never run overlapping recovery/re-arm transactions.

An explicit **Stop automatic recovery** control disables the controller.
Stopping or component cleanup cancels pending work but does not traverse
history to remove the extra entry. Browser history cannot be transparently
restored to its original length here; disclose this rather than hiding it.
An already-issued native traversal cannot be cancelled: let the browser
finish it, but do not re-arm or issue another navigation after stopping.
Restarting a stopped experiment requires a fresh diagnostic tab.

## Controller States and UI

The automatic controller has focused states:
`idle`, `arming`, `watching`, `assessing-rotation`, `restoring`, `rearming`,
`stopped`, and `error`.

Show the current state, current native scale, successful correction count
and specific refusal/stop reason. A completed correction increments the
count; it must not leave a permanent green `restored` label while later
geometry is wrong. Current ownership and identity evidence is read live,
not copied indefinitely from a prior successful transition.

Use the existing diagnostic panel style and real visual-viewport bounds so
controls remain reachable during the enlarged landscape state. No scaled
wrapper or layout-coordinate compensation is added.

## Evidence and Privacy

Advance the diagnostic contract to schema 4 and add the allowlisted
`native-history-auto` experiment identity. Keep ordinary and manual probe
data explicitly distinguishable.

Manual samples retain their existing probe evidence shape. Automatic
samples include the common phase/reason/ownership/continuity fields plus
bounded numeric cycle, correction count and orientation epoch, the fixed
intent enum, and a pending-history-acknowledgment boolean. Validate the
exact shape appropriate to the top-level experiment; do not accept mixed
manual/automatic payloads or arbitrary strings.

Record enablement, intent changes, orientation assessment, recovery request,
history acknowledgment, settled outcome, re-arm and stop/error transitions
with the existing monotonic sample time and raw viewport metrics. Recompute
live continuity flags for automatic snapshots, including terminal states.

Retain explicit administrator upload, private filesystem storage, no raw
history state/URLs/tokens/content, 256-sample and 256 KiB limits, dropped
counts, origin checks, retention, and frozen-snapshot upload retry. Existing
saved logs remain untouched. Older collectors receive an explicit
fresh-diagnostic-tab instruction, not silent schema inference.

## Validation, Deployment and Acceptance

Follow test-first development with the existing Node and Playwright tooling.
All installs, builds, type checks and tests run in GitHub Actions. Execute
inline and report progress at least every 15 minutes during long work.

Pure-controller cases must cover original versus intentional non-unit intent,
out-of-order scale/width updates, portrait inconsistent geometry, toolbar/
keyboard resize exclusion, gesture cancellation, repeated notifications,
stale epochs, fixed deadlines, history errors, user navigation, overlays,
stop/cleanup, and many successful cycles without history growth.

Real History API browser coverage must exercise at least three correction/
re-arm cycles while keeping history length 2, router state and URL intact,
and Document/shell/composer identities unchanged. Preserve draft,
attachment, selected chat and a controlled ongoing response without a
new document request, duplicate prompt or resume/restart. Prove normal and
manual routes retain their prior behavior, and prove browser Back is not
cancelled or followed by automatic re-arming.

Keep mocked viewport policy tests separate from actual native Chromium CDP
scale observations. Persist native outcomes in CI artifacts. Neither proves
the affected iOS WKWebView behavior. Include schema/API privacy/failure cases
and all existing typography, keyboard, overlay and desktop regressions.

After remote validation and explicit deployment authorization, deploy only
the exact successful production-origin artifact using existing consistent
database backups, build-only swap, public health checks and rollback.

Physical acceptance on the affected iPhone requires repeated
pinch -> return to 100% -> rotation cycles with automatic native recovery,
without manual restore clicks, reload, client-state loss or history growth.
Verify both starting orientations, continued pinch, and that intentional
non-unit zoom does not provoke this controller's forced reset. Separately
check native-scale/geometry inconsistencies and user navigation stop behavior.

Even if the isolated trial succeeds, promotion to ordinary chat requires
another decision addressing the extra Back entry, normal in-app history,
non-fresh tabs, visible correction latency and intentional non-unit rotation
behavior. Do not describe this experiment as a complete transparent
production fix before those issues are resolved.
