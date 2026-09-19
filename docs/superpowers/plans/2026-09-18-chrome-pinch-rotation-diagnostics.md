# Chrome Pinch Rotation Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an opt-in, administrator-uploadable viewport recorder and a single-variable comparison without changing ordinary PROD behavior.

**Architecture:** A diagnostics feature owns bounded in-memory capture and its panel. A narrowly scoped layout gate suppresses existing shell writes only in the explicitly selected isolated mode during pinch/non-default scale. A thin authenticated route saves strict allowlisted JSON through a private, bounded filesystem store.

**Tech Stack:** Existing Next.js/React/TypeScript, Node built-in test runner, Playwright, GitHub Actions; no new packages.

---

The user approved the written specification and PROD deployment using an
administrator account. Continue inline without subagents; the execution
skills named in the template are not installed. All builds and tests below
run only in Actions. Local work is editing, Git, artifact inspection, and
authorized operational deployment.

## Files and Interfaces

| File | Responsibility |
| --- | --- |
| `lib/viewportDiagnostics.ts` | Shared metric keys, types, strict validator, bounded recorder, mode/gate helpers, byte limit |
| `lib/viewportDiagnosticStore.ts` | Private directory verification, serialized retention/cap/write, bounded HTTP body reader |
| `app/api/diagnostics/viewport/route.ts` | Origin/auth/content-type/input checks and explicit JSON responses |
| `app/features/diagnostics/viewportCapture.ts` | Read-only DOM/viewport snapshots and parsed environment metadata |
| `app/features/diagnostics/ViewportDiagnostics.tsx` | Opt-in lifecycle, coalescing, settling, upload/retry UI |
| `app/features/diagnostics/ViewportDiagnostics.css` | Compact fixed diagnostic panel without changing document flow |
| `app/features/layout/components/ChatShell.tsx` | Mount the named diagnostic export and gate only existing viewport writes |
| `tests/viewport-diagnostics.test.mjs` | Node contract/recorder/body/store tests |
| `tests/viewport-diagnostics.spec.ts` | Built-app HTTP API and browser interaction coverage |
| `tests/helpers/visualViewport.ts` | Optional synthetic scale argument, retaining existing default scale 1 |
| `tests/playwright.config.ts` | Include the diagnostic spec in the two mobile projects |
| `.github/workflows/markdown-typography.yml` | Remote Node tests and cross-engine diagnostic coverage alongside existing regressions |

## Task 1: Contracts and Red Tests

- [ ] Write Node tests first. Import the new TypeScript helpers directly from
  `.test.mjs`, using Node 24's type stripping. Tests initially fail because
  the module does not exist; preserve the Actions run.

Required assertions include:

```js
assert.equal(parseDiagnosticMode(null), null);
assert.equal(parseDiagnosticMode('baseline'), 'baseline');
assert.equal(parseDiagnosticMode('isolated'), 'isolated');
assert.equal(parseDiagnosticMode('unknown'), null);
assert.equal(shouldPauseViewportSync('baseline', true, 2), false);
assert.equal(shouldPauseViewportSync('isolated', true, 1), true);
assert.equal(shouldPauseViewportSync('isolated', false, 2), true);
assert.equal(shouldPauseViewportSync('isolated', false, 1), false);
```

- [ ] Define `METRIC_KEYS` as an immutable list and derive
  `MetricName` / `Record<MetricName, number | null>` from it. Include raw
  scale, viewport/window/document/screen dimensions, offsets, DPR, shell
  CSS values, and four rectangles. Do not use open-ended payload objects.
- [ ] Define sample fields `t`, `event`, `gesture`, `focus`, `orientation`,
  `mobile`, and `metrics`. Define log fields `version: 1`, `mode`,
  `browser`, `browserVersion`, `osVersion`, `clientRevision`, `assets`, `initial`,
  `samples`, and `dropped`.
- [ ] Validate exact keys recursively. Reject unknown keys, arbitrary
  strings, non-finite/out-of-range numbers, more than 256 subsequent
  samples, non-monotonic timestamps, and invalid asset paths. Require
  `initial.event === 'initial'` and `initial.t === 0`.
- [ ] Keep the initial sample separate from the ring. Snapshot arrays must
  not change when subsequent records arrive. Preserve dropped counts.
