# Voice Recording Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the transient exact-one-second recording prerequisite with an observed active recording at 1-29 seconds without weakening voice behavior checks.

**Architecture:** A test-only helper observes recording status and stop-button state in one browser evaluation and exposes a readiness predicate and bounded Playwright wait. Existing voice tests and deterministic controlled-DOM regressions use that same helper; production code and suite selection do not change.

**Tech Stack:** TypeScript, Playwright, existing GitHub Actions voice and E2E workflows.

---

## Scope and environment

Approved specification:
`docs/superpowers/specs/2026-09-26-voice-recording-readiness-design.md`
at cbbee45.

Use the current `experiment/voice-natural-long` worktree. Preserve others'
changes. No local validation commands, dependency installation, or servers.
Run the red and green revisions through existing PR-triggered Actions, not
duplicate manual dispatches or reruns. Inspect the expected failure before
implementing the repair. A passing unrelated rerun is not causal evidence.

Only these code files change:

- Create `tests/helpers/voiceRecordingReadiness.ts`: typed UI observation,
  readiness predicate, and shared wait.
- Modify `tests/voice-input.spec.ts`: regression cases and replacement of the
  final assertion in `record(page)`; all other existing assertions remain.

Update this plan and the approved spec with observed revision/run evidence at
closeout. No change to product code, workflow configuration, native diagnostics,
`tests/test-ui.spec.ts`, or Playwright timeout/retry settings is planned.

## Task 1: Establish the causal red regression

**Files:**
- Create: `tests/helpers/voiceRecordingReadiness.ts`
- Modify/test: `tests/voice-input.spec.ts:1-78`

- [x] **Step 1: Extract the exact-one-second prerequisite into the test helper.**

Create the following file. Its initial predicate deliberately retains the old
exact-one-second requirement. The status/control checks enforce the approved
observation contract without fixing the transient-second bug.

```ts
import { expect, type Page } from '@playwright/test';

export type VoiceRecordingObservation = {
  statusText: string | null;
  statusVisible: boolean;
  stopVisible: boolean;
  stopEnabled: boolean;
};

export async function observeVoiceRecording(
  page: Page,
): Promise<VoiceRecordingObservation> {
  return page.evaluate(() => {
    const statuses = document.querySelectorAll<HTMLElement>('.voiceStatus[role="status"]');
    const stops = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Stop recording"]',
    );
    if (statuses.length > 1 || stops.length > 1) {
      throw new Error('Expected at most one voice status and stop recording button');
    }
    const status = statuses.item(0);
    const stop = stops.item(0);
    const visible = (element: HTMLElement | null): boolean => {
      if (!element || getComputedStyle(element).visibility !== 'visible') return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    };
    return {
      statusText: status?.textContent ?? null,
      statusVisible: visible(status),
      stopVisible: visible(stop),
      stopEnabled: stop !== null && !stop.matches(':disabled'),
    };
  });
}

export function isVoiceRecordingReady(observation: VoiceRecordingObservation): boolean {
  return observation.statusVisible
    && observation.stopVisible
    && observation.stopEnabled
    && observation.statusText === 'Recording 0:01 / 0:30';
}

export async function waitForVoiceRecordingReady(page: Page): Promise<void> {
  await expect.poll(async () => {
    const observation = await observeVoiceRecording(page);
    return { ready: isVoiceRecordingReady(observation), observation };
  }, {
    message: 'Expected visible recording at 1-29 seconds with an enabled stop button',
  }).toMatchObject({ ready: true });
}
```

The helper uses the existing default five-second assertion timeout. Missing UI
produces a diagnostic observation that is not ready; browser errors and duplicate
UI controls throw explicitly. The synchronous browser evaluation avoids mixing
status text and button state from different awaits. Visibility follows the
rendered box and CSS visibility used by these concrete div/button elements;
opacity does not hide an element for this readiness check.

Add this import to the spec:

