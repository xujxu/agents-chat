# iOS Markdown Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Environment note: those execution skills are not installed in this session.
Do not invent unavailable tool invocations; execute the tasks directly when
the user selects inline execution.

**Goal:** Produce a revision-identifiable baseline and minimal typography candidate, validate them in GitHub Actions, and require physical iPhone evidence before declaring the rotation defect fixed.

**Architecture:** Keep production changes limited to the global text-adjust policy. Reuse the existing chat fixture and real message renderers; isolate deterministic content, read-only DOM measurements, and regression scenarios in test files. Do not change layout breakpoints, viewport ownership, input font sizes, or browser zoom settings.

**Tech Stack:** Next.js, React, strict TypeScript, Playwright, GitHub Actions, existing authenticated chat persistence.

---

## Constraints and Execution Gates

- Working branch: `fix/ios-markdown-text-autosizing`, based on `7f8c292`.
- Approved design: `docs/superpowers/specs/2026-09-18-ios-markdown-text-autosizing-design.md`.
- No local builds, tests, type checks, dependency installation, browser automation, or test servers.
- Run all validation commands in Actions. Local commands in this plan are Git/`gh` operations only.
- Do not deploy to the shared running service without explicit approval.
- Variant A contains tests and documentation, but no production behavior change.
- Variant B adds only the two text-adjust declarations.
- Preserve Actions evidence for both revisions; never substitute a policy assertion failure for physical symptom reproduction.
- If a supported-engine regression fails, diagnose and correct it remotely rather than skipping WebKit or weakening the geometry checks.
- CI-only completion is reported as a candidate awaiting physical acceptance.

## File Responsibilities

| File | Responsibility |
| --- | --- |
| `tests/helpers/typographyFixture.ts` | Synthetic Markdown and chat/API fixture, including controllable polling output |
| `tests/helpers/typographyMetrics.ts` | Read-only browser sampler, settling, and typography comparisons |
| `tests/markdown-typography.spec.ts` | Rotation, cold-load, streaming, collapse, route, and policy coverage |
| `tests/playwright.config.ts` | Include the cross-platform spec in both mobile projects without excluding desktop |
| `.github/workflows/markdown-typography.yml` | Remote build, type check, engine matrix, artifacts, and bounded regressions |
| `app/globals.css` | The sole production candidate change |
| Existing design and this plan | Record evidence, outcomes, and physical acceptance status |

Keep the existing `mobileChatFixture.ts` unchanged. Do not add a test dependency,
production diagnostics endpoint, client-side instrumentation listener, or a
second Markdown renderer.

## Task 1: Deterministic Fixture and Read-Only Measurements

**Create:** `tests/helpers/typographyFixture.ts`

- [ ] **Step 1: Add the fixture module.**

```ts
import type { Page } from '@playwright/test';
import type { ChatMessage } from '../../app/features/chat/chatTypes';
import { installMobileChatFixture } from './mobileChatFixture';

export const TYPOGRAPHY_MARKDOWN = `# Stable heading

Stable paragraph with **emphasis** and \`inlineCode\`.

${'Stable prose keeps the original reading size while the available line width changes. '.repeat(12)}

- Stable parent item
  - Stable nested item

> Stable quoted paragraph.

| Label | Detail |
| --- | --- |
| Stable | Stable table value |

\`\`\`ts
const stable = "${'wideColumn'.repeat(30)}";
\`\`\`
`;

export function typographyChat() {
  const messages: ChatMessage[] = [
    { id: 'type-user', type: 'user', content: TYPOGRAPHY_MARKDOWN, ts: 1001 },
    { id: 'type-agent', type: 'agent', agentId: 'alpha', content: TYPOGRAPHY_MARKDOWN, ts: 1002 },
    {
      id: 'type-parts', type: 'agent', agentId: 'alpha',
      content: TYPOGRAPHY_MARKDOWN, ts: 1003,
      parts: [{ kind: 'text', text: TYPOGRAPHY_MARKDOWN }],
    },
  ];
  return { id: 'mobile-chat', name: 'Typography acceptance', ts: 1000, messages, agentSessions: {} };
}