- [ ] Use these mode/gate implementations:

```ts
export type DiagnosticMode = 'baseline' | 'isolated';

export function parseDiagnosticMode(value: string | null): DiagnosticMode | null {
  return value === 'baseline' || value === 'isolated' ? value : null;
}

export function shouldPauseViewportSync(
  mode: DiagnosticMode | null, gesture: boolean, scale: number | undefined,
): boolean {
  return mode === 'isolated' && (gesture || (scale !== undefined && Math.abs(scale - 1) > 0.01));
}
```

- [ ] Run remotely, initially expecting an import failure:

```bash
node --experimental-strip-types --test tests/viewport-diagnostics.test.mjs
```

## Task 2: Bounded Storage and HTTP API

- [ ] Add failing tests for 256 KiB body limits including absent/misleading
  Content-Length, malformed JSON, unknown fields, and invalid numeric data.
- [ ] Add temporary-directory tests: exclusive UUID files, file mode 0600,
  directory mode 0700, preserved unrelated files, seven-day cleanup,
  refusal at 100 logs, symlink rejection, and concurrent uploads.
  Delete only each test's exact `mkdtemp` directory in `finally`.
- [ ] Implement directory creation component-by-component beneath
  `process.cwd()`: `.data`, `tmp`, `viewport-diagnostics`. `lstat` each
  component and reject links/non-directories; do not chmod unrelated
  existing `.data` directories. Require the final directory to be private.
- [ ] Serialize prune/count/write through a module-level promise queue.
  Count UUID `.json` entries toward the cap, ignore unrelated names, and
  never follow symlinks. Prune only regular files older than seven days.
  Use `crypto.randomUUID()`, exclusive creation, and mode 0600.
  If writing/closing fails, remove only the exact newly created file and
  propagate the error.
- [ ] Read `.next/BUILD_ID` as a separate server identity; do not label it
  the client's build identity. Store `{ receivedAt, serverBuildId, log }`.
- [ ] Implement `POST /api/diagnostics/viewport`: shared `getAuthToken` /
  `isAdminToken`, required Origin matching configured `NEXTAUTH_URL`,
  JSON content type, then streamed byte cap and strict schema.
- [ ] Return 201 `{ ok: true, id }`; return explicit JSON errors:
  401 unauthenticated, 403 admin/origin denied, 415 content type, 413 byte
  limit, 400 malformed/schema, 507 storage capacity, 500 operational error.
  Use the existing logger for failures, never the request body. Set
  `Cache-Control: no-store`.
- [ ] Add real API requests against the built app, including successful
  persistence and signed non-admin-session rejection. Tests may use the
  known CI-only secret to sign a test cookie; never production credentials.
- [ ] Run the Node tests and HTTP cases remotely; keep the successful file
  evidence in CI only. No log retrieval/listing endpoint is added.

## Task 3: Capture and Upload Panel

- [ ] Add browser tests for absent ordinary-mode UI/network traffic, explicit
  baseline/isolated modes, successful upload, 403/server/network failures,
  retained-snapshot retry, and bounded sample content.
- [ ] Capture only fixed metric selectors: `.chatPageRoot .page`,
  `.header`, `.chatContainer`, `.composerTextarea`. Missing elements/APIs
  become null metrics. Never serialize DOM, input values, arbitrary URLs,
  target attributes, chat IDs, or console messages.
- [ ] Extract browser/OS numeric versions with bounded regexes; do not
  upload the raw user agent. Capture only same-origin `/_next/static/`
  CSS path identifiers without query strings or fragments.
- [ ] Keep the sampler/recorder in an effect. Initial time is zero;
  subsequent timestamps use `performance.now() - start`.
  Capture touch start/end/cancel and orientation immediately.
  Coalesce viewport/window resize and scroll per animation frame.
  Schedule a bounded settling sample after 300ms without such an event.
  Clean up every listener/frame/timer on unmount.
- [ ] Gesture tracking reads only touch count. Native gesture listeners
  remain passive, and no event uses `preventDefault()`.
- [ ] The panel mounts only when the query value is recognized. The normal
  page must not install recorder listeners or send diagnostics requests.
