# Typography-Only PR Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> User approved direct preparation and validation. The named execution/
> worktree skills are unavailable; use ordinary Git worktree operations,
> no subagents and no local builds/tests. Keep this execution record on
> the investigation branch, outside the clean PR.

**Goal:** Prepare a remotely validated, typography-only PR branch while
preserving native Chrome zoom as an explicitly accepted known limitation.

**Architecture:** Start from current upstream main in an isolated worktree.
Restore seven exact accepted source/test/workflow paths from archived
`79781d5`, add focused documentation, and exclude all diagnostic runtime.

**Tech Stack:** Git, CSS/Browserslist, existing Next.js/Playwright workflow,
GitHub Actions.

---

## Task 1: Isolate the Clean Branch

- [x] Fetch `upstream main` and verify it still resolves to
  `7f8c292ec439ce7ac49d976f4b840cebfa534d0e`. Confirm the investigation
  worktree is clean and branch `fix/ios-markdown-typography` does not exist
  locally or at origin. Both archive tags remain unchanged.
- [ ] Create the branch/worktree without switching production's checkout:

```bash
git worktree add -b fix/ios-markdown-typography \
  /home/xujx/.copilot/session-state/7eaf6b49-c9b6-492d-aee2-a2a9a24f0e45/files/typography-pr-worktree \
  upstream/main
```

- [ ] Restore only the approved historical paths using Git's source
  restoration in that new, clean worktree:

```bash
git restore --source=79781d534185c75cfc858feda1352de7d7a095c7 -- \
  .browserslistrc app/globals.css \
  .github/workflows/markdown-typography.yml tests/playwright.config.ts \
  tests/markdown-typography.spec.ts \
  tests/helpers/typographyFixture.ts tests/helpers/typographyMetrics.ts
```

The runtime delta must be precisely two declarations in the existing
`html, body` rule and the verified browser-target file:

```css
-webkit-text-size-adjust: 100%;
text-size-adjust: 100%;
```

```text
chrome 111
edge 111
firefox 111
safari 16.4
ios_saf 16.4
```

No package manifests, lockfiles, layout components, viewport hooks, API
routes or application TypeScript may change.

## Task 2: Focus Documentation and CI

- [ ] Copy only approved closure spec `ea36252` into the clean worktree
  with the same Git source-restoration mechanism:

```bash
git restore --source=ea36252 -- \
  docs/superpowers/specs/2026-09-19-ios-typography-pr-closure-design.md
```

- [ ] Add this section to `README.md` after Quick Start:

```markdown
## Mobile browser compatibility

Markdown uses a document-wide text-adjustment policy to keep its font
sizes stable across portrait and landscape. Native pinch zoom remains
available.

**Known limitation:** In the observed iPhone Chrome environment, pinching
larger, returning to original scale, releasing, then rotating can leave
the whole page unexpectedly zoomed. This also reproduced on an isolated
HTML page without the chat runtime; the paired Safari trial stayed at
original scale. The typography fix does not correct this native page-zoom
behavior. Safari is a verified temporary alternative for that observed
case, not a guarantee across every browser or OS version.
```

- [ ] Preserve manual workflow dispatch and replace the historical push
  filter with the clean branch. Add ordinary pull-request coverage, not
  privileged `pull_request_target`:

```yaml
  pull_request:
    branches: [main]
    paths:
      - 'app/**'
      - 'tests/**'
      - '.browserslistrc'
      - 'package.json'
      - 'package-lock.json'
      - 'next.config.ts'
      - '.github/workflows/markdown-typography.yml'
  push:
    branches: [fix/ios-markdown-typography]
    paths-ignore: ['docs/**', 'README.md']
```

- [ ] Keep the archived behavior/served-CSS tests and regression stages.
  Tighten the viewport assertion to reject both minimum and maximum scale
  locks and require initial scale 1:

```ts
expect(viewport).toMatch(/(?:^|,)\s*initial-scale=1(?:,|$)/);
expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|(?:minimum|maximum)-scale\s*=/);
```

The original red/green policy evidence is already recorded in the
investigation plan and archive. This task extracts a verified fix rather
than inventing new behavior; require a new final clean-revision green run.

## Task 3: Verify Scope and Run Remotely

- [ ] Review `git diff upstream/main` and changed-file inventory. Exactly
  nine paths are expected: the seven extracted paths, README and the
  focused closure spec. Confirm `app/layout.tsx`, `ChatShell.tsx`,
  `ChatPageClient.tsx`, all `lib/` and all API routes equal upstream main.
- [ ] Commit in the clean worktree, preserving the required trailer:

```bash
git add .browserslistrc app/globals.css \
  .github/workflows/markdown-typography.yml tests/playwright.config.ts \
  tests/markdown-typography.spec.ts tests/helpers/typographyFixture.ts \
  tests/helpers/typographyMetrics.ts README.md \
  docs/superpowers/specs/2026-09-19-ios-typography-pr-closure-design.md
git commit -m "fix: stabilize iOS Markdown typography across rotation [skip ci]" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push -u origin fix/ios-markdown-typography
gh workflow run 361358759 --repo xujxu/agents-chat \
  --ref fix/ios-markdown-typography \
  -f build_origin=https://agent.xujx.us.kg
```

- [ ] Inspect the complete remote results. Expected coverage retains
  typography 8/7/7, served policy 1 per project and regressions 17/31/31,
  for 104 passes and two deliberate desktop-only skips. Counts alone do
  not override actual failures or changed selectors.
- [ ] If a targeted failure occurs, correct only the in-scope cause and
  rerun remotely. Never install, build, type-check or run tests locally.
- [ ] Download the exact final desktop artifact. Inspect archive revision,
  build ID, compiled CSS and `app-paths-manifest.json`; no paths under
  `/diagnostics/` or `/api/diagnostics/` may be present. Inspect source
  inventory separately so middleware redirects cannot masquerade as route
  removal. Do not start the artifact locally.

## Task 4: Handoff Without Deployment or PR Creation

- [ ] Record final source/base, workflow, counts, artifact/build identity
  and diff scope in this investigation-branch plan. Preserve the clean
  candidate source as the exact validated commit.
- [ ] Stop schedule 14 when ready or blocked. Report the branch and
  accepted limitation, with no claim that native Chrome zoom was fixed.
- [ ] Do not deploy or open a PR in this task: current authorization is
  preparation and validation. Keep production running its authorized
  `42111b3` build until separately approved.

## Self-Review

The plan preserves both archives and production's checkout, copies exact
reviewed code rather than replaying diagnostic history, keeps application
TypeScript unchanged, includes the actual emitted-prefix contract and
zoom-unrestricted metadata checks, and verifies route exclusion from the
artifact. README/spec use Fixed versus Known limitation consistently.
Opening a PR and deployment are explicit later actions.