export async function installTypographyFixture(page: Page) {
  await installMobileChatFixture(page);
  const chat = typographyChat();
  let streaming = false;
  let completed = false;
  let additions = '';
  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).searchParams.get('id');
    await route.fulfill({
      json: request.method() === 'GET'
        ? id
          ? { ok: true, chat }
          : { ok: true, chats: [{ id: chat.id, name: chat.name, ts: chat.ts }], lastChatId: chat.id }
        : { ok: true },
    });
  });
  await page.route('**/api/acp', async (route) => {
    const body: { action?: string } = route.request().postDataJSON();
    if (body.action === 'send') {
      streaming = true;
      await route.fulfill({
        json: { ok: true, sessionId: 'type-session', turn: { id: 'type-turn' } },
      });
      return;
    }
    if (body.action === 'poll' && streaming) {
      const text = TYPOGRAPHY_MARKDOWN + additions;
      await route.fulfill({
        json: {
          ok: true,
          activeTurn: {
            id: 'type-turn', fullText: text, done: completed,
            phase: completed ? 'idle-ready' : 'replying',
            statusText: completed ? '' : 'Generating',
            events: [{ type: 'text_chunk', text, ts: 1004 }],
          },
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/markdown**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (!path) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: { path, content: TYPOGRAPHY_MARKDOWN, kind: 'markdown', mtime: '2026-09-18T00:00:00Z' },
    });
  });
  await page.route('**/api/share**', (route) => route.fulfill({
    json: { ok: true, chat: {
      shareId: 'typography', name: chat.name, sharedBy: 'admin@local',
      sharedAt: 1000, messages: chat.messages,
    } },
  }));
  return {
    append() { additions += '\n\nAdditional streaming paragraph.'; },
    finish() { completed = true; },
  };
}
```

The fixture overrides only its own test page's requests. The default fixture
continues to supply agents, nodes, schedules, and file listings. Stream updates
travel through the application's real polling and text-part rendering path.

**Create:** `tests/helpers/typographyMetrics.ts`

- [ ] **Step 2: Add a browser-serializable sampler and assertion helpers.**

```ts
import { expect, type Page } from '@playwright/test';

export function captureTypography(roots: Record<string, string>) {
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  const typography: Record<string, {
    fontSize: string; fontFamily: string; lineHeight: string;
    width: number; height: number; textAdjust: string;
  }> = {};
  const containers: Record<string, ReturnType<typeof rect>> = {};
  const targets = ['h1', 'p', 'li', 'li li', 'blockquote p', 'td', 'p code', 'pre code'];
  for (const [name, selector] of Object.entries(roots)) {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`Missing typography root: ${name} (${selector})`);
    containers[name] = rect(root);
    for (const target of targets) {
      const element = root.querySelector(target);
      if (!element) throw new Error(`Missing typography target: ${name} ${target}`);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.trim()) node = walker.nextNode();
      if (!node?.textContent) throw new Error(`Missing text: ${name} ${target}`);
      const start = node.textContent.search(/\S/);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, Math.min(start + 4, node.textContent.length));
      const boxes = Array.from(range.getClientRects());
      if (boxes.length !== 1 || boxes[0].width <= 0 || boxes[0].height <= 0) {
        throw new Error(`Expected one nonzero text fragment: ${name} ${target}`);
      }
      const style = getComputedStyle(element);
      typography[`${name}:${target}`] = {
        fontSize: style.fontSize, fontFamily: style.fontFamily, lineHeight: style.lineHeight,
        width: boxes[0].width, height: boxes[0].height,
        textAdjust: style.getPropertyValue('text-size-adjust')
          || style.getPropertyValue('-webkit-text-size-adjust'),
      };
    }
  }
  const viewport = window.visualViewport;
  const chrome: Record<string, {
    bounds: ReturnType<typeof rect>; fontSize: string;
  }> = {};
  for (const selector of ['.chatPageRoot .page', '.header', '.composerTextarea']) {
    const element = document.querySelector(selector);
    if (element) chrome[selector] = {
      bounds: rect(element), fontSize: getComputedStyle(element).fontSize,
    };
  }
  const rootStyle = getComputedStyle(document.documentElement);
  return {
    typography, containers, chrome,
    rootTextAdjust: rootStyle.getPropertyValue('text-size-adjust')
      || rootStyle.getPropertyValue('-webkit-text-size-adjust'),
    viewport: {
      width: innerWidth, height: innerHeight,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      devicePixelRatio, mobileLayout: matchMedia('(max-width: 900px)').matches,
      orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait',
      visual: viewport ? {
        width: viewport.width, height: viewport.height, scale: viewport.scale,
        offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft,
      } : null,
    },
  };
}

