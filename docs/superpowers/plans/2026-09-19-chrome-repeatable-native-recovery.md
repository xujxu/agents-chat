# Repeatable Native Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> User selected inline execution. Neither named execution skill is installed;
> implement directly in this session, without subagents or local validation.

**Goal:** Build the approved opt-in automatic native-scale recovery experiment,
with repeatable corrections and a fixed-size owned history pair.

**Architecture:** A new pure controller separates user pinch intent from native
rotation scale. Share browser ownership/identity operations and settled geometry
with the existing manual probe, without changing its policy. Schema-4 evidence
and independent controls expose current state, corrections and stop reasons.

**Tech Stack:** Next.js/React/TypeScript, History and VisualViewport APIs,
existing Node tests, Playwright and GitHub Actions.

---

## Task 1: Test-first policy and isolated route

**Create:** `tests/automatic-native-recovery.test.mjs`.
**Modify:** `.github/workflows/markdown-typography.yml`,
`tests/viewport-diagnostics.spec.ts`.

- [x] Add deterministic controller fixtures using this port contract:

```ts
type AutoPorts = {
  read(): ProbeObservation & {
    scrollWidth: number; overlay: boolean; entryCycle: number | null;
  };
  checkpoint(): void;
  back(): void;
  rearm(): void;
  publish(evidence: AutoProbeEvidence): void;
};
// createAutomaticNativeRecovery(ports) returns:
// arm(), stop(), observe(event), evidence().
// Events reuse ProbeEvent, with focus notifications added.
```

Write cases for repeated correction/re-arm at constant length 2; original
versus deliberately non-unit intent; inconsistent widths; duplicate and
superseded orientation epochs; no resize-only correction; contact/focus
cancellation; fixed deadlines; wrong history/DOM/URL; overlay interference;
stop before/after history acknowledgment; history exceptions and live
terminal evidence.

- [x] Add the failing route contract:

```ts
await open(page, 'baseline', '/diagnostics/viewport-auto');
await expect(page.getByRole('button', {
  name: 'Enable automatic recovery',
})).toBeVisible();
await expect(page.locator('meta[name="viewport"]'))
  .not.toHaveAttribute('content', /minimum-scale|maximum-scale/);
```

- [x] Include the new Node file in the existing contract step. Commit with
  `[skip ci]`, push, then dispatch:

```bash
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

Expected red: missing automatic controller and route. Record the exact run.

## Task 2: Shared geometry and browser ownership

**Create:** `app/features/diagnostics/nativeViewportPolicy.ts`,
`app/features/diagnostics/nativeHistoryBrowser.ts`.
**Modify:** `nativeHistoryProbe.ts`, `useNativeHistoryProbe.ts` in the same folder.

- [x] Extract the existing finite geometry/original-scale checks and the
  300 ms / three-observation stability tracker without changing manual policy.
  Define `ViewportObservation` with scale, width, clientWidth, orientation,
  now, touches and editable fields; the manual observation extends it.
- [x] The shared browser adapter returns `read`, `checkpoint`, `back`,
  `rearm`, `captureChatIdentity`, and `setTouches`. Keep document-scoped
  ownership tokens private. Require the installed router's existing `__NA`
  ownership flag rather than creating it.
- [x] Initial checkpoint writes preserve opaque state and use:

```ts
history.replaceState({ ...state, viewportHistoryProbe: {
  token, role: 'checkpoint', cycle,
} }, '', href);
history.pushState({ ...state, viewportHistoryProbe: {
  token, role: 'working', cycle,
} }, '', href);
```

Initial admission requires length 1. Back requires the owned working entry
at length 2. Re-arm requires the owned checkpoint at length 2; increment the
cycle, restamp A, and push B, replacing only the known forward owned entry.
Recheck URL, current marker, router ownership and DOM immediately before
each operation. Exceptions propagate to the controller's visible error.
- [x] Keep passive contacts, viewport positioning, native orientation,
  popstate/hash/pagehide and focus listeners in the hook. Instantiate either
  controller by an explicit `manual | auto | null` kind. The recorder reads
  live automatic evidence, including when stopped. Cleanup never navigates.

## Task 3: Intent-aware automatic state machine

**Create:** `app/features/diagnostics/automaticNativeRecovery.ts`.

- [x] Start with the exact admission policy from the approved specification.
  `arm()` captures the initial orientation and begins bounded stable admission.
  Establish only from idle; API failure consumes the attempt.
- [x] Track `unknown | original | intentional-nonunit` separately from native
  scale. Multi-touch clears intent. After release, learn intent only from
  settled consistent geometry in the same orientation epoch. Focus invalidates
  the current assessment. Do not learn zoom intent from rotation alone.
- [x] Assess only a genuine orientation event with changed direction and
  original intent. Duplicate notifications do not move the deadline. Reset
  the stability tracker at that boundary and allow three seconds. Require:

```ts
Math.abs(width * scale - clientWidth) <= Math.max(2, scale)
  && scrollWidth <= clientWidth + 2
  && scale > 1.01
