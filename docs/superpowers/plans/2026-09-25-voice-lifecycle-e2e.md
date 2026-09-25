# Installed Voice Lifecycle E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify install/enable, real browser transcription to an existing draft,
and disable on Linux and Windows without accuracy scoring.

**Architecture:** A dedicated Actions-only runner owns configuration and three
application starts. A narrow Playwright spec uses real auth/voice API/model and
fixtures only unrelated chat endpoints. Pure contracts enforce coverage and
functional evidence; a final job combines both hosts.

**Tech Stack:** Node 24.20.0, TypeScript, Playwright, Python 3.12 for verified
artifact preparation, existing Sense native packages, GitHub Actions.

---

User approved spec `8e7b3f1` and inline implementation. Named execution skills
are unavailable; execute inline with checkpoints. No local test/build/server.
Do not ask again for execution mode. Accuracy investigation is paused.

## File map

- `scripts/voice/lifecycle-contract.ts`: phase/project/sample identity, typed
  records, capability/delivery assertions and strict host-report validation.
- `tests/voice-lifecycle.test.mjs`: Node contracts for the above.
- `scripts/voice_lifecycle_prepare.py`: pinned package/source download using
  existing safe evidence helper; selects only two samples for browser playback.
- `scripts/voice/lifecycle-run.mjs`: real CLI, installed role checks, server
  lifecycle, Playwright invocation, cleanup and failure-inclusive host report.
- `tests/playwright.voice-lifecycle.config.ts`: Linux 3 projects/Windows Edge.
- `tests/voice-lifecycle.spec.ts`: real capability, recording, draft and disable.
- `scripts/voice/lifecycle-report.mjs`: cross-host coverage/provenance report.
- `.github/workflows/voice-lifecycle.yml`: push contracts/preflight; manually
  triggered real-package lifecycle and aggregate report.
- Spec, this plan and `scripts/VOICE-DEPLOYMENT.txt`: evidence ledger.

## Task 1: Red contracts

- [x] Define tests before implementation:

```javascript
test('empty real response cannot pass', () => {
  assert.throws(() => assertDelivery({
    status: 200, body: { ok: true, text: '', elapsedMs: 1 },
    draft: 'Keep my draft', composer: 'Keep my draft', sends: 0,
    sourceCompleted: true, tracksStopped: true, contextClosed: true,
    uploadBytes: 100, idle: true, requestCount: 1,
  }));
});
```

- [x] Include valid prefix append, changed/duplicated text, errors, missing body,
  unsolicited send, cleanup failure, missing projects, duplicates, stale
  run/commit, blocked phases, wrong capabilities and installed identity.
- [x] Push a contracts workflow importing the absent module and inspect intended
  red module-not-found in Actions:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24.20.0
- run: node --test tests/voice-lifecycle.test.mjs
```

## Task 2: Contract implementation and trusted inputs

- [x] Define fixed `samples = ['test-00332', 'test-00949']`, Linux project names
  and Windows `installed-edge`, phases `initial`, `enabled`, `disabled`.
  Each project requires initial/disabled capability rows and two enabled
  delivery rows; total expected browser records 16, real ASR attempts 8.
- [x] Implement strict real body/draft relation:

```typescript
if (row.status !== 200 || !row.body.ok || !row.body.text.trim()
    || row.body.text.includes('\0')
    || row.composer !== `${row.draft}\n${row.body.text}`
    || row.sends !== 0 || row.requestCount !== 1
    || !row.sourceCompleted || !row.tracksStopped || !row.contextClosed
    || !row.idle || row.uploadBytes <= 44) {
  throw new Error('Incomplete real voice delivery');
}
```

- [x] Download pinned source and host-specific package via
  `voice_webkit_evidence.download` with explicit maps/commits. Pin archive
  hashes in addition to manifest hashes; reject expired/missing/mismatched
  artifacts. No models/audio locally.
- [x] Copy the selected two WAVs and selected metadata/attribution to lifecycle
  input directory after checking WAV hash, ID uniqueness and original duration.
  Source is ASCEND test artifact, not synthesized text or mock inference.

## Task 3: Actual configuration and server lifecycle

- [x] Require Actions and absent project voice configuration. Remove inherited
  `VOICE_*` from child environment; preserve fixture auth and runner identities.
  Let CLI reject conflicting other configuration sources.
- [x] Run initial server/tests, then stop before installation:

```javascript
await run(['scripts/configure-voice.mjs', '--project-dir', process.cwd(),
  '--model', 'sensevoice-small-q8', '--package-dir', packagePath,
  '--manifest-sha256', pinnedManifest, '--non-interactive']);
