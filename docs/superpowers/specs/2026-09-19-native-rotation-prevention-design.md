# Native Rotation Prevention Experiment

## Decision and Scope

The user selected the preventive path: "那就继续第一条路径，即 旋转前预防实验".
This specification defines one bounded candidate, not another expansion of
reactive recovery. The user approved the written spec and direct inline
implementation. Source `4c40f4d` passed Actions `35443442742` and was
subsequently deployed with explicit approval as build
`_QKMBDh8Xk3hJBa-jDEnA`. The first eligible physical trial failed:
preparation completed before rotation, but the persistent portrait
scale/width contradiction returned. Stop this candidate; do not promote
it to ordinary pages or add reactive fallback. See the implementation
plan's physical result for evidence.

The experiment tests whether restoring a healthy native history checkpoint
**after a completed pinch returns to original scale, but before rotation**
prevents both whole-page enlargement and persistent contradictory scale
reports. Do not reload, compensate with CSS, fabricate scale readings, lock
viewport scale, or intercept native pinch gestures.

## Evidence and Hypothesis

The existing reactive experiment demonstrated three physical native
landscape corrections and repeatable re-arming. Its success does not extend
to the persistent portrait state with scale 2.018817 and widths 428/428.
In upload `c3b80743-f28d-4e4d-88c4-6e5b28643628`, an explicitly requested
same-document traversal was acknowledged but ended in `scale-timeout`.
Do not add automatic retries or broaden reactive eligibility to that state.

Apple's published reference contains a distinct preventive rationale:

