# Chrome Minimum-Scale Candidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a protected, independent minimum-scale diagnostic candidate without changing the ordinary page's viewport policy.

**Architecture:** Share existing viewport defaults and override only the new route's static minimum. Reuse the chat composition and diagnostic recorder/upload pipeline. Advance the log schema so the actual declared minimum is unambiguous.

**Tech Stack:** Next.js static viewport exports, existing React diagnostics, Node tests, Playwright, GitHub Actions.

---

The user explicitly selected direct implementation and authorized deployment.
Continue inline without subagents; the execution skills in the template are
not installed. All builds/tests run in Actions, never locally.

## Task 1: Test-First Contract and Route Coverage

**Modify:** `tests/viewport-diagnostics.test.mjs`,
`tests/viewport-diagnostics.spec.ts`.

- [x] Change test payloads to version 2 and add the schema assertions:

```js
test('v2 records the declared minimum and rejects stale v1 payloads', () => {
  assert.ok(METRIC_KEYS.includes('viewportMinimumScale'));
  const candidate = log();
  candidate.initial.metrics.viewportMinimumScale = 1;
  assert.equal(validateDiagnosticLog(candidate), true);
  assert.equal(validateDiagnosticLog({ ...candidate, version: 1 }), false);
});
```

- [x] Extend the browser fixture's `open` helper with a pathname argument
  defaulting to `/`. Continue using credentials-admin cookies, real session
  validation, and the existing synthetic chat.
- [x] Add a cold-response/browser test for both `/` and
  `/diagnostics/viewport-minimum`. Require status 200 and exactly one
  `<meta name="viewport">`. Require width=device-width, initial-scale=1,
  and interactive-widget=resizes-content in both. Require minimum-scale=1
  only in the candidate; neither permits maximum-scale or user-scalable=no.
  Compare the hydrated tag's content to the actual HTTP response.
- [x] Upload from the candidate through the real endpoint, read the saved
  file using the existing helper, and require version 2 and minimum 1 in
  initial/subsequent samples. Require the normal page's minimum to be null.
- [x] POST a version-1 body as the CI admin and require a 400 error
  instructing the user to reload. Never accept an old log as the new mode.
- [x] Commit tests, dispatch workflow 361358759 with production origin,
  and preserve the failing run before the production implementation.

## Task 2: Static Route and Shared Defaults

**Create:** `app/features/layout/appViewport.ts`.

- [x] Use the existing policy unchanged:

```ts
import type { Viewport } from 'next';

export const APP_VIEWPORT: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
};
```

**Modify:** `app/layout.tsx`.

- [x] Import `APP_VIEWPORT` from `./features/layout/appViewport` and
  replace only the existing viewport object with:

```ts
export const viewport: Viewport = APP_VIEWPORT;
```

**Create:** `app/diagnostics/viewport-minimum/page.tsx`.

- [x] Keep the route a server-side composition shell:

```tsx
import type { Viewport } from 'next';
import { ChatPageClient } from '../../features/chat/ChatPageClient';
import { APP_VIEWPORT } from '../../features/layout/appViewport';

export const viewport: Viewport = { ...APP_VIEWPORT, minimumScale: 1 };

export default function ViewportMinimumPage() {
  return <ChatPageClient />;
}
```

No modification to `app/page.tsx`, middleware, shell synchronization,
viewport-fit, safe-area rules, or responsive breakpoints.

## Task 3: Unambiguous Diagnostic Policy

**Modify:** `lib/viewportDiagnostics.ts`,
`app/features/diagnostics/viewportCapture.ts`,
`app/features/diagnostics/ViewportDiagnostics.tsx`,
`app/api/diagnostics/viewport/route.ts`.

- [x] Add `viewportMinimumScale` to `METRIC_KEYS`; change the log's
  literal `version` type and validator requirement from 1 to 2.
- [x] In capture, parse only the numeric minimum from the actual meta
  content; never upload the raw content string:

```ts
const viewportContent = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content;
const minimum = viewportContent?.match(/(?:^|,)\s*minimum-scale\s*=\s*(\d+(?:\.\d+)?)\s*(?:,|$)/i);
metrics.viewportMinimumScale = minimum ? Number(minimum[1]) : null;
```

- [x] Initial logs declare version 2. Add the metric to the panel's
  reading state, initialized null and updated from both initial and later
  samples. Show `Minimum: 1` or `Minimum: unspecified` without changing
  layout or writing viewport state.
- [x] Before generic schema validation, explicitly reject a version-1
  object with `DiagnosticError(400, 'outdated_log', 'Reload the diagnostic
  page and collect a new log before uploading.')`.
  Preserve all existing strict validation and storage behavior.
- [x] Run the same contract/body/storage/browser suite remotely and
  retain the ordinary-page regressions. Commit with the required trailer.

## Task 4: Remote Validation and Deployment

- [x] Use the existing workflow's production-origin dispatch:

