# Chrome Static Minimum-Scale Candidate

## Decision and Evidence

The user approved implementation and PROD deployment of an independent
diagnostic candidate declaring `minimum-scale=1`. Normal PROD behavior
must not change. This remains an experiment, not a confirmed native fix.

Four physical recordings from diagnostic revision `3834536` establish:
Chrome baseline and the shell-write-isolated variant both settle at scale 1
before rotation, then reach `2.1635513305664062` in landscape. Safari stays
at 1 in both modes. The ratio matches `926 / 428`. There is no recorded
input focus, horizontal document overflow, or 900px breakpoint transition.
The [diagnostic execution record](../plans/2026-09-18-chrome-pinch-rotation-diagnostics.md#physical-log-analysis)
contains the measurements and exact-version Chromium source references.

The Chrome release has native rotation handling that assigns its scroll
view's minimum zoom after a delay. Explicitly declaring a minimum is a
small, standards-based candidate; this does not prove that the native
minimum is the cause or that the declaration will correct it.

## Independent Route

Add `/diagnostics/viewport-minimum` as a protected App Router page rendering
the existing `ChatPageClient`. Do not fork the chat implementation.
Its static server-rendered viewport differs from the ordinary page only by
`minimumScale: 1`.

Share the existing width, initial scale, and interactive-widget values
through a focused layout configuration export. The ordinary root layout
keeps exactly those existing values. `app/page.tsx` remains unchanged.
No conditional root metadata, user-agent branch, client-side metadata
mutation, maximum-scale declaration, or gesture interception is added.

The trial's upload link is:

`https://agent.xujx.us.kg/diagnostics/viewport-minimum?viewportDiagnostics=baseline`

The `baseline` parameter intentionally retains ordinary shell synchronization;
the candidate varies the static minimum only. Compare it with the existing
ordinary baseline URL, not the failed isolated gate. The route remains
protected by existing middleware. It introduces no automatic fixture seeding
or additional chat persistence.

## Diagnostic Identification

Extend the bounded allowlisted metrics with `viewportMinimumScale`, read
from the actual viewport meta element. It is null when absent and 1 for
the candidate. Include it in initial and subsequent snapshots, and show
the declared minimum in the diagnostic panel.

Advance the diagnostic schema version to 2. Fresh ordinary and candidate
pages emit version 2 with the new metric. Reject older uploads explicitly
with an instruction to reload and recollect; do not silently infer a
minimum for old tabs. Existing saved version-1 files remain untouched.
Preserve client commit identity, server build identity, upload permissions,
privacy allowlist, body/storage bounds, and explicit error handling.

## Validation and Deployment

Write the failing contract and route tests before implementation and run
them in Actions. No local installs, builds, type checks, or browser tests.

Verify the actual HTTP HTML contains exactly one viewport tag: the normal
route has no minimum or maximum; the candidate declares minimum 1 and no
maximum or user-scalable prohibition. Verify hydrated browser metadata
matches the cold response. Use the real upload endpoint to confirm the
new metric and version are persisted, and reject version-1 uploads clearly.

Run the existing three-engine diagnostic, Markdown, keyboard, overlay, and
desktop coverage. Tests must not treat synthetic scale as proof of native
Chrome behavior. Preserve the emitted iOS text-adjust CSS declarations.

Deploy the exact successful production-origin artifact using the existing
backup, build-only swap, public verification, and rollback procedure.
The user already authorized this candidate's deployment.

## Physical Acceptance and Exit

Independently cold-load the normal baseline and candidate on the affected
Chrome. Confirm the diagnostic panel's minimum label, pinch enlarge,
return to the original size, release, wait, and rotate both ways.
Upload without manually correcting an unexpected enlargement first.
Also exercise intentional enlargement and keyboard behavior; do not
forcibly return a user's retained magnification to 1. Do not promote the
candidate if rotation collapses retained magnification or introduces a
keyboard/Safari regression, even if the return-to-100% sequence improves.

Success requires physical logs and the user's visual result to show that
the candidate prevents the unwanted change while ordinary baseline
reproduces it. CI green alone is insufficient. Safari remains a regression
control. If both variants fail, retain evidence and do not promote this
declaration, add a scale lock, or combine unrelated layout changes.
Promotion to the ordinary route is a separate explicit decision.