```ts
import {
  isVoiceRecordingReady,
  observeVoiceRecording,
  waitForVoiceRecordingReady,
  type VoiceRecordingObservation,
} from './helpers/voiceRecordingReadiness';
```

Replace only the final assertion in `record(page)`:

```ts
  await waitForVoiceRecordingReady(page);
```

- [x] **Step 2: Add regressions before the existing native-provider test.**

The first test invokes the actual shared wait with the first observation
already at two seconds. It must not catch the expected old timeout or change
its timeout. Use static test DOM, not the app clock or audio pipeline.

```ts
test('recording readiness accepts a first observation after the one-second display', async ({ page }) => {
  await page.setContent(`
    <div class="voiceStatus" role="status">Recording 0:02 / 0:30</div>
    <button aria-label="Stop recording">Stop</button>
  `);
  await waitForVoiceRecordingReady(page);
});

test('recording readiness enforces elapsed and active-control boundaries', () => {
  const active: VoiceRecordingObservation = {
    statusText: 'Recording 0:01 / 0:30',
    statusVisible: true,
    stopVisible: true,
    stopEnabled: true,
  };
  for (const seconds of ['01', '02', '29']) {
    expect(isVoiceRecordingReady({
      ...active,
      statusText: `Recording 0:${seconds} / 0:30`,
    }), `elapsed ${seconds}`).toBe(true);
  }
  for (const statusText of [
    null,
    '',
    'Recording 0:00 / 0:30',
    'Recording 0:30 / 0:30',
    'Recording 0:31 / 0:30',
    'Recording 0:99 / 0:30',
    'Recording 1:01 / 0:30',
    'Recording 0:01 / 0:31',
    'Recording 0:1 / 0:30',
    'Recording 0:001 / 0:30',
    'Recording 0:aa / 0:30',
    'Recording 0:-1 / 0:30',
    'Recording 0:01 / 0:30 trailing',
    'Recording 0:01 / 0:30\n',
    'Opening microphone…',
    'Transcribing…',
  ]) {
    expect(isVoiceRecordingReady({ ...active, statusText }), String(statusText)).toBe(false);
  }
  for (const field of ['statusVisible', 'stopVisible', 'stopEnabled'] as const) {
    expect(isVoiceRecordingReady({ ...active, [field]: false }), field).toBe(false);
  }
});

test('recording readiness observes missing, hidden, and disabled controls', async ({ page }) => {
  const cases = [
    { status: '', button: '', visible: false, enabled: false, text: null, statusVisible: false },
    { status: 'style="display:none"', button: '', visible: true, enabled: true, text: 'Recording 0:01 / 0:30', statusVisible: false },
    { status: '', button: 'hidden', visible: false, enabled: true, text: 'Recording 0:01 / 0:30', statusVisible: true },
    { status: '', button: 'disabled', visible: true, enabled: false, text: 'Recording 0:01 / 0:30', statusVisible: true },
    { status: '', button: 'style="visibility:hidden"', visible: false, enabled: true, text: 'Recording 0:01 / 0:30', statusVisible: true },
  ];
  for (const item of cases) {
    await page.setContent(item.text === null ? '' : `
      <div class="voiceStatus" role="status" ${item.status}>${item.text}</div>
      <button aria-label="Stop recording" ${item.button}>Stop</button>
    `);
    const observation = await observeVoiceRecording(page);
    expect(observation).toEqual({
      statusText: item.text,
      statusVisible: item.statusVisible,
      stopVisible: item.visible,
      stopEnabled: item.enabled,
    });
    expect(isVoiceRecordingReady(observation)).toBe(false);
  }
});
```

These tests are already selected by both existing voice and ordinary E2E
workflows on all three projects. No workflow selector or timeout change is
needed. The actual audio cases still use `prepare(page)` and `record(page)`.

- [x] **Step 3: Commit and push the red revision.**

```bash
git add tests/helpers/voiceRecordingReadiness.ts tests/voice-input.spec.ts
git commit -m "test: expose transient voice readiness prerequisite" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin experiment/voice-natural-long
```

