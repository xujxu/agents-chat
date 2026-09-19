# Chrome Native History Restoration Probe

## Decision and Scope

The user approved an isolated feasibility experiment using same-document
history restoration and subsequently instructed continuation after the
interrupted specification review. Implementation `7104363` has passed remote
validation and was deployed after explicit user authorization. Two physical
iPhone trials now confirm native 2.16355-to-1 restoration with document/chat
DOM continuity. Native pinch remains functional afterward, but a continuous
recording confirms that another pinch-back and rotation recreates the
anomaly. Repeatable automatic recovery remains unimplemented. The
[execution record](../plans/2026-09-19-chrome-native-history-probe.md#execution-record)
contains exact runs, evidence, and remaining acceptance gates.

The required outcome is a correct **native** browser scale. Page reloads,
CSS/visual compensation, and disabling native pinch zoom are excluded.
The confirmed Markdown text-adjust fix must remain unchanged.

This experiment tests one mechanism, not an automatic production fix:
save a healthy 100% same-document history checkpoint, reproduce Chrome's
pinch/rotation enlargement, and explicitly request restoration to that
checkpoint. A manual button is an experimental control, not the proposed
final user experience.

The existing isolated-shell and static minimum-scale candidates both failed
physical comparison. OpenClaw also reproduces the whole-page enlargement.
Manual refresh restores normal size, but reload-based recovery was rejected.
No non-reload native-scale solution has yet been physically demonstrated.

## Source Basis and Alternatives

Apple's published `WebKit-7619.2.8.11.9` source contains a relevant chain:

- [FrameLoader.cpp, lines 4197-4216](https://github.com/apple-oss-distributions/WebKit/blob/WebKit-7619.2.8.11.9/Source/WebCore/loader/FrameLoader.cpp#L4197-L4216):
  `loadSameDocumentItem` restores view state without a normal document load.
- [WebPageIOS.mm, lines 514-565](https://github.com/apple-oss-distributions/WebKit/blob/WebKit-7619.2.8.11.9/Source/WebKit/WebProcess/WebPage/ios/WebPageIOS.mm#L514-L565):
  `restorePageState` restores or recalculates the saved native scale,
  calls `scalePage`, and sends the corresponding UI-process restoration.
  Initial-scale checkpoints have special handling across viewport sizes.

The same mechanism exists in upstream WebKit revision
`7808acaf7c81f81119a1d1b247ca5fd786715afa`. The Apple tag is Safari 18-era
evidence, not a verified exact source match for the user's iOS 18.7.8.
Neither source inspection nor desktop browser results prove that this
mechanism corrects Chrome's recorded native state.

Rewriting maximum-scale limits is not selected: Chrome 153.0.8010.24
sets `ignoresViewportScaleLimits`, which WebKit passes through to its
always-user-scalable policy. Dynamic viewport-fit changes can trigger
native layout, but the inspected path does not provide a scale-reset
contract. Same-document restoration has the stronger direct native-scale
mechanism, at the cost of history side effects.

## Isolated Application Surface

Add the protected route `/diagnostics/viewport-history`, rendering the
existing `ChatPageClient`. Keep route files as composition shells and put
the controller, controls, and pure policy in the diagnostics feature.
Do not fork the chat runtime or change `app/page.tsx`.

Use the existing baseline viewport synchronization and ordinary
`APP_VIEWPORT` metadata. Do not combine this experiment with minimum-scale,
the isolated shell gate, dynamic viewport mutations, or CSS zoom/transform.

Enable the probe only at:

`/diagnostics/viewport-history?viewportDiagnostics=baseline`

The existing diagnostic panel hosts the experimental controls. Normal URLs,
the ordinary baseline, and the minimum-scale candidate do not acquire
history manipulation. Identify the history experiment explicitly in the
panel and uploaded evidence rather than treating it as ordinary baseline
data.

Keep controls reachable at the observed native scale of approximately
2.16 in landscape: the experimental panel must fit the actual visual
viewport and allow its own contents to scroll. Do not scale the panel or
the application to simulate a successful result.

## One-Shot Controller

Use a focused state machine:
`idle -> arming -> armed -> restoring -> restored | not-restored`.
Ownership loss, lifecycle changes, and API errors produce explicit
`invalidated` or `error` states. One checkpoint and at most one restoration
attempt are allowed per experiment document; there is no automatic re-arm.

### Establish checkpoint

The user starts from a fresh diagnostic tab, before pinch gestures, and
presses **Establish 100% checkpoint**.

Require exactly one existing history entry so arming cannot discard a
pre-existing forward branch. Refuse otherwise with instructions to open a
fresh tab; do not clear or rewrite the user's history to meet this condition.
Offer an explicit new-tab link when this condition fails; it starts a new
experiment document, not a reload-based recovery of the enlarged page.
Also require a usable VisualViewport API, no active touches or focused
editable element, native scale within 0.01 of 1, and visual width within
2 CSS pixels of the document client width. Require consistent readings over
at least 300 ms, with at least three observations, before writing history.
A new gesture or navigation invalidates the pending establishment.

Preserve the existing history state as opaque application data. Add a
namespaced marker identifying the experiment document, attempt, and entry
role to the current entry with `replaceState`, then create exactly one
same-URL entry with `pushState`. The previous entry is the checkpoint;
the new entry is the owned working entry.

Do not store drafts, messages, attachments, credentials, or copies of chat
state in history. Use document-scoped random identifiers and captured
document/shell/composer identities to detect stale or remounted sessions.
Capture shell/composer identities when the user arms the controller, after
the chat has loaded, rather than pinning a transient loading component.
Do not reuse a marker left by a different document or an earlier attempt.

The installed Next.js App Router reloads on some unrecognized popstate
entries. Preserve its opaque state through the supported History API;
do not synthesize framework-private fields, overwrite the router's state,
monkey-patch navigation methods, or suppress its listeners.
Refuse to write unless the existing entry has the installed App Router's
ownership flag; never manufacture that flag to make an unsafe entry pass.

### Request native restoration

After reproducing pinch-out, pinch-back-to-100%, and rotation, the user
presses **Restore native scale**. Before navigating, require:

- The current entry still carries this controller's working-entry marker
  and the URL still equals its captured same-document URL. History length
  remains exactly two.
- The original document, chat shell, and composer still exist unchanged.
- A rotation was observed after establishment, native scale is above 1.01,
  and the current viewport has settled for at least 300 ms.
- No touch gesture or focused editable element is active.

If any prerequisite fails, report the specific refusal; do not navigate.
Otherwise call `history.back()` exactly once. Observe, but do not intercept,
the resulting popstate. Require the expected checkpoint marker within three
seconds. Unexpected navigation invalidates the attempt without any
compensating forward/back calls.

After the expected popstate, allow at most three seconds for settled native
readings. A restored result requires scale within 0.01 of 1, visual width
within 2 CSS pixels of client width, and unchanged document/shell/composer
identities. Require these conditions over at least 300 ms, not a single
transient scale sample. A deadline miss is `not-restored`, not success.

Never reload, force a forward traversal, mutate viewport limits, cancel
pinch gestures, or fall back to visual compensation. Native API exceptions
and missing popstate acknowledgments must be visible and recordable.

### History and lifecycle boundaries

Adding a checkpoint changes browser history. Disclose the extra entry
before the user arms the trial. A fresh diagnostic tab with one history
entry is required, not just recommended; the trial must never prune an
existing forward branch.

Do not intercept the browser Back button or automatically navigate to
remove the extra entry. If the user navigates, stop the experiment. Do not
attempt to reconstruct the history stack. On component cleanup, cancel
timers/listeners and invalidate an armed controller; never traverse history
as cleanup.

These side effects are acceptable only within the approved experiment.
They are unresolved blockers to promoting this technique as a transparent
automatic production fix.

## Evidence, Privacy, and Error Handling

Reuse the existing explicit administrator upload and private bounded store.
Advance the strict diagnostic contract to version 3 so experiment evidence
cannot be mistaken for an ordinary version-2 baseline recording.

Add bounded, allowlisted probe identity, phase/reason codes, transition
times, ownership results, and document/shell/composer continuity results.
Record native viewport metrics at establishment, restoration request,
popstate, and outcome. Other diagnostic pages explicitly identify that no
history probe is active.

Never upload raw history state, arbitrary URLs, DOM content, input values,
attachment data, or chat identifiers. Keep the 256 KiB body limit,
256-sample bound, retention/storage restrictions, administrator/origin
checks, frozen-snapshot retry, and explicit upload errors.

Old-version uploads receive an explicit outdated-collector response
requesting a fresh diagnostic tab. Do not alter existing saved logs or
silently fill in evidence missing from older schemas. This migration
instruction is not a zoom-recovery reload strategy.

## Remote Validation and Physical Decision

Write failing policy, API, and browser cases before implementation. Run
all installs, builds, type checks, and tests in GitHub Actions, never on
the local production host.

Remote coverage must establish:

- Probe gating, one-entry/one-attempt limits, settled-geometry admission,
  ownership loss, API failures, timeout, and lifecycle invalidation.
- Real same-document traversal with unchanged URL, Document and DOM
  identities, and no additional document navigation request.
- Drafts, attachments, selected conversation, and a controlled in-progress
  stream survive traversal. No stream restart, duplicate prompt, or chat
  persistence reload is used to simulate continuity.
- User Back/navigation is not intercepted, unrelated history state is
  preserved, and normal routes never manipulate history.
- Schema-3 evidence persists through the real upload API; malformed,
  unauthorized, cross-origin, oversized, and stale uploads fail explicitly.
- The experimental controls remain reachable with the enlarged landscape
  visual viewport; ordinary viewport metadata and emitted iOS text-adjust
  CSS remain unchanged.

Run the existing three-engine diagnostic, typography, keyboard, overlay,
and desktop regressions. Synthetic viewport updates test policy, not native
recovery. Where feasible, use Chromium's actual page-scale emulation as
additional mechanism evidence, clearly separate from iOS Chrome acceptance.

Only after the relevant remote checks pass should a deployment be proposed.
If authorized, use the exact production-origin CI artifact and existing
backup/build-only swap/health-check/rollback procedure.

Physical acceptance requires the affected Chrome to reproduce its anomaly,
then restore actual native scale and matching viewport geometry without
reloading or losing ongoing client state. Confirm native pinch still works
afterward. Repeat from fresh trials, with Safari as a control. A screenshot
that merely looks correct is insufficient.

If restoration fails, retain the negative evidence and do not broaden the
experiment into navigation tricks or a silent fallback. If it succeeds,
automatic triggering, preservation of intentional zoom, and transparent
history behavior require a separate design and approval. Success here
does not by itself complete the original UX fix.