```

- [x] Verify persisted enabled/model/standard/two-thread values and binary,
  model/helper hashes against manifest; do not print full config or secrets.
- [x] Start fresh enabled server/tests, then invoke real CLI disabled and start
  again. Keep disabled test phase available even after independent delivery
  failures, but do not continue enable-dependent phases after install failure.
- [x] Write phase statuses before and after work. On failures retain sanitized
  messages and blocked dependents, then exit nonzero. Baseline/post-run native
  temp directory equality and specific owned PID shutdown are mandatory.
  Readiness checks `/api/auth/providers` plus process liveness; timeout 90s.

## Task 4: Playwright user flow

- [x] Reuse base mobile/desktop projects and actual Edge descriptor/channel.
  Narrow `testMatch`, zero retries, one worker; phase comes from runner.
- [x] Install only existing chat fixtures and original source observer. Real
  login via `loginMobileFixture`; no route touching `/api/voice`.
- [x] Assert real disabled capabilities plus hidden microphone in initial and
  final phases. Enabled cases assert model/provider/thread/policy/cap.
- [x] For each fixed source:

```typescript
await armBrowserCapture(page, audio.toString('base64'));
await page.locator('textarea.composerTextarea').fill('Keep my draft');
await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
await playBrowserCapture(page);
await page.waitForTimeout(sample.duration * 1000 + 100);
await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
```

- [x] Wait for actual POST response, nonempty text, expected prefix plus text,
  idle UI and closed tracks/context; no arbitrary text equality to reference.
  Count same-origin native POST and chat sends. Save metadata, screenshots and
  observed result in `finally` so failed attempts are not lost.
- [x] Read the final composer directly: the historical observer detects first
  nonempty composer after stop, which can be the preexisting draft. Do not use
  that observer field as final delivery proof; do not change historical helper.

## Task 5: Actions preflight and real flow

- [x] Push contracts + existing setup/activation tests on both OSes. Run existing
  voice UI/capture regressions; actual API covered by native deliveries, not a
  rerun of the separate mock-provider API negative suite. Run build/app and
  explicit test strict checks on both OSes.
- [x] Manually triggered collection needs successful contracts/preflight.
  Install browsers only in Actions; download packages only for real collection.
  Both hosts run actual lifecycle with the identical fixed two samples.
- [x] Always upload sanitized host evidence; no model/source audio/config/private
  server logs. Final report downloads both host artifacts, rejects missing or
  stale identities and checks full 16 records/eight real attempts.
- [x] Inspect failures, preserve evidence and fix only proven flow defects.
  Repeat full lifecycle, never sample retries or accuracy threshold changes.

```bash
gh workflow run voice-lifecycle.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
gh run list -R xujxu/agents-chat --workflow voice-lifecycle.yml --limit 5
```

## Task 6: Durable result

- [x] Read small report and all eight outcomes; distinguish functional result
  from ASR accuracy and real-device limitations.
- [x] Append measured commit/run/artifact identities and phase outcomes to spec
  and deployment ledger, check completed steps, commit/push and clean owned logs.
- [x] Stop reminder #8 and finish todos only after evidence is persistent.

## Self-review

The flow ends at draft delivery, not agent sending. The runner restarts after
configuration changes; real requests stay same-origin with no fixture receiver.
Two existing samples include a known difficult sample; no scoring/threshold
promotion. Eight real requests plus eight disabled-phase checks require 16
browser records. Existing-draft observer timing is not reused as delivery proof.

## Execution evidence

- Red `36103108141` at `fd1af66`: intended missing implementation on both OSes.
- Implementation `6c822f3`; first manual `36103364885` stopped before inference
  on an existing Windows helper deadline. Independent push passed those tests.
- CI-only `2e1b640` serializes setup test files; no deadline/quality changes.
- Final manual `36103664749` passes both host lifecycles, eight real speech
  attempts, 16 browser records and aggregate report. No retries or lifecycle skips.
- Full results, artifact IDs/hashes, retained earlier failure and real-device
  limitations are in the spec and deployment ledger. Accuracy research paused.