- [x] **Step 4: Inspect the automatically triggered Actions red result.**

```bash
revision=$(git rev-parse HEAD)
gh run list -R xujxu/agents-chat --commit "$revision" \
  --workflow voice-input.yml --limit 5 \
  --json databaseId,headSha,status,conclusion,url
```

After the matching run completes, obtain bounded failure output:

```bash
revision=$(git rev-parse HEAD)
run_id=$(gh run list -R xujxu/agents-chat --commit "$revision" \
  --workflow voice-input.yml --limit 1 --json databaseId --jq '.[0].databaseId')
test -n "$run_id" && test "$run_id" != null &&
gh run view "$run_id" -R xujxu/agents-chat --log-failed |
  grep -n -E -C 5 'recording readiness|Expected|Received|Error:|failed|passed'
```

Expected: the controlled two-second wait fails after the existing assertion
window while its observation shows visible recording text at02 and an enabled
visible stop button. The elapsed-boundary test also rejects02 incorrectly.
Missing exports, browser startup, build, or observer exceptions are not the
intended red result: diagnose and correct harness defects before proceeding.
Keep other failures distinct. Use existing artifact metadata and only selected
trace resources if failure logs do not establish the observation.

## Task 2: Make the shared predicate semantic

**Files:**
- Modify: `tests/helpers/voiceRecordingReadiness.ts`
- Test unchanged: `tests/voice-input.spec.ts`

- [x] **Step 1: Replace `isVoiceRecordingReady` and preserve failure observations.**

```ts
export function isVoiceRecordingReady(observation: VoiceRecordingObservation): boolean {
  return observation.statusVisible
    && observation.stopVisible
    && observation.stopEnabled
    && /^Recording 0:(?:0[1-9]|1[0-9]|2[0-9]) \/ 0:30(?![\s\S])/.test(observation.statusText ?? '');
}
```

This accepts only the exact established format at01-29. It does not accept
30, arbitrary text containing a number, or a historical valid observation.
The final negative lookahead requires the actual end of the string, unlike
`$`, which can also match before a final newline. Do not alter the tests to
get green.

- [x] **Step 2: Commit and push the minimal repair.**

```bash
git add tests/helpers/voiceRecordingReadiness.ts
git commit -m "test: accept active voice recording after one second" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin experiment/voice-natural-long
```

- [x] **Step 3: Inspect both automatically triggered acceptance workflows.**

```bash
revision=$(git rev-parse HEAD)
gh run list -R xujxu/agents-chat --commit "$revision" \
  --workflow voice-input.yml --limit 5 \
  --json databaseId,headSha,status,conclusion,url
gh run list -R xujxu/agents-chat --commit "$revision" \
  --workflow playwright.yml --limit 5 \
  --json databaseId,headSha,status,conclusion,url
```

Expected: readiness regressions and all preexisting voice-input cases pass
on desktop Chromium, Android Chromium, and iPhone WebKit; voice workflow build,
typecheck, API and native-provider checks retain their existing behavior.
The broader streaming-save baseline issue is not repaired by this work and
must be reported separately if it recurs. A native-provider or infrastructure
failure does not authorize a new diagnostic batch or changing validation.

For each discovered run ID, inspect the job summary and bounded logs as in
Task1. If red/green behavior is not established, stop acceptance and diagnose
the concrete failure; do not rerun merely to obtain a pass.

## Task 3: Persist evidence and hand off the independent next scope

**Files:**
- Update: this plan and the approved specification.

- [x] **Step 1: Record observed acceptance evidence.**

Append an evidence section containing the actual red and green source SHAs,
Actions links/job outcomes, the two-second regression's red diagnostic and
green result, three-project voice results, and retained unrelated failures.
Include artifact IDs/digests only for artifacts actually inspected. Mark these
checkboxes according to actual execution, not intended outcomes.

- [x] **Step 2: Commit and push the evidence update.**

