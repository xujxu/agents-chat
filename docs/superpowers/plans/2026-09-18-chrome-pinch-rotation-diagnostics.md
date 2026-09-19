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
  `browser`, `browserVersion`, `osVersion`, `assets`, `initial`,
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
