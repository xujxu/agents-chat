# Bounded PR Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user approved inline execution; that subskill is not available in this session, so follow these checkpoints directly.

**Goal:** Capture evidence for Windows cleanup and WebKit orientation failures without changing product code or acceptance criteria.

**Architecture:** A manual-only Actions workflow checks out pinned products separately from the harness. A standard-library Windows recorder observes directory events and post-stop metadata; an opt-in browser sampler records numeric geometry. Contract tests precede the single bounded cohort batch.

**Tech Stack:** Node 24.20.0 standard library, existing Playwright and MSVC fixtures, GitHub Actions.

---

Approved specification:
`docs/superpowers/specs/2026-09-26-voice-pr-intermittent-diagnostics-design.md`.
Product voice SHA `20f5f0e3e55569a4ac7f0878f314f1d8c7b2e009`;
main SHA `638c553c62406dbb7e6b5aeb41cdddf4cd6de179`.
No local tests, builds, installations or servers.

## Task 1: Red metadata contracts

Files:
- Create `tests/voice-pr-diagnostics.test.mjs`.
- Create `.github/workflows/voice-pr-diagnostics.yml`.

- [ ] Write Node tests importing `boundedEvents`, `directorySnapshot` and
  `saveDiagnosticReport` from `tests/helpers/voiceLifecycleDiagnostics.mjs`.
  Verify fixed event bounds/dropped count, metadata-only directory snapshots,
  non-following of directory links, missing-directory race handling, and retained
  failure/capture-error state in JSON. Use synthetic temporary paths only.
- [ ] Add manual `run_cohorts` boolean input, default false. The contracts job
  runs `node --test tests/voice-pr-diagnostics.test.mjs` on Ubuntu24.04.
- [ ] Commit/push the red tests and dispatch:
  ```bash
  gh workflow run voice-pr-diagnostics.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
  ```
  Expect missing-module failure, with no Windows/browser jobs executed.

## Task 2: Windows metadata recorder and bounded driver

Files:
- Create `tests/helpers/voiceLifecycleDiagnostics.mjs`.
- Modify `tests/voice-windows-application.mjs`.

- [ ] Implement a bounded event buffer with `push(event)` and `snapshot()`;
  its output is `{events, dropped}`. Discard beyond capacity, never overwrite
  evidence or silently claim a complete history.
- [ ] Implement directory snapshots with `lstat`, up to64directories and
  20immediate members each, counts and timestamps. Never read contents or follow
  symlinks. Only ENOENT is an observed removal race; other errors propagate.
- [ ] Implement lifecycle watching of the temp root, filtering
  `agents-chat-voice-` names. Save watcher errors as incomplete evidence.
  `saveDiagnosticReport(file, report)` writes JSON even when a product
  assertion failed, without turning that assertion into success.
- [ ] Preserve the one-round default driver. Diagnostic mode accepts only
  `VOICE_DIAGNOSTIC_ROUNDS=3`; per-case mode comes from
  `VOICE_CLEANUP_DIAGNOSTICS=0|1`. Keep the initial directory baseline for all
  rounds, unique paths, original test order, hard-stop and post-stop assertion.
  Record phase boundaries without adding a pre-stop filesystem read/wait.
- [ ] Add workflow Windows matrix `sampling: ['0','1']`, fail-fast false,
  30minutes each. Checkout harness and pinned product separately; overlay only
  the driver and lifecycle helper. Existing per-case helper already exists in
  the pinned product. Compile the existing launcher/provider fixtures, install
  dependencies, build/typecheck once, run at most3rounds with zero retries.

## Task 3: Same-harness WebKit comparison

Files:
- Modify `tests/chat-reading-anchor.spec.ts`.
- Create `tests/helpers/readingGeometryDiagnostics.ts`.
- Extend `.github/workflows/voice-pr-diagnostics.yml`.

- [ ] Add opt-in `READING_GEOMETRY_DIAGNOSTICS=1` registration to the reading
  fixture. Before navigation, install bounded resize/scroll sampling; after each
  case attach JSON with viewport, chat and composer dimensions, no text.
  Keep512samples with explicit dropped/error metadata; do not change settling,
  viewport sequence or the4px assertion.
- [ ] Add two jobs via a fixed SHA matrix (main/voice), Ubuntu24.04,
  Node24.20.0, identical locked Playwright and browser settings, 15minutes each.
  Overlay only the same reading test and geometry helper onto each product.
  Run:
  ```bash
  npx playwright test --config tests/playwright.config.ts \
    tests/chat-reading-anchor.spec.ts --project=iphone-webkit \
    --grep='^keeps latest messages at the bottom through orientation round trips$' \
    --repeat-each=5 --retries=0 --workers=1 --max-failures=1 \
    --reporter=line,json --trace=retain-on-failure
  ```
  Save the JSON reporter outside the Playwright output directory; report the
  actual completed repetitions, including early termination.
- [ ] Gate cohorts on `run_cohorts`; WebKit follows completion of the Windows
  stage even when a Windows assertion fails, but not cancelled/failed contracts.
  Upload bounded diagnostic evidence on failure as well as success.

## Task 4: Contract green, one batch, evidence

- [ ] Commit/push the helper/harness and run contracts only. Inspect exact
  results before enabling cohorts; repair harness defects, not product behavior.
- [ ] Dispatch the single approved cohort batch:
  ```bash
  gh workflow run voice-pr-diagnostics.yml -R xujxu/agents-chat \
    --ref experiment/voice-natural-long -f run_cohorts=true
  ```
- [ ] Read bounded reports/log sections. Verify product/harness SHAs, sampling
  modes, actual counts, absence/presence of capture errors and original assertion
  results. Retain failures even when other cohorts pass.
- [ ] Add an execution record to the spec and PR #2 with run/artifact IDs and
  measured findings. No automatic second batch, product fix, threshold change,
  component replacement, merge or release. If cause is unconfirmed, say so.

## Execution checkpoint

Tasks1-3implemented in `6162582`; red `36225811502`, green contracts
`36225903942` (4passed). The user separately approved the temporary
contracts-only workflow registration trigger; it was removed before cohorts.
Task4's one batch `36225934786` completed with failures and is not repeated.
Windows completed0rounds because the new filesystem watcher triggered a native
Node/libuv assertion, leaving provenance only. WebKit main passed5/5; voice
failed its first repetition at5px vs4px. Findings/artifact identities are in the
spec's execution record. Further diagnostic repair/collection needs approval;
no product changes or fixes have been claimed.