```

Also require live ownership, stable geometry, no overlay/contact/editable
focus. Already-original geometry completes assessment without navigation;
inconsistent geometry times out explicitly without retrying that epoch.
- [x] For a confirmed anomaly, issue one back, await the owned checkpoint
  within three seconds, then await native 1 plus matching width within three
  seconds. Stop on new gesture/orientation/navigation/error; never retry.
- [x] Count a stable successful correction, then synchronously recheck and
  re-arm the owned pair. Resume watching with original intent. Stop/cleanup
  must not re-arm if an already-issued native traversal completes later.
  Terminal evidence recomputes current identity and ownership.

## Task 4: Schema, controls and composition

**Modify:** `lib/viewportDiagnostics.ts`,
`app/api/diagnostics/viewport/route.ts`,
`app/features/diagnostics/viewportCapture.ts`,
`app/features/diagnostics/ViewportDiagnostics.tsx`.
**Create:** `app/features/diagnostics/AutomaticRecoveryControls.tsx`,
`app/diagnostics/viewport-auto/page.tsx`.

- [x] Version 4 adds experiment `native-history-auto` and an exact automatic
  probe shape: common phase/reason/ownership/continuity plus `intent`, `cycle`,
  `corrections`, `orientationEpoch`, `pendingAck`. Keep the manual shape
  separate and validate it against the experiment identity.
- [x] Update all fixtures and old-version rejection, including version 3.
  Do not change private storage, byte/sample limits, retries or authorization.
- [x] The route only renders `ChatPageClient`. Gate controls on its exact path
  plus baseline mode. Provide Enable, Stop, new-tab admission help, phase,
  correction count and explicit reasons. Do not touch ordinary metadata.
- [x] Preserve the current real-visual-viewport panel bounds. Continue manual
  recording unchanged except the schema version. Automatic snapshots contain
  fresh ownership/continuity results, never a stale terminal success flag.

## Task 5: Multi-cycle browser/API evidence and remote green

**Create:** `tests/automatic-native-recovery.spec.ts`.
**Create:** `tests/helpers/viewportDiagnosticFixture.ts` by extracting existing
diagnostic authentication/open/upload-file helpers; no runtime changes.
**Modify:** `tests/playwright.config.ts`, existing diagnostic tests and workflow.

- [x] Run three real History API cycles with synthetic native metrics and
  assert length 2, increasing cycles/corrections and unchanged document/chat
  handles. Preserve opaque state, selected chat, draft, attachment and an
  ongoing controlled response; no additional document request or duplicate
  send/resume. Synthetic metrics prove policy, not iOS scale recovery.
- [x] Exercise deliberate non-unit pinch, wrong/overflow geometry, keyboard
  resize without orientation, new contact during assessment, external Back,
  mobile overlay history, explicit Stop and late acknowledgment.
- [x] Persist a three-cycle mobile Chromium CDP native-scale observation.
  Use real scale changes, not a replaced VisualViewport; record whether
  actual native restoration/re-arm succeeds without claiming iOS equivalence.
- [x] Send automatic evidence through the real upload endpoint and verify
  schema/privacy, invalid enum/shape and stale payload failures. Keep normal
  and manual routes' history/gating contracts.
- [x] Dispatch the production-origin workflow and inspect failures. Run no
  local installs, builds, type checks or tests. All existing regression
  selectors remain, with an explicit automatic browser step.
- [x] Record exact source/run/results and self-review against the spec.
- [x] Obtain separate deployment authorization after green. Do not deploy or
  assert physical automatic success before that gate.

## Execution Record

- Written specification `31db05a` approved; user selected direct inline
  implementation. Existing PROD remains manual candidate `7104363`.
- Plan review: covers intent, geometry inconsistencies, repeatable bounded
  history, interruption/ownership, live evidence, private upload, multi-cycle
  continuity, remote-only validation and separate physical/deployment gates.
- Red `c0e0510`, Actions `35426259766`: expected missing automatic module and
  route failures.
- Implementation `bb4a738`, Actions `35426506937`: Node policy/schema cases,
  builds, manual diagnostics, and three-cycle native Chromium mechanism
  coverage passed. Automatic browser failures all concerned a menu-close
  assertion expecting its old history entry to have been consumed.
- `6ae83e7`, Actions `35426784373`: conservative guards were added for
  unattributed pre-rotation zoom and a freshly settled baseline after focus
  exit. Waiting for asynchronous traversal did not fix the menu-close test.
  Inspection established a pre-existing behavior: `ChatShell` passes its
  close callback directly as `onClick`; `useMobileOverlayState.close` treats
  the received truthy click event as `fromHistory`, closing the panel without
  calling back. This was not introduced by automatic recovery.
- Scope decision: leave that existing close-button behavior unchanged.
  Exercise the approved browser-Back boundary instead: open the real mobile
  overlay, assert automatic recovery stops and leaves its entry untouched,
  then use browser Back and verify the overlay's own listener closes it,
  with no automatic re-arm or history growth. This does not claim to fix
  the ordinary menu-close path.
- Final source `e92742854b7780ac01ab0323dd80eb8c437341f3`, Actions
  [35427133737](https://github.com/xujxu/agents-chat/actions/runs/35427133737):
  all three jobs succeeded. All installs, builds, type checks and tests ran
  remotely; no local validation was executed.

| Coverage | Desktop Chromium | Android Chromium | iPhone WebKit |
| --- | ---: | ---: | ---: |
| Node policy/schema/storage | 34 | not scheduled | not scheduled |
| Typography behavior | 8 | 7 | 7 |
| Emitted typography policy | 1 | 1 | 1 |
| Diagnostic API/browser | 17 | 17 | 16 |
| Automatic recovery | 6 | 7 | 6 |
| Existing desktop/mobile regressions | 17 | 31 | 31 |
| Build and TypeScript | passed | passed | passed |

- Total: 207 passing test executions and eight explicit project-specific
  skips. Desktop/Android/iPhone totals are 83/63/61 including the Node suite.
- Downloaded the final Android artifact, not an earlier candidate. Its
  `automatic/.../native-automatic-cycles.json` records three real Chromium
  native outcomes: scale 1; visual/client widths 832/832, 428/428, 832/832;
  cycles 1/2/3; history length 2 throughout. This is CDP mechanism evidence,
  not physical iOS Chrome acceptance.
- Candidate desktop artifact:
  `typography-e92742854b7780ac01ab0323dd80eb8c437341f3-desktop-chromium`,
  artifact ID `10579601845`, containing the revision-specific standalone
  archive. Any authorized deployment must use this exact tested source,
  rather than a later documentation-only HEAD.
- Self-review: the opt-in route is isolated; normal/manual route contracts
  pass; native pinch remains passive; no reload, scale lock or inverse visual
  compensation is added. The controller checks live ownership and identity,
  uses fixed deadlines, stops on navigation/input interruption and does not
  retry failed recovery or re-arm after Stop. Repeated state-machine and
  browser cycles retain the owned pair without accumulating entries.
- Handoff gate: implementation and remote validation are complete. PROD
  at this point still ran manual source `7104363`; automatic deployment and
  physical repeated-pinch/rotation acceptance required separate gates. Extra Back history,
  fresh-tab admission, possible transient enlargement and unsupported
  intentional non-unit rotation behavior remain explicit trial limitations.

## Authorized Production Deployment

- User explicitly approved: "同意，部署到现有 PROD 供真机验证".
- Deployed the exact successful `e92742854b7780ac01ab0323dd80eb8c437341f3`
  artifact from Actions `35427133737`, not documentation-only HEAD.
  Production build ID: `tXSys2qtUz0Jp1f8Kf-Or`.
- Swapped only `.next`; preserved host dependencies, environment and data.
  Both databases were backed up with the SQLite backup API. Previous build
  and database backups are retained under
  `.data/deployments/viewport-auto-e927428/`.
- Service `agents-chat` is active/running (observed PID `42869`). Local/public
  HTML and exact stylesheet bytes match; both typography declarations
  remain present. Public client JavaScript matches the tested revision.
  Manual and automatic routes enforce login; unauthenticated uploads return
  401; both databases remain readable.
- No local build, test, type check or installation was performed. These were
  deployment integrity and production health checks only.
- Physical handoff URL:
  `https://agent.xujx.us.kg/diagnostics/viewport-auto?viewportDiagnostics=baseline`.
  Open a fresh tab, enable once at 100%, and repeat pinch-back/rotation
  sequences without using the manual Restore control. Upload the recording
  whether automatic recovery succeeds or stops. Physical automatic
  acceptance remains pending; ordinary chat still does not enable recovery.

