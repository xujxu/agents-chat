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

- [ ] Change test payloads to version 2 and add the schema assertions:

```js
test('v2 records the declared minimum and rejects stale v1 payloads', () => {
  assert.ok(METRIC_KEYS.includes('viewportMinimumScale'));
  const candidate = log();
  candidate.initial.metrics.viewportMinimumScale = 1;
  assert.equal(validateDiagnosticLog(candidate), true);
  assert.equal(validateDiagnosticLog({ ...candidate, version: 1 }), false);
});
```

- [ ] Extend the browser fixture's `open` helper with a pathname argument
  defaulting to `/`. Continue using credentials-admin cookies, real session
  validation, and the existing synthetic chat.
- [ ] Add a cold-response/browser test for both `/` and
  `/diagnostics/viewport-minimum`. Require status 200 and exactly one
  `<meta name="viewport">`. Require width=device-width, initial-scale=1,
  and interactive-widget=resizes-content in both. Require minimum-scale=1
  only in the candidate; neither permits maximum-scale or user-scalable=no.
  Compare the hydrated tag's content to the actual HTTP response.
- [ ] Upload from the candidate through the real endpoint, read the saved
  file using the existing helper, and require version 2 and minimum 1 in
  initial/subsequent samples. Require the normal page's minimum to be null.
- [ ] POST a version-1 body as the CI admin and require a 400 error
  instructing the user to reload. Never accept an old log as the new mode.
- [ ] Commit tests, dispatch workflow 361358759 with production origin,
  and preserve the failing run before the production implementation.

## Task 2: Static Route and Shared Defaults

**Create:** `app/features/layout/appViewport.ts`.

- [ ] Use the existing policy unchanged:

```ts
import type { Viewport } from 'next';

export const APP_VIEWPORT: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
};
```

**Modify:** `app/layout.tsx`.

- [ ] Import `APP_VIEWPORT` from `./features/layout/appViewport` and
  replace only the existing viewport object with:

```ts
export const viewport: Viewport = APP_VIEWPORT;
```

**Create:** `app/diagnostics/viewport-minimum/page.tsx`.

- [ ] Keep the route a server-side composition shell:

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

- [ ] Add `viewportMinimumScale` to `METRIC_KEYS`; change the log's
  literal `version` type and validator requirement from 1 to 2.
- [ ] In capture, parse only the numeric minimum from the actual meta
  content; never upload the raw content string:

```ts
const viewportContent = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content;
const minimum = viewportContent?.match(/(?:^|,)\s*minimum-scale\s*=\s*(\d+(?:\.\d+)?)\s*(?:,|$)/i);
metrics.viewportMinimumScale = minimum ? Number(minimum[1]) : null;
```

- [ ] Initial logs declare version 2. Add the metric to the panel's
  reading state, initialized null and updated from both initial and later
  samples. Show `Minimum: 1` or `Minimum: unspecified` without changing
  layout or writing viewport state.
- [ ] Before generic schema validation, explicitly reject a version-1
  object with `DiagnosticError(400, 'outdated_log', 'Reload the diagnostic
  page and collect a new log before uploading.')`.
  Preserve all existing strict validation and storage behavior.
- [ ] Run the same contract/body/storage/browser suite remotely and
  retain the ordinary-page regressions. Commit with the required trailer.

## Task 4: Remote Validation and Deployment

- [ ] Use the existing workflow's production-origin dispatch:

```bash
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-text-autosizing \
  -f build_origin=https://agent.xujx.us.kg
```

- [ ] Require Node tests, three builds/type checks, real HTTP/UI diagnostic
  cases, and existing typography/keyboard/desktop suites to pass.
- [ ] Download the exact SHA's desktop archive. Update the session
  deployment script's SHA, artifact path, and fresh backup directory.
  Also require `/diagnostics/viewport-minimum/page` in the archive's
  route manifest before cutover.
- [ ] Preserve the existing database backup, `.next`-only swap, public
  CSS comparison, anonymous-upload protection, and rollback checks.
  Verify the archived candidate HTML has minimum 1 while ordinary HTML
  does not; neither has a maximum-scale lock.
- [ ] Persist the deployed build/revision/run in this document and hand
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