export type TypographySample = ReturnType<typeof captureTypography>;
export type TypographyObservation = {
  state: string; time: number; sample: TypographySample;
};

export async function settledTypography(
  page: Page, roots: Record<string, string>, state: string,
  observations: TypographyObservation[],
): Promise<TypographySample> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let previous = '';
  let since = 0;
  let count = 0;
  let latest: TypographySample | undefined;
  await expect.poll(async () => {
    latest = await page.evaluate(captureTypography, roots);
    const now = Date.now();
    observations.push({ state, time: now, sample: latest });
    const signature = JSON.stringify({
      typography: latest.typography,
      containers: Object.values(latest.containers).map(({ width, height }) => ({ width, height })),
      viewport: latest.viewport,
    });
    if (signature !== previous) {
      previous = signature;
      since = now;
      count = 1;
    } else count++;
    return count >= 3 ? now - since : 0;
  }, { timeout: 10_000, intervals: [100] }).toBeGreaterThanOrEqual(300);
  if (!latest) throw new Error('No typography observations collected');
  return latest;
}

export function expectSameTypography(before: TypographySample, after: TypographySample) {
  expect(Object.keys(after.typography)).toEqual(Object.keys(before.typography));
  for (const [key, expected] of Object.entries(before.typography)) {
    const actual = after.typography[key];
    expect(actual.fontSize, key).toBe(expected.fontSize);
    expect(actual.fontFamily, key).toBe(expected.fontFamily);
    expect(actual.lineHeight, key).toBe(expected.lineHeight);
    expect(Math.abs(actual.width - expected.width), `${key} width`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(actual.height - expected.height), `${key} height`).toBeLessThanOrEqual(0.5);
  }
}
```

The sampler does not return source text, change CSS, wrap DOM nodes, focus
controls, or scroll. Empty text-adjust values are evidence of unavailable
computed exposure, not invented success. A test can serialize this self-contained
function for a read-only device-inspection snippet.

## Task 2: Regression Cases and Evidence Collection

**Create:** `tests/markdown-typography.spec.ts`

- [ ] **Step 1: Add the following spec before changing production CSS.**

```ts
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loginMobileFixture } from './helpers/mobileChatFixture';
import { installTypographyFixture, typographyChat } from './helpers/typographyFixture';
import {
  captureTypography, expectSameTypography, settledTypography,
  type TypographyObservation,
} from './helpers/typographyMetrics';

const roots = {
  user: '.message.user .markdownBody',
  agent: '.message.agent:not(:has(.partsStream)) .markdownBody',
  parts: '.partsStream .markdownBody',
};
let observations: TypographyObservation[];
let fixture: Awaited<ReturnType<typeof installTypographyFixture>>;

test.beforeEach(async ({ page }) => {
  observations = [];
  fixture = await installTypographyFixture(page);
});