```bash
git add docs/superpowers/specs/2026-09-26-voice-recording-readiness-design.md \
  docs/superpowers/plans/2026-09-26-voice-recording-readiness.md
git commit -m "docs: retain recording readiness acceptance evidence" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin experiment/voice-natural-long
```

- [x] **Step 3: Close only this scoped repair.**

Keep PR #2 Draft. Update its existing status without overwriting unrelated
sections after refreshing the current body. Stop the progress reminder at
completion or an approval wait. The streaming-save baseline proceeds through
its own design approval; historical ECONNRESET and Windows residual findings
remain unresolved.

## Observed red evidence and diagnostic refinement

Red source c687254e7fbc8e860db85003e19e7f8fd20b9416, Actions
[36251145916](https://github.com/xujxu/agents-chat/actions/runs/36251145916),
failed precisely the controlled two-second waiter (5000ms) and the predicate
boundary at02. Build/typecheck and native prerequisite passed. The existing
two-failure limit stopped the remaining12 WebKit cases; later integration
steps were skipped, not passed.

Artifact10908739863, `voice-app-79d36c353363df0f27f0795d27d2098f74774bfd`,
is44634 bytes; archive digest
`73b539685ed32fe3b4b8057dd5cce37762c7e088b997f11e56d308da2a5dfe32`.
Eight recorded browser evaluations in the controlled two-second trace returned
`Recording 0:02 / 0:30` and all three visibility/enabled flags true. This
establishes the intended predicate failure, not a DOM observer failure.

The red log also revealed that `toMatchObject({ ready: true })` hides the
additional observation fields in its assertion diff. To satisfy the approved
failure-diagnostic contract, the green waiter returns `'ready'` only on success
and otherwise returns the complete observation, then asserts `.toBe('ready')`.
This changes only failure rendering alongside the predicate repair, not the
timeout, polling, accepted states, or regression expectations:

```ts
export async function waitForVoiceRecordingReady(page: Page): Promise<void> {
  await expect.poll(async () => {
    const observation = await observeVoiceRecording(page);
    return isVoiceRecordingReady(observation) ? 'ready' : observation;
  }, {
    message: 'Expected visible recording at 1-29 seconds with an enabled stop button',
  }).toBe('ready');
}
```

The local shell has no `rg` binary; the evidence inspection command above uses
available `grep`. This is log inspection, not local validation.

## Acceptance

Green source e3046ed59b8acb860e5e589fb154727233f6ba7d passed ordinary
[voice36251380385](https://github.com/xujxu/agents-chat/actions/runs/36251380385):
27 logic checks,14 WebKit cases,34 API/Chromium cases with1 existing skip,
1 authenticated real-model case,17 existing disabled-voice/composer/mobile
cases, build/typecheck, native smoke and temporary cleanup.
All new readiness cases and existing cancellation/automatic-stop cases passed
in desktop Chromium, Android Chromium and iPhone WebKit.

[Full E2E36251380383](https://github.com/xujxu/agents-chat/actions/runs/36251380383)
passed all6 jobs. Desktop shards passed80,80,78,45 cases with2 and35 existing
skips in the latter two; Android passed123/3 skipped; iPhone passed122/4 skipped.
[Persistence36251380378](https://github.com/xujxu/agents-chat/actions/runs/36251380378)
and all3 [typography36251380380](https://github.com/xujxu/agents-chat/actions/runs/36251380380)
jobs passed. No reruns or local validation were used.

Only this recording-readiness repair is accepted. The independently diagnosed
streaming-save baseline race remains outstanding even though its test passed
in this run. Historical ECONNRESET and Windows residual causes are unchanged.
PR #2 stays Draft; no native diagnostic or release work was added.

## Plan self-review

The helper has one responsibility and no product dependencies. Task1 checks
the shared wait at02, predicate range boundaries, invalid status, and inactive
controls. Task2 changes the semantic predicate and retains complete failure
observations as described above; all audio, cancellation
and duration assertions remain intact. Existing workflow selection covers
all three browser projects. No local validation or timeout/retry expansion is
introduced. Each exported symbol and test input is defined above.
