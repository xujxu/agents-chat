# Native Recovery Original-Scale Tolerance Repair

## Approved Direction

The user approved a focused repair of the automatic diagnostic controller's
conflicting original-scale and geometry checks. This does not authorize
ordinary-page promotion or another production deployment. The user approved
the written spec and direct inline implementation. Source `8bcdafe` passed
remote validation in Actions `35428835945`; deployment remains a separate
authorization gate.

## Evidence and Root Cause

Physical upload `f0ee8e7d-8eeb-47b5-808b-2daf4e7520a1` includes stable
landscape observations at approximately scale 1.004727, with visual and document
widths both 832. The existing `atOriginalScale` policy permits absolute scale
error at most 0.01 and width error at most 2 CSS pixels. However, the
automatic controller first requires `consistentGeometry`, whose stricter
width-times-scale equation rejects this reading. Intent remains unknown.

The same extra gate appears when recognizing an already-original viewport
after rotation. Admission and recovery confirmation already use
`atOriginalScale` directly; their intended tolerance must also govern these
other original-scale decisions.

The separately observed portrait reading, scale 2.018817 with widths
428/428, is far outside this tolerance. The user reports normal visible
portrait size. Preserve this contradictory raw evidence and conservative
non-intervention; do not manufacture a scale of 1 or treat appearance as
proof of correct native telemetry.

## Alternatives

1. **Selected:** accept the existing original-scale predicate before requiring
   multiplicative consistency for other geometry. This repairs the conflict
   without expanding the original-scale bounds or weakening confirmed
   enlargement checks.
2. Widen multiplicative consistency globally. Rejected because it changes
   anomaly admission and could interfere with intentional zoom.
3. Require users to land at mathematically exact 1x. Rejected because it
   contradicts the existing tolerance and creates an unreliable mobile UX.

## Controller Change

Only modify `app/features/diagnostics/automaticNativeRecovery.ts`.
At the watching and rotation-assessment gates, settled geometry is eligible
when either `atOriginalScale(o)` or `consistentGeometry(o)` succeeds.
Continue to decide original intent with `atOriginalScale` itself.

Keep all surrounding constraints: stable observations, released contacts,
focus-exit baseline, orientation epoch, deadlines, root-overflow checks,
owned history, live DOM continuity, no retry and no re-arm after Stop.
Do not extract a new helper for this small predicate combination.

Non-original readings still require the unchanged multiplicative
consistency predicate. In particular, an enlarged viewport must still meet
that equation and scale greater than 1.01 before a recovery request.
Consistent deliberate zoom such as 1.16834 or 2 remains intentional non-unit.
Inconsistent scale 2.018817 with full document width remains unassessed.

Do not change the shared geometry functions, manual controller, browser
adapter, diagnostic schema, UI, metadata or ordinary page behavior. No
reload, CSS compensation, viewport lock or gesture interception is added.

## Test-First Validation

Add deterministic controller cases in
`tests/automatic-native-recovery.test.mjs`:

- At scale 1.004727 and widths 832/832 after a released pinch, learn original
  intent; a subsequent confirmed enlargement can trigger recovery.
- At scale 0.995 and widths 832/832, apply the same existing tolerance.
- After editable focus exits, accept the above settled near-unit geometry
  only after the fresh stability period.
- A near-unit, matching-width rotation completes assessment without back.
- Above the original-scale bound, inconsistent full-width geometry does not
  become original; consistent non-unit geometry remains deliberate zoom.
- Width error beyond 2 pixels is not treated as original merely because
  scale is near 1. Portrait contradictory readings and genuine enlargement
  retain their existing strict behavior.

Add Playwright coverage in `tests/automatic-native-recovery.spec.ts` using
the existing synthetic viewport helper. Explicitly simulate the physical
combination of near-unit scale and full document width, not the helper's
usual mathematically derived width. Show that the real hook accepts the
released baseline and permits a later valid correction. Assert native
navigation does not occur merely on the near-unit reading.

Commit failing coverage first and run the existing GitHub Actions workflow.
Implement the two predicate changes after confirming the expected failure.
Run the same production-origin matrix with existing regression selectors,
including manual diagnostics and actual Chromium native cycles. No local
installations, builds, type checks or tests.

## Completion and Deployment Gate

Record exact red/green source revisions and workflow outcomes. Remote
success establishes this policy repair, not new iPhone acceptance. Keep
PROD on its current `e927428` build until separately authorized to deploy
the tested replacement. Repeated native restoration has already been
demonstrated; do not ask the user to repeat the old trial merely to restate
that result.