## First Automatic Physical Recording

- Upload `3a33307d-f8dc-4fc5-a0af-c6191d056c5e`, received
  `2026-09-19T06:54:37.056Z`: correct deployed build/revision, schema 4,
  iOS 18.7.8 / Chrome 153.0.8010.24, 74 samples, zero drops.
- Enabled successfully at 11.009 seconds. All live document/shell/composer
  identity and history ownership flags remain true after enablement.
- The initial pinch reached 2.762234. The subsequent inward gesture released
  near 1.088137, then settled at **1.168340**, visual/document widths
  **366/428**, at 18.367 seconds. There is no settled 100% baseline after this
  gesture and before the first rotation at 31.683 seconds.
- The controller therefore retained `intentional-nonunit`, as specified.
  Eight orientation boundaries occurred, but no recovery traversal was
  requested: corrections and cycle both stayed zero. Later landscape
  readings confirm the familiar enlargement (2.163551, widths 385/832).
  Rotation alone returning the browser to scale 1 did not overwrite the
  last gesture-derived intent.
- This recording does **not** establish successful automatic recovery, nor
  failure of the native recovery operation: the non-unit intent guard kept
  that operation from running. It also shows why judging 100% by appearance
  is insufficient. The trial still needs a post-pinch, finger-released
  `1x` baseline before rotation.
- Next physical instruction: if the same tab remains `watching`, keep the
  recording and perform one new pinch/inward gesture until the panel reads
  `1x` after release for at least one second; then rotate, wait two seconds
  and upload. If scale cannot settle at `1x`, upload that condition without
  proceeding to rotation. No code/deployment change follows from this log.