```bash
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

- [x] Require Node tests, three builds/type checks, real HTTP/UI diagnostic
  cases, and existing typography/keyboard/desktop suites to pass.
- [x] Download the exact SHA's desktop archive. Update the session
  deployment script's SHA, artifact path, and fresh backup directory.
  Also require `/diagnostics/viewport-minimum/page` in the archive's
  route manifest before cutover.
- [x] Preserve the existing database backup, `.next`-only swap, public
  CSS comparison, anonymous-upload protection, and rollback checks.
  Verify the archived candidate HTML has minimum 1 while ordinary HTML
  does not; neither has a maximum-scale lock.
- [x] Persist the deployed build/revision/run in this document and hand
  off the candidate and ordinary baseline links. Physical success and
  promotion to ordinary PROD remain pending.

## Self-Review

The static minimum is the only experimental page behavior. The recorder
reads it rather than assuming it from a URL. Old log rejection is explicit,
and previous saved evidence remains untouched. The existing real browser
upload tests continue to verify the administrator identity after refresh.
No native rotation success can be inferred from CI.

## Execution Record

Test-first revision `8073124` ran in
[35412970354](https://github.com/xujxu/agents-chat/actions/runs/35412970354).
The new contract checks failed on the absent minimum metric/version-2
contract, and mobile HTTP coverage confirmed the candidate route returned
404 before implementation. Existing source and geometry checks still passed.

Candidate revision `29195d07b7790cb0cb2e3f62dbcfcb3dce9a8c5f` passed
[35413190978](https://github.com/xujxu/agents-chat/actions/runs/35413190978):
9 Node cases, 28 diagnostic browser/API cases, and 104 existing
typography/mobile/desktop cases. All three builds/type checks passed.
Cold HTTP and hydrated viewport metadata agree across all three engines;
real uploads preserve the declared minimum and schema version.

The production-origin artifact was deployed with Next build ID
`7McKDvj0HPkvJSTMzIGih`. The preceding diagnostic build and consistent
database backups are in `.data/deployments/viewport-minimum-29195d0/`.
Archive inspection confirmed that only the candidate HTML contains
minimum-scale=1, neither page has a maximum-scale lock, and both protected
routes are present. Public/local CSS assets match the deployed files and
retain the iOS text-adjust prefix; anonymous upload still returns 401.
The service is active and existing databases remain readable.

No local build or test was run. Previously uploaded version-1 files remain
in the private diagnostic directory. New captures use version 2; old open
tabs must reload and recollect rather than retry a stale snapshot.

Physical handoff:

- Candidate: `https://agent.xujx.us.kg/diagnostics/viewport-minimum?viewportDiagnostics=baseline`
- Ordinary control: `https://agent.xujx.us.kg/?viewportDiagnostics=baseline`

Freshly open both in Chrome. The panel should show `Minimum: 1` on the
candidate and `Minimum: unspecified` on the control. Repeat the same
pinch-return-to-original-size and rotation sequence, then upload each log.
Also check retained intentional magnification before considering promotion.
The native outcome remains pending, and the ordinary viewport policy has
not changed.

### Physical Result: Candidate Rejected

Two subsequent Chrome uploads from client `29195d0` and server build
`7McKDvj0HPkvJSTMzIGih` contain complete version-2 traces without dropped
samples. The candidate records `viewportMinimumScale=1` throughout;
the ordinary control records null. Neither trace involves input focus.

Both independently settle at scale 1 and visual width 428 before rotation,
then reach scale `2.1635513305664062` with visual width 385 in landscape.
Both return to scale 1 in portrait. Document client/scroll widths agree
at 428/832 respectively, and the mobile layout query remains active.

The explicit minimum is therefore present but ineffective for the reported
sequence. Reject promotion to the ordinary page. Keep the candidate isolated
as evidence, without adding a maximum-scale lock or a forced reset.
The earlier OpenClaw comparison concerned orientation behavior; whether it
also reproduces this specific pinch-return-to-100%-then-rotate sequence on
the same Chrome remains unverified.

The user subsequently confirmed that OpenClaw also enlarges the whole page
under this exact sequence in the same Chrome. This is a visual confirmation,
not an uploaded OpenClaw geometry trace. It establishes a cross-application
reproduction; OpenClaw is not a working counterexample for this scenario.
Its normal-flow shell and cover policy therefore cannot simply be copied
and claimed to solve the reported behavior.

The remaining issue is unresolved. Neither tested application-side
candidate prevented it. The standard
[VisualViewport.scale API](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport/scale)
is read-only; there is no supported assignment to set the browser's native
pinch scale through that property. No reliable site-side correction that
preserves intentional pinch zoom has been established. Do not represent
this as proof that every possible browser-specific workaround is impossible,
or that updating Chrome is known to fix it.

Ordinary PROD retains the confirmed Markdown correction and unchanged
viewport policy. Native Chrome correction is blocked on a verified upstream
resolution or an independently justified and validated compatibility
approach. Safari is the user's verified unaffected alternative. Keep the
diagnostic routes opt-in and do not promote either rejected candidate.