- [ ] On upload, freeze a snapshot, POST with same-origin credentials, and
  require both a successful status and a valid `{ ok: true, id }`.
  Preserve a failed snapshot for retry; after success a new click may
  capture a newer snapshot. Surface HTTP/network/storage failures in an
  accessible live region.
- [ ] The fixed panel uses a bounded width, a readable non-input scale
  label, and buttons without autofocus. Explain that diagnostic mode is
  optional and no chat text is uploaded. Do not modify viewport metadata.

## Task 4: Single-Variable Shell Experiment

- [ ] Extend the existing viewport mock with an optional scale argument
  defaulting to 1. Assert baseline still writes height at scale 2 and
  isolated mode does not; assert writes resume at scale 1 after release.
- [ ] In `ChatShell`'s existing effect, parse the query once. Add passive
  touch-count tracking only for isolated mode. Before existing style writes,
  return only when `shouldPauseViewportSync(mode, gesture, scale)` is true.
  On final touch end/cancel, resynchronize through the same guarded path.
- [ ] Mount `<ViewportDiagnostics />` as composition only. Keep the
  existing mobile breakpoint, focus logic, CSS, and scroll ownership.
- [ ] Run all existing Markdown/keyboard/overlay/desktop regressions.
  Synthetic scale is evidence for application logic, not native Chrome.

## Task 5: Remote Validation and Authorized Deployment

- [ ] Extend the existing workflow: Node tests before build on desktop,
  diagnostic spec on all three engines. Existing 104 applicable checks
  remain enabled, including emitted iOS CSS prefix checks.
  Embed `NEXT_PUBLIC_VIEWPORT_DIAGNOSTICS_REVISION=${{ github.sha }}` at
  build time so old tabs remain identifiable independently of upload time.
- [ ] Commit with a Copilot trailer. Use `[skip ci]` when manually
  dispatching production-origin validation to avoid duplicate builds:

```bash
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

- [ ] Require the exact SHA's Actions jobs to pass. Download the matching
  desktop standalone archive and record the run/commit in this plan.
- [ ] Adapt the existing session deployment script to the new revision,
  artifact directory, and a fresh `.data/deployments/` location.
  Preserve `.env.local`, installed native dependencies, systemd, and DB
  paths. Back up both databases, swap only `.next`, and keep automatic
  rollback plus local/public asset verification.
- [ ] Verify public health and anonymous diagnostic POST rejection without
  creating a production test log or using production login credentials.
  The user's authorized manual upload provides the real diagnostic log.
- [ ] Hand off the baseline and isolated URLs and the upload button.
  Record deployment as done, root-cause diagnosis and native fix as pending.
  Read the identified uploaded files when the user reports completion.

## Self-Review

The contract, storage, API, UI, shell gate, remote tests, and deployment each
have a bounded owner. No new dependency, scale lock, shell rewrite, public
log endpoint, automatic upload, or unapproved data collection is required.
Administrator-only upload and the fixed temporary path were approved during
the written-spec review. Implementation proceeds inline as previously chosen.

## Execution Record

Test-first revision `fb09cb1` ran in
[35410794947](https://github.com/xujxu/agents-chat/actions/runs/35410794947).
The new Node suite failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created
diagnostic contract module. Existing mobile jobs retained their passing
Markdown and UX checks. No local test or build was used.

Implementation run
[35411208056](https://github.com/xujxu/agents-chat/actions/runs/35411208056)
passed Node contracts, builds, and the direct HTTP contract, but browser
uploads received 403. The browser fixture used an administrator role with
a non-admin subject; the existing NextAuth session callback correctly
reclassified that synthetic account. The fixture now uses the actual
credentials-admin identity and explicitly checks the refreshed session.
Production authorization was not weakened.

Revision `383453638c87b4b85fdca1db0a304cb4fce3d4ff` passed
[35411480317](https://github.com/xujxu/agents-chat/actions/runs/35411480317):

| Coverage | Result |
| --- | --- |
| Node contracts, bounded body reader, recorder, private storage | 8 passed |
| Desktop diagnostic browser/API cases | 7 passed |
| Android diagnostic browser cases | 6 passed |
| iPhone WebKit diagnostic browser cases | 6 passed |
| Existing typography/mobile/desktop cases | 104 passed |

All three builds/type checks passed. Native iOS Chrome pinch/rotation is
still awaiting physical evidence; synthetic viewport tests are not a fix
claim.

The exact production-origin artifact was deployed to
`https://agent.xujx.us.kg`, with Next build ID `Jln2zPkPRO9cHxj1C3txX`.
The previous build and consistent database backups are retained under
`.data/deployments/viewport-diagnostics-3834536/`.
Local/public stylesheet bytes match the artifact, the iOS typography prefix
remains present, and anonymous public diagnostic POSTs return 401.
The systemd service is active and both existing databases remain readable.
No local build, dependency installation, type check, or browser test ran.