test.afterEach(async ({ page, browser }, testInfo) => {
  await testInfo.attach('typography-observations.json', {
    body: JSON.stringify({
      commit: process.env.GITHUB_SHA || 'unrecorded',
      browser: browser.version(),
      project: testInfo.project.name,
      observations,
    }, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('device-sampler.js', {
    body: `(${captureTypography.toString()})(${JSON.stringify(roots)})`,
    contentType: 'application/javascript',
  });
  await testInfo.attach('synthetic-chat.json', {
    body: JSON.stringify(typographyChat(), null, 2),
    contentType: 'application/json',
  });
  if (!page.isClosed()) await testInfo.attach('final-viewport.png', {
    body: await page.screenshot(), contentType: 'image/png',
  });
});

for (const portrait of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
  for (const landscapeFirst of [false, true]) {
    test(`stable Markdown ${portrait.width} landscape-first=${landscapeFirst}`, async ({ page }) => {
      const landscape = { width: portrait.height, height: portrait.width };
      const start = landscapeFirst ? landscape : portrait;
      const other = landscapeFirst ? portrait : landscape;
      await page.setViewportSize(start);
      await loginMobileFixture(page);
      const baseline = await settledTypography(page, roots, 'initial', observations);
      for (const selector of Object.values(roots)) {
        const message = page.locator(selector).locator('xpath=ancestor::div[contains(@class,"message ")][1]');
        await message.getByRole('button', { name: 'Collapse', exact: true }).click();
      }
      expectSameTypography(baseline, await settledTypography(page, roots, 'collapsed', observations));
      expect(baseline.viewport.visual).not.toBeNull();
      expect(baseline.viewport.visual!.scale).toBeCloseTo(1, 2);
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const size of [other, start]) {
          await page.setViewportSize(size);
          const sample = await settledTypography(page, roots, `cycle-${cycle}-${size.width}`, observations);
          expect(sample.viewport.width).toBe(size.width);
          expect(sample.viewport.mobileLayout).toBe(size.width <= 900);
          expect(sample.viewport.visual?.scale).toBeCloseTo(1, 2);
          expectSameTypography(baseline, sample);
        }
      }
      for (const selector of Object.values(roots)) {
        const message = page.locator(selector).locator('xpath=ancestor::div[contains(@class,"message ")][1]');
        await message.getByRole('button', { name: 'Expand', exact: true }).click();
      }
      expectSameTypography(baseline, await settledTypography(page, roots, 'expanded', observations));
      await page.setViewportSize(other);
      expectSameTypography(baseline, await settledTypography(page, roots, 'expanded-rotated', observations));
    });
  }
}

test('draft and streamed Markdown survive real viewport changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginMobileFixture(page);
  const composer = page.locator('textarea.composerTextarea');
  await composer.fill('@alpha Typography streaming check');
  await page.getByRole('button', { name: 'Send message' }).click();
  const streamRoots = { stream: '.message.agent:last-child .markdownBody' };
  await expect(page.locator('.message.agent.streamingMessage .partsStream .markdownBody')).toBeVisible();
  const baseline = await settledTypography(page, streamRoots, 'stream-start', observations);
  await composer.fill('Preserve my draft');
  await composer.focus();
  const focused = await settledTypography(page, streamRoots, 'focused-baseline', observations);
  await page.setViewportSize({ width: 844, height: 390 });
  fixture.append();
  await expect(page.locator(streamRoots.stream)).toContainText('Additional streaming paragraph.');
  expectSameTypography(focused, await settledTypography(page, streamRoots, 'stream-landscape', observations));
  await page.setViewportSize({ width: 390, height: 844 });
  fixture.finish();
  await expect(page.locator('.message.agent:last-child')).not.toHaveClass(/streamingMessage/);
  await expect(composer).toHaveValue('Preserve my draft');
  expectSameTypography(baseline, await settledTypography(page, streamRoots, 'stream-complete', observations));
});

test('shared Markdown inherits the policy across orientation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginMobileFixture(page);
  await page.goto('/share/typography');
  const shareRoots = { share: '.shareMsg.agent .shareMarkdown' };
  await expect(page.locator(shareRoots.share).first()).toBeVisible();
  const baseline = await settledTypography(page, shareRoots, 'share-portrait', observations);
  await page.setViewportSize({ width: 844, height: 390 });
  expectSameTypography(baseline, await settledTypography(page, shareRoots, 'share-landscape', observations));
});

test('file Markdown inherits the policy without changing the viewer layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginMobileFixture(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'Files agent' }).click();
  await page.getByRole('option', { name: 'Alpha Agent' }).click();
  await page.getByRole('button', { name: 'README.md' }).click();
  const fileRoots = { file: '.mobileMarkdownViewer' };
  await expect(page.locator(fileRoots.file)).toBeVisible();
  const baseline = await settledTypography(page, fileRoots, 'file-portrait', observations);
  await page.setViewportSize({ width: 844, height: 390 });
  expectSameTypography(baseline, await settledTypography(page, fileRoots, 'file-landscape', observations));
});