- [restorePageState](https://github.com/apple-oss-distributions/WebKit/blob/WebKit-7619.2.8.11.9/Source/WebKit/WebProcess/WebPage/ios/WebPageIOS.mm#L514-L565)
  restores `m_userHasChangedPageScaleFactor` from the saved initial-scale
  flag, in addition to restoring native scale.
- [dynamicViewportSizeUpdate](https://github.com/apple-oss-distributions/WebKit/blob/WebKit-7619.2.8.11.9/Source/WebKit/WebProcess/WebPage/ios/WebPageIOS.mm#L3935-L4000)
  consults that state when deciding scale preservation during rotation.

Hypothesis: restoring the healthy checkpoint while still at original scale
can reset relevant native state before rotation takes the problematic path.
That internal flag is not observable from web JavaScript. A successful
history transaction is therefore not proof that prevention works.
The Apple tag is not verified as the exact source of iOS 18.7.8.

Alternative paths were considered: modifying reactive recovery is rejected
by the portrait experiment; a browser-minimal reproduction and upstream
report remains the next investigation path if this candidate fails.

## Isolation and Architecture

Use the exact new URL:

`/diagnostics/viewport-preventive?viewportDiagnostics=baseline`

A dedicated thin route avoids an older deployed automatic page silently
ignoring a new query parameter and running reactive recovery instead.
Without the exact path and baseline mode, no preventive controller starts.
The user must explicitly click **Enable rotation prevention** in a fresh
tab at original scale. Provide **Stop rotation prevention**.

Keep the existing manual and reactive routes behaviorally unchanged.
Normal chat pages must not instantiate the new controller or write history.
Use ordinary viewport metadata and the existing diagnostic panel styling.
No new app-wide setting or persistent preference is introduced.

Responsibilities:

- `app/features/diagnostics/preventiveNativeRecovery.ts`: focused pure
  gesture-driven policy, transaction deadlines, current evidence.
- Existing `nativeHistoryBrowser.ts`: reuse the owned checkpoint/working
  pair and live identity guards without weakening them.
- Existing `nativeViewportPolicy.ts`: reuse original-scale bounds and
  stability; retain the recently repaired original-scale tolerance.
- Existing `useNativeHistoryProbe.ts`: choose manual, reactive or preventive
  controller; reuse passive touch, focus, orientation and lifecycle events.
- `PreventiveRecoveryControls.tsx`: enable/stop controls, preparation count,
  current phase and explicit limitations; not a navigation-policy owner.
- Existing diagnostic capture/schema/API modules: distinct typed evidence
  and unchanged private upload safeguards.
- `app/diagnostics/viewport-preventive/page.tsx`: only compose
  `ChatPageClient`; no runtime logic in page or chat composition shell.

Do not refactor the reactive controller into a configurable policy framework
or change unrelated navigation and overlay behavior.

## Initial Admission and History

Retain the existing admission requirements:

- Fresh tab with history length 1, existing App Router-owned state and no
  probe marker.
- Finite native scale within 0.01 of 1 and visual/document width difference
  at most 2 CSS pixels.
- At least three stable observations over at least 300 ms.
- No contacts, editable focus, overlay, root overflow beyond 2 pixels,
  URL change or document/shell/composer identity loss.

Capture chat identities at explicit enablement, after loading. Establish
checkpoint A and same-URL working entry B using the existing adapter.
History length becomes 2. Preserve opaque router state; never manufacture
router ownership or prune pre-existing forward history to gain admission.

After each successful preparation, restamp owned A and push the next B,
replacing only the previously owned forward entry. Length stays 2 rather
than growing with gestures. Check role, token, cycle, URL, length and live
DOM identity before every operation.

Stop never navigates to remove entries. The extra Back entry and fresh-tab
restriction remain explicit experimental limitations, not production UX.

## Gesture-Driven Eligibility

Initial enablement, focus changes, resizes and rotations alone must never
request preparation. Require a real observed multi-touch sequence:

1. Observe at least two contacts, with a finite non-original scale
   observation during that multi-touch sequence. A two-finger contact that
   never shows a scale departure does not qualify.
2. Invalidate previous original intent on the new multi-touch gesture.
   Track its orientation epoch and a unique gesture counter.
3. After all contacts release, start a fixed three-second assessment window
   and reset stability sampling. Partial release to one contact is not
   completion and cannot authorize navigation.
4. Learn original intent only from settled `atOriginalScale` geometry in
   the same orientation epoch. Apply its existing tolerance directly;
   do not reintroduce the conflicting multiplicative prerequisite.
5. If settled non-original geometry is multiplicatively consistent, classify
   it as intentional non-unit zoom and do not navigate. If contradictory
   readings persist until the deadline, consume that gesture as unassessed.

Require no editable focus, overlay, overflow or active contact when issuing
the operation. Focus, any new contact, or orientation change during the
post-release assessment cancels that gesture's eligibility. A later fresh
multi-touch sequence may be assessed, but do not resume the cancelled one
on a delayed timer or a later resize.

A new multi-touch sequence replaces an unconsumed older assessment; counters
ensure at most one navigation request per eligible completed gesture.
Do not derive consent to original scale from rotation or focus exit alone.

## Preparation Transaction

For an eligible released original-scale gesture:

- Issue one `history.back()` from owned B to A while the page is already at
  original scale. Do not wait for rotation or enlargement.
- Require the expected owned checkpoint acknowledgment within three seconds.
- After acknowledgment, require another fresh stable original-scale window
  within three seconds. Being at 1 before traversal cannot by itself satisfy
  this post-acknowledgment condition.
- Recheck guards, re-arm A/B and return to watching. Increment the completed
  `preparations` count only after successful restoration and re-arm.
- A new orientation, touch, editable focus, navigation, overlay or identity
  loss during the transaction stops the experiment. Missing acknowledgment,
  failed original-scale confirmation or a history exception produces a
  visible error and no retry.
- An already-issued traversal cannot be cancelled. After Stop or an
  interruption, allow acknowledgment but never re-arm or navigate again.

No fallback reactive correction is allowed. In particular, if subsequent
rotation produces scale 2.163551 or contradictory portrait 2.018817, keep
recording the failure; do not hide it by invoking the old controller.
There is no small fixed trial-cycle cap, but every gesture has fixed
deadlines and at most one attempt. Stop explicitly before any evidence
counter would exceed the existing 1,000,000 bound; do not emit an invalid
or wrapped counter. Restart after a terminal state requires a fresh tab.

## States, Evidence and UI

Use focused phases:
`idle`, `arming`, `watching`, `pinching`, `assessing-pinch`, `preparing`,
`rearming`, `stopped`, `error`.

Show raw scale, phase, completed preparation count and specific refusal,
cancellation or failure reason. A `watching` state after preparation means
the operation completed, not that the next rotation is proven safe.
Do not use a permanent "prevention succeeded" label.

Advance the diagnostic contract to schema 5 and add experiment identity
`native-history-preventive`. Its exact evidence shape contains:

- Common phase/reason, ownership and document/shell/composer continuity.
- Intent: `unknown`, `original`, or `intentional-nonunit`.
- `cycle`, `preparations`, `gestureEpoch`, `orientationEpoch`, `pendingAck`.

Keep the preventive shape distinct from reactive `corrections` and manual
evidence. Phases/reasons are fixed allowlists; counters are finite integers
within the existing diagnostic bound. Read current evidence even in
terminal states. Preserve raw scale and width observations unchanged.

Keep the 256-sample and 256 KiB limits, dropped counts, explicit upload,
private filesystem storage, authorization/origin checks, retention and
frozen retry behavior. Never record tokens, raw history, arbitrary URLs,
chat/input/attachment content or private exception text.
Explicitly reject old collector versions with the existing fresh-tab
instruction; leave saved records untouched.

## Remote Validation

Use test-first development and existing Node/Playwright tooling. All
installations, builds, type checks and tests run in GitHub Actions; no
subagents and no local validation. Report progress at least every 15 minutes
during long work.

Pure policy cases must prove:

- No preparation at enablement, on rotation/resize/focus alone, on a single
  touch, or on multi-touch without an observed scale departure.
- Released original and near-original geometry prepares once; partial
  release, active touch, contradictory geometry and non-unit intent do not.
- Fresh post-release and post-acknowledgment stability, fixed deadlines,
  gesture/epoch cancellation, Stop before/after acknowledgment and explicit
  API errors.
- Many successful preparations preserve length 2 and live ownership.
- Unintended enlargement after a prepared rotation remains uncorrected
  by this controller, so failure cannot be masked by reactive fallback.

Browser/API coverage must verify real history operations, no document
replacement, retained draft/attachment/stream continuity, no duplicate
send/resume, overlay/Back boundaries, exact route gating and strict schema
matching. Include near-original full-width telemetry and native Chromium
pinch-scale transitions using CDP where supported. CDP can validate the
transaction, but cannot prove the affected iOS rotation behavior.

Preserve the existing typography, manual/reactive, API and UX regressions.
Record exact red/green revisions, runs and candidate artifact.

## Physical Acceptance and Stop Criteria

Deployment requires separate approval of the remotely validated artifact.
The user starts a fresh preventive tab and enables once. Test a completed
pinch-return-to-original, wait for preparation to finish, then rotate.
Cover both portrait-origin and landscape-origin pinches, with at least
three completed preparations across the short uploaded recordings.

Acceptance requires native scale and visual/document width to remain
consistent with original scale across the assessed rotations, native pinch
still working, and document/chat continuity. A preparation count increasing
does not meet this criterion.

Do not claim clean prevention if any captured post-rotation raw scale is
outside the existing original tolerance. Distinguish:

- Confirmed enlarged geometry: preventive candidate failed.
- Persistent contradictory scale/width: candidate failed the required
  native-consistency outcome, even if appearance is normal.
- Only transient contradictory reports followed by correct settled state:
  partial/inconclusive, not a clean all-orientation native-scale fix.

Do not infer absence of transient enlargement from sparse or dropped
samples. Retain any visible jump reported by the user as a failure of
seamless UX, regardless of later settled readings. Upload short recordings
between cycles to preserve evidence rather than require another long run.

If the candidate fails under its eligible sequence, stop this candidate;
do not silently combine it with reactive correction or layer another reset.
Report the result and move to a separately scoped minimal-reproduction
investigation. If it passes, only then design ordinary-page integration
and resolve Back/overlay/non-fresh-tab history constraints.
