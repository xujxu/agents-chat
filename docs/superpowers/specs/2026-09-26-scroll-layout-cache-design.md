# Accepted Layout Scroll Cache Repair

## Approval and evidence

The user approved the specific accepted-layout cache update, causal regression
coverage, and preservation of existing scroll semantics. This follows controller
diagnostic run36228445199, retained in14c55a7 and the intermittent-diagnostics
specification. Both pinned main and voice accepted an intermediate3px layout
clamp, then reclassified it as independent scrolling against stale cached
geometry/top in the next frame, losing following. No further diagnostic batch
is needed for implementation.

## Product change

Modify only `app/features/chat/runtime/chatScrollController.ts`:
in `onScroll`, after geometry changed and `isIndependentScroll` returned false,
save the already measured current geometry and current scrollTop into geometry
and lastTop; clear expectedTop because the accepted layout position supersedes
the earlier write acknowledgement; then schedule the existing correction.

Invariant: the next classification compares against the most recently accepted
layout position, not the last programmatic write before that layout. Do not
change following, anchor, userIntent or jumping in this branch. Do not notify
or write scrollTop here. Preserve existing independent-scroll precedence,
pending-frame coalescing, observer behavior, disposal/suspension and touch/wheel/
keyboard intent. Keep all existing1px classification and4px bottom tolerances.
No CSS, composer, geometry predicate, component, dependency or toolchain changes.

Forcing following would overwrite historical reading; removing animation would
mask one trigger rather than fix classification. Neither is in scope.

## Causal and preservation coverage

Add `tests/chat-scroll-controller.test.mjs` using Node's existing standard-library
test runner and VM modules. Execute the actual TypeScript controller after type
stripping, with real geometry functions and deterministic DOM/RAF/observer
fixtures. Stub only reading-anchor DOM traversal at its module boundary, so
these tests prove controller state/scheduling, not browser rendering.

Replay contentHeight8061,width844 with bottom positions and height sequences:
192->195->179 and181->184->179. Deliver the intermediate scroll event before
the final contraction and queued frame. Before repair following becomesfalse;
after repair it remainstrue and final top is7882. Assert state and exact top.
Also retain following when scrollend arrives before correction, preserve
independent motion detected during resize or before its delayed scroll event,
preserve explicit user intent and historical anchor identity, and ignore layout
events while suspended/disposed. Every fixture disposes its controller.

Extend `tests/chat-reading-anchor.spec.ts` with two deterministic browser cases:
establish the corresponding container height and bottom state, synchronously
expand by3px, dispatch the resulting accepted scroll position and contract to
179px before yielding. After settling, assert bottom distance<=4. Restore styles
in fixture cleanup. These test-driven geometry changes do not add product hooks
or alter the existing orientation case. Existing orientation, composer remeasure,
manual scrolling, historical text/media and streaming tests remain unchanged.

Run red controller contracts in Actions before changing product code. Then run
green contracts and the existing markdown-typography workflow's reading suites
on iPhone WebKit, Android Chromium and desktop Chromium, using ordinary
uninstrumented product builds. All builds/typechecks and browser execution stay
in Actions; no local tests, installations or servers. Do not infer a universal
race fix from a passing nondeterministic orientation case alone.

## Related diagnostic maintenance

`tests/reading-controller-diagnostics.test.mjs` currently assumes the tracked
controller equals the historical hash. That contract must instead explicitly
read the pinned20f5f0e product controller from an Actions checkout, supplied by
an environment path. This preserves historical source identity and fail-closed
injection without changing its expected hash or retargeting it to repaired code.
The manual workflow contracts job performs that checkout. No historical
cohort is dispatched; its previous budget stays exhausted.

Wire new controller contracts into the existing diagnostic contracts job for
small red/green runs and into the existing typography workflow's geometry step
for ongoing regression protection. Use `--experimental-vm-modules` only for the
Node tests requiring VM linking. Add no package or permanent test server.

## Completion boundary

Retain exact red/green/build/browser outcomes and any unresolved failures.
Persist source, tests and documentation, update Draft PR #2, and stop reminders.
Keep Windows's original residual-directory cause unresolved; do not rerun it.
Licensing and accuracy remain paused. No PR merge, release or publication.