test('desktop resizing preserves typography and sidebar mode', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop-only grid invariant');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginMobileFixture(page);
  const baseline = await settledTypography(page, roots, 'desktop-1440', observations);
  for (const width of [1100, 1600, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expectSameTypography(baseline, await settledTypography(page, roots, `desktop-${width}`, observations));
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    await expect(page.locator('.participantsSidebar')).toBeVisible();
  }
});

test('@policy declares root text adjustment without restricting user zoom', async ({ page }) => {
  await loginMobileFixture(page);
  const source = readFileSync('app/globals.css', 'utf8');
  const rootRule = source.match(/html,\s*body\s*\{([^}]+)\}/)?.[1];
  expect(rootRule).toBeDefined();
  expect(rootRule).toMatch(/-webkit-text-size-adjust:\s*100%/);
  expect(rootRule).toMatch(/(?:^|[;\n])\s*text-size-adjust:\s*100%/);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('width=device-width');
  expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale\s*=/);
  const sample = await settledTypography(page, roots, 'policy', observations);
  for (const value of [sample.rootTextAdjust, ...Object.values(sample.typography).map(item => item.textAdjust)]) {
    if (value !== '') expect(value).toBe('100%');
  }
});
```

Keep all evidence collection active in both revisions. If a computed property
is unavailable, the JSON records the empty value and the static contract still
checks the intended declarations. No geometry case is skipped for that reason.

- [ ] **Step 2: Extend `tests/playwright.config.ts` without changing existing project semantics.**

Add a distinct cross-platform list after `mobileSpecs`:

```ts
const typographySpecs = ['**/markdown-typography.spec.ts'];
```

Change the two mobile project `testMatch` entries to:

```ts
testMatch: [...mobileSpecs, ...typographySpecs],
```

Keep desktop `testIgnore: mobileSpecs` unchanged. Desktop therefore runs the
new cross-platform spec too. Tests that check the desktop-only grid are
explicitly identified in the spec.

## Task 3: Remote Baseline Run

**Create:** `.github/workflows/markdown-typography.yml`

- [ ] **Step 1: Add a bounded, branch-triggered workflow.**

```yaml
name: Markdown typography validation

on:
  workflow_dispatch:
  push:
    branches: [fix/ios-markdown-text-autosizing]

permissions:
  contents: read

concurrency:
  group: markdown-typography-${{ github.ref }}
  cancel-in-progress: false