Physical collection links:

- Baseline: `https://agent.xujx.us.kg/?viewportDiagnostics=baseline`
- Isolated comparison: `https://agent.xujx.us.kg/?viewportDiagnostics=isolated`

Use each link in a fresh Chrome page, perform the reported gesture/rotation
sequence, and press **Upload diagnostic log** without first correcting any
unexpected enlargement. Repeat baseline in Safari for comparison.
Uploaded files are created lazily in `.data/tmp/viewport-diagnostics/`.
The normal application URL does not enable recording or the experimental
gate. Root-cause analysis resumes after the user supplies the uploaded IDs.

### Physical Log Analysis

Four uploads from the deployed `3834536` client and
`Jln2zPkPRO9cHxj1C3txX` server were inspected on 2026-09-19.
No samples were dropped. All samples during the reported gesture/rotation
sequence have no focused editable element.

| Browser / mode | Settled before rotation | Settled landscape | Return to portrait |
| --- | --- | --- | --- |
| Chrome / baseline | scale 1, visual width 428 | scale 2.1635513305664062, visual width 385 | scale 1 |
| Chrome / isolated | scale 1, visual width 428 | scale 2.1635513305664062, visual width 385 | scale 1 |
| Safari / baseline | scale 1, visual width 428 | scale 1, visual width 832 | scale 1 |
| Safari / isolated | scale 1, visual width 428 | scale 1, visual width 832 | scale 1 |

Chrome baseline was settled at scale 1 for over five seconds before rotation;
the isolated case for over three seconds. Both landscape scale values match
`926 / 428` within `7.2e-8`. Document client/scroll widths agree at 428 in
portrait and 832 in landscape. The 900px layout query stays mobile in both
orientations, so this reproduction is not a mobile/desktop breakpoint switch.

The isolated gate demonstrably worked: its landscape shell height remained
751 while the baseline shell followed the zoomed visual height down to 172.
Nevertheless, both Chrome runs reached the exact same page scale. Therefore
suppressing these shell writes is not a solution and must not be promoted
to ordinary behavior.

The exact
[Chromium 153.0.8010.24 source](https://github.com/chromium/chromium/blob/153.0.8010.24/ios/web/web_state/ui/crw_web_controller_container_view.mm#L226-L245)
handles size-class changes by scheduling a native scroll-view zoom reset to
`minimumZoomScale` after 100ms. Its
[earlier corrective change](https://github.com/chromium/chromium/commit/b911298b8f6b242e805baff87209d102101e6670)
explicitly discusses native WebView zoom-state inconsistency and rotation
timing. This is relevant primary-source evidence, not proof that a specific
native callback caused these four recordings.

OpenClaw's pinned
[viewport metadata](https://github.com/openclaw/openclaw/blob/6c6dc44250d66eb8ec84f949c4a433c2dfcd8059/ui/index.html#L5-L8)
includes `viewport-fit=cover`, unlike the current app. Its root shell is also
in normal flow. Neither difference has yet been isolated for this specific
pinch-return-to-100% sequence. Adopting cover would expand this landscape
layout from 832 toward 926 CSS pixels, crossing the existing 900px breakpoint
and requiring safe-area handling; it is not a one-line production substitute.

The confirmed defect is native whole-page scale change after returning to
scale 1, not renewed Markdown font inflation. A declared minimum-scale
candidate or a root-flow change remains an experiment until independently
verified on the affected phone. Do not use a maximum-scale lock, forced
rotation reset, or CSS inverse scaling as a presumed fix.
