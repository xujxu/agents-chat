# iOS Chrome Pinch-and-Rotation Diagnostics

## Status and Scope

The user confirmed that deployed revision `79781d5` fixes Markdown font
inflation during rotation. A separate whole-page enlargement remains on
iOS 18.7.8 / Chrome 153.0.8010.24 after pinch enlargement, returning to
the original size, releasing the gesture, and rotating. It also occurs
without focusing an input and after waiting approximately two seconds.
Safari does not exhibit this symptom.

The user approved an evidence-first, single-variable comparison and requested
a one-click upload button so diagnostics can be inspected on the production
host. This specification covers that diagnostic phase, not an established
fix for Chrome's native zoom behavior. The user approved this written
specification and deployment to PROD, confirming administrator access.

Diagnostic revision `3834536` is deployed to PROD after remote validation.
The [implementation record](../plans/2026-09-18-chrome-pinch-rotation-diagnostics.md#execution-record)
contains the exact build, validation, rollback, and collection links.
Physical logs and the final Chrome correction are still pending.

## Findings and Limits

`ChatShell.tsx` copies visual viewport height and vertical offset into shell
CSS on viewport resize/scroll and window resize/orientation events. It does
not distinguish keyboard compression from pinch zoom. Mobile CSS fixes the
shell to those dimensions. This is a plausible feedback path, not a proven
explanation of Chrome's scale change.

`tests/helpers/visualViewport.ts` always reports scale 1. Existing geometry
tests cannot establish correct behavior for the reported native gesture.
Linux Playwright WebKit is not this iPhone's Chrome host application.

Excluded experiments previously attempted viewport scale locks and a broad
CSS-owned mobile shell. Do not restore either as a presumed solution.
Keep the deployed Markdown policy and explicit iOS compilation target.

## Diagnostic Modes and User Flow

- The ordinary URL keeps existing behavior, with no diagnostic capture,
  diagnostic controls, or upload requests.
- An explicit `viewportDiagnostics=baseline` query enables read-only capture
  while retaining the current viewport synchronization.
- An explicit `viewportDiagnostics=isolated` query enables the same capture
  and only suppresses shell height/offset writes while a multi-touch gesture
  is active or the reported scale differs from 1 by more than 0.01.
  This is an experiment, not a production fix. Do not normalize the recorded
  scale or interpret the threshold as proof that native zoom is exactly 1.
- Use separate fresh page loads for the two modes. Do not persist a selected
  mode in local storage, alter viewport metadata, or reset user zoom.
- A compact, non-layout-expanding diagnostic panel shows the active mode,
  raw scale, capture status, and an **Upload diagnostic log** button.
  It must not autofocus an input, intercept gestures, or force scrolling.
- After reproducing, one tap uploads a frozen snapshot. Display the returned
  log ID only after the server confirms a successful write. Disable duplicate
  submissions while uploading. On failure, keep the local snapshot available
  for retry and show an explicit, accessible error.
- Uploads require an authenticated administrator under the existing auth
  helpers. If the account lacks permission, show the 403 error rather than
  implying that a log was saved.

The user need not connect a debugger, copy console output, or upload a video
to provide the numerical log. A log cannot independently prove painted
pixel scale, so visible symptoms remain part of physical acceptance.

## Capture Contract and Privacy

Keep capture in memory for the current page only. Retain an initial snapshot
and a bounded ring of at most 256 subsequent samples, with a dropped-sample
count. Upload snapshots may discard additional oldest samples to meet the
256 KiB byte budget, retaining the initial sample and recording the additional
drops. Raw scale is never rounded to make the payload smaller.
Coalesce high-frequency resize/scroll samples per animation frame;
preserve gesture boundaries, orientation changes, and post-event settling
observations. Stop and clean up listeners/timers when the component unmounts.

Allowlisted fields:

- Schema version, diagnostic mode, monotonic elapsed time, event category,
  gesture-active state, and orientation.
- Parsed browser/OS versions, device pixel ratio, screen dimensions, and
  first-party compiled CSS asset identifiers for revision matching. The
  Actions build also embeds its public commit SHA as `clientRevision`,
  separate from the receiving server's build ID; other builds report null.
- Raw visual viewport scale, width, height, and offsets; window inner
  dimensions; document client/scroll dimensions.
- Bounding rectangles for the shell, header, transcript, and composer;
  shell viewport CSS values; the current mobile-layout query result.
- Focus category (`none`, `editable`, or `other`), not an element's text,
  name, value, attributes, or arbitrary selector.
- Explicit unavailable values when an API or element is absent.

Never collect chat content, input values, DOM HTML, cookies, tokens, account
identity, chat IDs, arbitrary URLs/query strings, network bodies, or general
console logs. No automatic upload and no third-party destination.

## Upload and Temporary Storage

Use a same-origin JSON POST at `/api/diagnostics/viewport`. The route validates
authentication, administrator permission, same-origin provenance, JSON
content type, and a streamed request-body limit of 256 KiB. Do not rely on
Content-Length alone. Strictly validate the allowlisted schema, numeric
bounds, event count, and string enums; reject unexpected fields.

Keep the route thin. A server helper owns validation and storage. Store only
validated diagnostic data, adding the server's receive time and available
Next build identity separately from client asset identity.

The fixed production directory is:

`/home/xujx/wa/agents-chat/.data/tmp/viewport-diagnostics/`

Resolve it from the server working directory, never from user-supplied paths.
Create a directory with mode 0700 and exclusively create server-generated
UUID JSON files with mode 0600. Reject symlink/non-directory destinations.
There is no HTTP log-listing or log-download endpoint.

Keep at most 100 live files. On upload, remove only this feature's regular,
UUID-named JSON files older than seven days; do not traverse links or clean
unrelated files. Serialize the cleanup, capacity check, and write within the
server process. Refuse additional writes explicitly if the cap is reached.
Retention cleanup is upload-triggered, not a background service.

Return `{ ok: true, id }` only after the file is written and closed.
Use explicit JSON errors for authentication, permission, invalid input,
oversize input, capacity, and filesystem failures. Log operational failures
through the existing server logger without logging request bodies.
The directory is already excluded by the repository's `.data/` ignore rule.

## Component Boundaries

- `app/features/diagnostics/` owns opt-in capture, the upload client, the
  diagnostic panel, and the bounded comparison-mode interface.
- Layout retains responsibility for shell viewport synchronization. Its
  experimental gate changes only the existing height/offset writes, not
  breakpoints, scroll ownership, keyboard focus, or viewport metadata.
- `lib/` owns shared serializable contracts and focused server helpers;
  browser code must not import filesystem modules.
- `app/api/diagnostics/viewport/route.ts` performs HTTP/auth orchestration.
- Keep `app/page.tsx` and `ChatPageClient.tsx` as composition shells.

## Remote Validation and Evidence Gate

All dependency installation, builds, type checks, and tests run in Actions.
Use test-first coverage for the bounded recorder, validation, storage, and
experimental gate, using existing Node/Playwright infrastructure.

API coverage must make real requests to the built application, including
unauthenticated/non-admin requests, foreign origins, malformed/oversize
payloads, rejected unexpected data, successful persistence, and storage
failure/cap handling through focused helper tests where appropriate.
Do not substitute source regex checks for API behavior.

Playwright covers ordinary-mode non-interference, mode selection, gesture
state transitions, upload success/failure/retry, and preserved Markdown,
keyboard, overlay, draft, and desktop behavior. Synthetic scale events test
our logic only; they are not evidence of native iOS zoom correction.

After authorized deployment, collect baseline and isolated logs from the
affected Chrome with the same rotation sequence and comparable Safari logs.
Compare raw scale, document width, shell geometry, event order, gesture state,
and loaded asset identities. Inspect only the explicitly uploaded log files.

If isolating the feedback path removes the symptom, design the smallest
production correction and repeat native acceptance. If both modes fail,
investigate native/browser behavior or another measured layout cause rather
than adding a scale lock. Preserve intentional user magnification: returning
to 100% must stay at 100%, and a retained magnification must not be forcibly
reset by application code. Diagnostic deployment is not resolution.