jobs:
  typography:
    runs-on: ubuntu-24.04
    timeout-minutes: 25
    strategy:
      fail-fast: false
      matrix:
        include:
          - project: iphone-webkit
            browser: webkit
          - project: android-chromium
            browser: chromium
          - project: desktop-chromium
            browser: chromium
    env:
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: admin123
      NEXTAUTH_SECRET: isolated-typography-ci-secret
      NEXTAUTH_URL: http://localhost:3011
      PLAYWRIGHT_BASE_URL: http://localhost:3011
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - name: Install dependencies and browser
        run: |
          npm ci --no-audit --no-fund
          npx playwright install --with-deps ${{ matrix.browser }}
      - name: Build and check types
        run: |
          npm run build
          npx tsc --noEmit
      - name: Prepare revision-identifiable standalone build
        run: |
          mkdir -p artifacts .next/standalone/.next
          cp -R .next/static .next/standalone/.next/static
          cp -R public .next/standalone/public
          printf '%s\n' "$GITHUB_SHA" > .next/standalone/public/validation-revision.txt
          cp .next/BUILD_ID artifacts/next-build-id.txt
          if [ "${{ matrix.project }}" = "desktop-chromium" ]; then
            tar -czf artifacts/standalone-preview.tar.gz -C .next/standalone .
          fi
      - name: Start isolated application
        run: |
          mkdir -p artifacts
          printf '%s\n' "$GITHUB_SHA" > artifacts/revision.txt
          npm ls @playwright/test > artifacts/playwright-version.txt
          HOSTNAME=127.0.0.1 PORT=3011 node .next/standalone/server.js > artifacts/server.log 2>&1 &
          server_pid=$!
          echo "$server_pid" > artifacts/server.pid
          for attempt in $(seq 1 30); do
            if curl --fail --silent --max-time 3 http://localhost:3011/login >/dev/null; then
              exit 0
            fi
            if ! kill -0 "$server_pid" 2>/dev/null; then
              cat artifacts/server.log
              exit 1
            fi
            sleep 2
          done
          cat artifacts/server.log
          exit 1
      - name: Collect typography behavior evidence
        run: >-
          npx playwright test --config tests/playwright.config.ts
          --project=${{ matrix.project }} tests/markdown-typography.spec.ts
          --grep-invert @policy --workers=1 --timeout=60000 --global-timeout=480000
          --trace=retain-on-failure --reporter=line --output=artifacts/behavior
      - name: Check typography policy
        run: >-
          npx playwright test --config tests/playwright.config.ts
          --project=${{ matrix.project }} tests/markdown-typography.spec.ts
          --grep @policy --workers=1 --timeout=60000 --global-timeout=90000
          --trace=retain-on-failure --reporter=line --output=artifacts/policy
      - name: Mobile regression coverage
        if: matrix.project != 'desktop-chromium'
        run: >-
          npx playwright test --config tests/playwright.config.ts
          --project=${{ matrix.project }} tests/mobile-responsive.spec.ts
          tests/mobile-composer-viewport.spec.ts --workers=1
          --timeout=60000 --global-timeout=420000 --max-failures=1
          --trace=retain-on-failure --reporter=line --output=artifacts/regression
      - name: Desktop regression coverage
        if: matrix.project == 'desktop-chromium'
        run: >-
          npx playwright test --config tests/playwright.config.ts
          --project=desktop-chromium tests/interaction-coverage.spec.ts
          tests/chat-selection-loading.spec.ts tests/message-copy-with-format.spec.ts
          --workers=1 --timeout=60000 --global-timeout=300000 --max-failures=1
          --trace=retain-on-failure --reporter=line --output=artifacts/regression
      - name: Stop isolated application
        if: always()
        run: |
          if [ -f artifacts/server.pid ]; then
            server_pid="$(cat artifacts/server.pid)"
            if kill -0 "$server_pid" 2>/dev/null; then
              kill "$server_pid"
            fi
          fi
      - name: Preserve revision-specific evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: typography-${{ github.sha }}-${{ matrix.project }}
          path: artifacts/
          retention-days: 14
```

Baseline geometry executes before the deliberately failing policy contract.
The expected contract failure remains a failed workflow; it is not hidden
using `continue-on-error`. Later regression steps run once the policy passes.
The desktop job also retains a pre-start standalone archive (without runtime
chat data) for an approved Linux x64 / Node 24 preview. All jobs exercise that
same standalone packaging path. The revision marker is generated only in the
CI preview artifact, not added as application source or an API endpoint.

- [ ] **Step 2: Commit and push variant A.**

```bash
git add tests/helpers/typographyFixture.ts tests/helpers/typographyMetrics.ts tests/markdown-typography.spec.ts tests/playwright.config.ts .github/workflows/markdown-typography.yml
git commit -m "test: capture cross-browser Markdown typography baseline" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push -u origin fix/ios-markdown-text-autosizing
gh run list --repo xujxu/agents-chat --branch fix/ios-markdown-text-autosizing --workflow markdown-typography.yml --limit 3
```

- [ ] **Step 3: Read the resulting run by its returned ID.**

Use `gh run view RUN_ID --repo xujxu/agents-chat --json status,conclusion,jobs,url`
and, after completion, `gh run view RUN_ID --repo xujxu/agents-chat --log-failed`.
`RUN_ID` is the concrete ID returned by Step 2, not a guessed run.
Record the actual revision and URL in this plan's execution record.

Expected: build/type check succeeds; behavior observations are retained; the
policy test fails because the root rule lacks text-adjust. If other failures
occur, fix the fixture/test or document the reproduced behavior before
attributing anything to the policy. Do not change application behavior yet.

## Task 4: Minimal Candidate and Remote Regression

**Modify:** `app/globals.css`, existing `html, body` declaration.

- [ ] **Step 1: Add only these declarations to the existing rule.**

```css
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
```

Do not add orientation conditions, `!important`, `none`, maximum scale,
viewport mutation, font-size changes, or root-position changes.

- [ ] **Step 2: Commit and push variant B.**

```bash
git add app/globals.css
git commit -m "fix: normalize browser text adjustment at the document root" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin fix/ios-markdown-text-autosizing
gh run list --repo xujxu/agents-chat --branch fix/ios-markdown-text-autosizing --workflow markdown-typography.yml --limit 3
```

- [ ] **Step 3: Inspect the new run and artifacts.**

Read the candidate run using the same `gh run view` operations with its own
returned run ID. Expected: all three jobs pass behavior, policy, and existing
regression steps. Compare baseline and candidate observations within each
engine. Explicitly state if CI did not reproduce the original physical bug.

Do not run a local substitute if Actions fails. Fix remote failures and push a
new commit, preserving prior evidence. Do not force-push or overwrite the
baseline revision.

## Task 5: Physical Acceptance Handoff

**No production deployment is authorized by this plan.**

- [ ] **Step 1: Record the exact A/B revisions and Actions URLs.**

Use the actual IDs from Tasks 3 and 4. Preserve the sampler and synthetic
fixture for approved device testing. If an approved preview is unavailable,
mark the physical step blocked and report the blocker.
The standalone archive is attached to the desktop job's evidence artifact.
After approved deployment and login, verify `/validation-revision.txt`, the
corresponding Next build ID/asset URLs, and the browser's loaded resources.
The existing middleware protects the revision text asset and share pages;
do not change authentication to make the diagnostic artifacts public. Configure the
preview's real authentication and URL explicitly; the workflow's dummy
credentials are for its loopback-only instance and must not be exposed.

- [ ] **Step 2: Prepare the same synthetic chat on an approved isolated instance.**

The existing authenticated `/api/chats` POST accepts `{ chat }` and supports
`{ action: 'set-last-chat', chatId }`. Reuse the exported `typographyChat()`
payload; do not seed shared production data or add unauthenticated endpoints.
In the approved authenticated browser session, the operation is:

```js
async function seedTypographyChat(chat) {
  for (const body of [{ chat }, { action: 'set-last-chat', chatId: chat.id }]) {
    const response = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
    const result = await response.json();
    if (!result.ok) throw new Error(`Fixture rejected: ${JSON.stringify(result)}`);
  }
}
```

Invoke this with the exported synthetic chat payload, not real conversation
data. The isolated instance must be serving the revision under test.

- [ ] **Step 3: Compare physical Safari and Chrome.**

On the same iPhone and default zoom, independently cold-load A and B. Test
both initial orientations, three rotation round trips, expanded/collapsed
messages, and focused/unfocused input with separate starting scales.
Capture screen recordings and, where supported, the read-only sampler output.
Verify manual pinch zoom remains usable and drafts are not lost.

Acceptance: A reproduces text enlargement and B removes it without new
regressions. If B fails, do not call it fixed or restore the old viewport
experiments; use the design's evidence-driven next-variable decision tree.

## Self-Review

- [x] Every production change is bounded to the global CSS policy.
- [x] The test fixture exercises user, ordinary agent, and text-part rendering.
- [x] Real polling updates cover pending and completed streaming output.
- [x] Ordinary and wide landscape pairs are covered without changing breakpoints.
- [x] Cold landscape, collapse/expand, focused drafts, files, share pages, and desktop are covered.
- [x] Policy assertions and geometry evidence are separate; unavailable computed exposure is not substituted.
- [x] Measurements are layout evidence, not proof of physical painted glyph sizes.
- [x] The baseline run retains evidence before its expected policy failure.
- [x] Actions retains the exact standalone build, synthetic seed, and read-only sampler for approved physical comparison.
- [x] All builds/tests/installations run in Actions, not on the development host.
- [x] Physical acceptance and deployment approval remain explicit gates.

## Execution Record

No implementation or workflow execution has started. Record actual baseline
and candidate commit/run IDs here during Tasks 3 and 4. Physical acceptance
remains pending an approved preview and testing on the affected iPhone.
