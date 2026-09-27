# Streaming Save Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the streaming test's save-count baseline only after valid initial and dispatch-confirmation saves have succeeded.

**Architecture:** A focused test helper retains every save arrival, validates the expected message transitions, and observes real backend response delivery. A held confirmation response provides deterministic red/green coverage in the existing browser scenario; independent contract cases exercise invalid sequences.

**Tech Stack:** TypeScript, Playwright, Node assertions, existing fixture-completion tracking, GitHub Actions.

---

## Approved boundary and files

Approved spec: `docs/superpowers/specs/2026-09-26-stream-save-baseline-design.md`
at6fa06c1. Current implementation baseline is5e1b666. Resume the current
worktree, preserve other changes, and do not run local tests/builds/servers or
install dependencies. Use ordinary PR-triggered Actions; no rerun-to-green.

- Create `tests/helpers/streamSaveBaseline.ts`: typed observations, transition
  validation, baseline evaluation and real-save observation fixture.
- Create `tests/stream-save-baseline.spec.ts`: deterministic contracts, selected
  by the existing desktop Playwright project without login or server requests.
- Modify only the streaming-thinking test and imports in `tests/test-ui.spec.ts`.
- Reuse `tests/helpers/fixtureCompletion.ts` unchanged for retained callback
  failures/draining. Its existing diagnostics say "sends"; no unrelated rename
  or lifecycle rewrite is needed.
- Update the approved spec and this plan with observed evidence at closeout.

No changes to product code, suite selectors, retry/timeout configuration,
audio tests, or native workflows. The original2500ms no-save interval and
10000/15000ms assertion windows stay in place.

## Task 1: Extract observation and demonstrate early readiness

**Files:** create both files above; modify the existing streaming-thinking
case at `tests/test-ui.spec.ts:3905-3996`.

- [x] **Step 1: Add the helper below, retaining the old baseline evaluation.**

The strict payload validator is shared by contracts and the real route fixture.
The intentionally old `streamSaveBaseline` returns a count after any matching
user save, ignoring acknowledgements. Task2 changes only that evaluator.

```ts
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { isRecord } from '../../lib/chatSyncProtocol';
import { createFixtureCompletion } from './fixtureCompletion';

export type StreamTurn = {
  userText: string;
  finalText: string;
  agentId: string;
};
export type StreamSave = {
  operationId: string;
  chatId: string;
  messages: Record<string, unknown>[];
  acknowledged: boolean;
  completionReleased: boolean;
};

export function parseStreamSave(body: unknown, completionReleased = false): StreamSave {
  assert.ok(isRecord(body) && body.action === 'save-sync', 'Expected inline save-sync');
  assert.ok(isRecord(body.operation), 'Missing inline save operation');
  const operation = body.operation;
  assert.ok(typeof operation.operationId === 'string' && operation.operationId.length > 0);
  assert.ok(isRecord(operation.expectedVersions), 'Missing expected versions');
  assert.ok(isRecord(operation.chat), 'Missing chat delta');
  const chat = operation.chat;
  assert.ok(typeof chat.id === 'string' && chat.id.length > 0);
  assert.ok(Array.isArray(chat.messages) && chat.messages.every(isRecord), 'Invalid messages');
  assert.ok(chat.removedMessageIds === undefined
    || (Array.isArray(chat.removedMessageIds) && chat.removedMessageIds.length === 0),
  'Unexpected message deletion');
  for (const message of chat.messages) {
    assert.ok(typeof message.id === 'string' && message.id.length > 0);
    assert.ok(typeof message.content === 'string');
    assert.ok(typeof message.ts === 'number' && Number.isFinite(message.ts));
    assert.ok(Object.hasOwn(operation.expectedVersions, message.id));
  }
  return {
    operationId: operation.operationId,
    chatId: chat.id,
    messages: chat.messages,
    acknowledged: false,
    completionReleased,
  };
}

export function acknowledgeStreamSave(save: StreamSave, httpOk: boolean, body: unknown): void {
  assert.ok(httpOk, 'Chat save HTTP failure');
  assert.ok(isRecord(body) && body.ok === true, 'Chat save API failure');
  assert.ok(isRecord(body.versions), 'Missing commit versions');
  for (const message of save.messages) {
    assert.ok(typeof message.id === 'string');
    const version = body.versions[message.id];
    assert.ok(typeof version === 'number' && Number.isSafeInteger(version) && version >= 0,
      'Invalid commit version');
  }
}

export function validateStreamSaves(saves: readonly StreamSave[], turn: StreamTurn): void {
  assert.ok(saves.length <= 3, 'Unexpected extra save');
  const initial = saves[0];
  if (!initial) return;
  assert.equal(new Set(saves.map(save => save.operationId)).size, saves.length,
    'Duplicate save operation');
  for (const save of saves) {
    assert.equal(save.chatId, initial.chatId, 'Foreign chat save');
    assert.equal(new Set(save.messages.map(message => message.id)).size, save.messages.length,
      'Duplicate message ID');
    for (const message of save.messages) {
      assert.ok(!Object.hasOwn(message, 'parts'), 'Frontend persisted message parts');
      assert.ok(message.attachments === undefined
        || (Array.isArray(message.attachments) && message.attachments.length === 0),
      'Unexpected attachments');
    }
  }
  assert.equal(initial.messages.length, 1, 'Initial save must contain only the user');
  const user = initial.messages[0];
  assert.equal(user.type, 'user');
  assert.equal(user.content, turn.userText);
  assert.equal(user.sendStatus, 'pending');
  assert.equal(user.sendError, undefined);
  assert.deepEqual(user.resendAgentIds, [turn.agentId]);
  assert.equal(user.resendMessage, turn.userText);

  const confirmation = saves[1];
  if (!confirmation) return;
  const users = confirmation.messages.filter(message => message.type === 'user');
  const agents = confirmation.messages.filter(message => message.type === 'agent');
  assert.equal(users.length, 1, 'Confirmation must update the same user');
  assert.ok(agents.length <= 1, 'Unexpected agent placeholder');
  assert.equal(confirmation.messages.length, users.length + agents.length);
  assert.equal(users[0].id, user.id, 'Changed user ID');
  assert.equal(users[0].content, user.content);
  assert.equal(users[0].ts, user.ts);
  for (const field of ['sendStatus', 'sendError', 'resendAgentIds', 'resendMessage']) {
    assert.equal(users[0][field], undefined, `Confirmation retained ${field}`);
  }
  if (agents[0]) {
    assert.equal(agents[0].agentId, turn.agentId);
    assert.equal(agents[0].content, '', 'Stream content saved before completion');
    assert.equal(agents[0].pending, true);
  }
  const final = saves[2];
  if (!final) return;
  assert.ok(final.completionReleased, 'Save arrived before completion release');
  assert.equal(final.messages.length, 1, 'Final delta must update only the agent');
  const answer = final.messages[0];
  assert.equal(answer.type, 'agent');
  assert.equal(answer.agentId, turn.agentId);
  assert.equal(answer.content, turn.finalText);
  assert.equal(answer.pending, false);
  if (agents[0]) assert.equal(answer.id, agents[0].id, 'Changed agent message ID');
}

export function streamSaveBaseline(
  saves: readonly StreamSave[], turn: StreamTurn,
): number | undefined {
  return saves.some(save => save.messages.some(message =>
    message.type === 'user' && message.content === turn.userText))
    ? saves.length : undefined;
}

export async function installStreamSaveFixture(page: Page, turn: StreamTurn) {
  const completion = createFixtureCompletion();
  const setupSaves: StreamSave[] = [];
  const saves: StreamSave[] = [];
  let started = false;
  let completionReleased = false;
  let confirmationHeld = false;
  let releaseConfirmation!: () => void;
  const confirmationGate = new Promise<void>(resolve => { releaseConfirmation = resolve; });
  await page.route('**/api/chats', route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body: unknown = route.request().postDataJSON();
    if (isRecord(body) && body.action === 'set-last-chat') {
      assert.ok(!body.chat && !body.operation, 'Save disguised as metadata action');
      return route.continue();
    }
    return completion.run(async () => {
      assert.ok(isRecord(body), 'Invalid chat request');
      const save = parseStreamSave(body, completionReleased);
      (started ? saves : setupSaves).push(save);
      if (started) validateStreamSaves(saves, turn);
      else assert.equal(save.messages.length, 0, 'Unexpected setup message save');
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
      const responseBody: unknown = await response.json();
      acknowledgeStreamSave(save, response.ok(), responseBody);
      if (started && saves[1] === save) {
        confirmationHeld = true;
        await confirmationGate;
      }
      await route.fulfill({ response });
      save.acknowledged = true;
    });
  });
  return {
    setupSaves,
    saves,
    get confirmationHeld() { return confirmationHeld; },
    releaseConfirmation,
    async beginTurn() {
      await completion.waitForCount(completion.count);
      assert.ok(setupSaves.every(save => save.acknowledged));
      started = true;
    },
    baseline() {
      completion.assertHealthy();
      return streamSaveBaseline(saves, turn);
    },
    assertStreaming(baseline: number) {
      completion.assertHealthy();
      validateStreamSaves(saves, turn);
      assert.equal(saves.length, baseline, 'Frontend saved during streaming');
    },
    releaseTurn(baseline: number) {
      this.assertStreaming(baseline);
      completionReleased = true;
    },
    finalReady(baseline: number) {
      completion.assertHealthy();
      validateStreamSaves(saves, turn);
      assert.ok(saves.length <= baseline + 1, 'Extra final save');
      return saves.length === baseline + 1 && saves.every(save => save.acknowledged);
    },
    async dispose() {
      releaseConfirmation();
      try {
        await completion.waitForCount(completion.count);
      } finally {
        await completion.close(() => page.goto('about:blank'), async () => {});
      }
    },
  };
}
```

The helper uses Node assertions and the caller owns bounded Playwright waiting.
No runtime import from the server SQLite modules is needed; `isRecord` is the
existing pure protocol guard.

- [x] **Step 2: Add deterministic contract tests.**

Create `tests/stream-save-baseline.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import {
  acknowledgeStreamSave, parseStreamSave, streamSaveBaseline, validateStreamSaves,
  type StreamSave, type StreamTurn,
} from './helpers/streamSaveBaseline';

const turn: StreamTurn = { userText: 'question', finalText: 'answer', agentId: 'alpha' };
const user = { id: 'u', type: 'user', content: 'question', ts: 1 };
const agent = { id: 'a', type: 'agent', agentId: 'alpha', content: '', ts: 2, pending: true };

function save(id: string, messages: Record<string, unknown>[]): StreamSave {
  return parseStreamSave({
    action: 'save-sync',
    operation: {
      operationId: id,
      expectedVersions: Object.fromEntries(messages.map(message => [String(message.id), null])),
      chat: { id: 'chat', messages },
    },
  });
}

function sequence(): StreamSave[] {
  const first = save('initial', [{
    ...user, sendStatus: 'pending', resendAgentIds: ['alpha'], resendMessage: 'question',
  }]);
  first.acknowledged = true;
  return [first, save('confirmation', [{ ...user }, { ...agent }])];
}

test('stream baseline waits for initial and confirmation acknowledgements', () => {
  expect(streamSaveBaseline([], turn)).toBeUndefined();
  const saves = sequence();
  expect(streamSaveBaseline(saves.slice(0, 1), turn)).toBeUndefined();
  expect(streamSaveBaseline(saves, turn)).toBeUndefined();
  saves[1].acknowledged = true;
  saves[0].acknowledged = false;
  expect(streamSaveBaseline(saves, turn)).toBeUndefined();
  saves[0].acknowledged = true;
  expect(streamSaveBaseline(saves, turn)).toBe(2);
});

test('stream baseline rejects invalid or extra saves rather than absorbing them', () => {
  const mutations: Array<(saves: StreamSave[]) => void> = [
    saves => { saves[1].operationId = saves[0].operationId; },
    saves => { saves[1].chatId = 'foreign'; },
    saves => { saves[1].messages[0].id = 'other-user'; },
    saves => { saves[1].messages[0].content = 'changed'; },
    saves => { saves[1].messages[0].sendStatus = 'pending'; },
    saves => { saves[1].messages[0].resendMessage = 'question'; },
    saves => { saves[0].messages[0].parts = [{ type: 'thinking', text: 'early' }]; },
    saves => { saves[1].messages[1].content = 'early thinking'; },
    saves => { saves[1].messages[1].parts = [{ type: 'thinking', text: 'early' }]; },
    saves => { saves[1].messages.push({ ...agent, id: 'extra' }); },
    saves => { saves[1].messages = [{ ...agent }]; },
    saves => { saves.push(save('extra', [{ ...agent, content: 'answer', pending: false }])); },
  ];
  for (const mutate of mutations) {
    const saves = sequence();
    saves[1].acknowledged = true;
    mutate(saves);
    expect(() => streamSaveBaseline(saves, turn)).toThrow();
  }
});

test('stream save parsing and acknowledgement failures are explicit', () => {
  expect(() => parseStreamSave({ action: 'save-sync' })).toThrow();
  expect(() => parseStreamSave({ action: 'unknown', chat: {} })).toThrow();
  expect(() => parseStreamSave({
    action: 'save-sync',
    operation: { operationId: 'delete', expectedVersions: {}, chat: {
      id: 'chat', messages: [], removedMessageIds: ['u'],
    } },
  })).toThrow();
  const initial = sequence()[0];
  initial.acknowledged = false;
  for (const [httpOk, body] of [
    [false, { ok: true, versions: { u: 1 } }],
    [true, { ok: false }],
    [true, null],
    [true, { ok: true, versions: {} }],
    [true, { ok: true, versions: { u: -1 } }],
  ] as const) {
    expect(() => acknowledgeStreamSave(initial, httpOk, body)).toThrow();
    expect(initial.acknowledged).toBe(false);
  }
  acknowledgeStreamSave(initial, true, { ok: true, versions: { u: 1 } });
  expect(initial.acknowledged).toBe(false);
});

test('stream final save preserves identity and occurs only after release', () => {
  const saves = sequence();
  saves[1].acknowledged = true;
  const final = save('final', [{ ...agent, content: 'answer', pending: false }]);
  saves.push(final);
  expect(() => validateStreamSaves(saves, turn)).toThrow();
  final.completionReleased = true;
  expect(() => validateStreamSaves(saves, turn)).not.toThrow();
  final.messages[0].id = 'different-agent';
  expect(() => validateStreamSaves(saves, turn)).toThrow();
  final.messages[0].id = 'a';
  saves.push(save('fourth', []));
  expect(() => validateStreamSaves(saves, turn)).toThrow();
});
```

- [x] **Step 3: Wire the same helper into the existing UI test.**

Add:

```ts
import { installStreamSaveFixture } from './helpers/streamSaveBaseline';
```

Inside only `should render streaming thinking parts without frontend stream
saves`, replace `const chatPosts: any[] = [];` and the entire existing chats
route block with:

```ts
    const persistence = await installStreamSaveFixture(page, {
      userText, finalText, agentId: 'alpha',
    });
```

Keep the ACP route mock and its events unchanged. Replace everything after its
registration through the end of this test with:

```ts
    try {
      await page.reload();
      await page.waitForSelector('.chatContainer', { timeout: 30000 });
      await persistence.beginTurn();
      await textarea.fill(userText);
      await page.click('button[aria-label="Send message"]');
      await expect(chatArea.locator(`.message.user:has-text("${userText}")`))
        .toBeVisible({ timeout: 15000 });
      await expect(chatArea.locator(`.thinkingPartText:has-text("${thinkingText}")`))
        .toBeVisible({ timeout: 15000 });
      await expect.poll(() => {
        persistence.baseline();
        return persistence.confirmationHeld;
      }, { timeout: 10000 }).toBe(true);

      expect(persistence.baseline(),
        'Confirmation response is held; the baseline must remain pending').toBeUndefined();
      persistence.releaseConfirmation();
      await expect.poll(() => persistence.baseline(), { timeout: 10000 }).toBe(2);
      const baseline = persistence.baseline();
      if (baseline === undefined) throw new Error('Acknowledged baseline disappeared');
      await page.waitForTimeout(2500);
      persistence.assertStreaming(baseline);
      expect(pollCount).toBeGreaterThan(0);

      persistence.releaseTurn(baseline);
      finishTurn = true;
      await expect(chatArea.locator(`.message.agent:has-text("${finalText}")`))
        .toBeVisible({ timeout: 15000 });
      await expect(page.locator('button[aria-label="Stop generation"]'))
        .toBeHidden({ timeout: 15000 });
      await expect.poll(() => persistence.finalReady(baseline), { timeout: 10000 }).toBe(true);
      expect(persistence.saves).toHaveLength(baseline + 1);
      expect(persistence.saves.at(-1)?.messages.some(message =>
        message.type === 'agent' && message.content === finalText)).toBe(true);
      console.log('PASS: streaming thinking parts render without frontend stream saves');
    } finally {
      await persistence.dispose();
    }
```

The poll before the gate assertion calls the real evaluator to expose retained
route failures, not a duplicate readiness approximation. The direct pending
assertion is the causal red/green boundary. The later `toBe(2)` is justified by
semantic validation of the two transitions, not by blindly increasing a count.

- [x] **Step 4: Commit and push the red revision.**

```bash
git add tests/helpers/streamSaveBaseline.ts tests/stream-save-baseline.spec.ts tests/test-ui.spec.ts
git commit -m "test: expose early streaming save baseline" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin experiment/voice-natural-long
```

- [x] **Step 5: Inspect the automatically triggered Actions run.**

```bash
revision=$(git rev-parse HEAD)
gh run list -R xujxu/agents-chat --commit "$revision" --workflow playwright.yml \
  --limit 5 --json databaseId,headSha,status,conclusion,url
```

Record the exact discovered run ID in the todo/evidence. Watch that run without
starting another one. After completion, use `gh run view` on that ID with
`--log-failed`, selecting only the test titles and failure context; download
only the affected artifact when necessary.

Expected red: the UI reaches visible thinking and a held successful backend
confirmation response, but the old evaluator returns2 instead of pending.
The initial-only/held-ack contract and invalid-sequence contracts also fail.
Missing modules, build errors, rejected fixture payloads, or inability to reach
the gate are harness issues, not the required red; fix those without weakening
the intended assertions before proceeding.

## Task 2: Enforce the semantic acknowledged baseline

**Files:** modify `tests/helpers/streamSaveBaseline.ts`; all regression
expectations stay unchanged.

- [x] **Step 1: Replace only the baseline evaluator.**

```ts
export function streamSaveBaseline(
  saves: readonly StreamSave[], turn: StreamTurn,
): number | undefined {
  validateStreamSaves(saves, turn);
  assert.ok(saves.length <= 2, 'Save arrived before baseline was frozen');
  if (saves.length !== 2 || !saves.every(save => save.acknowledged)) return undefined;
  return saves.length;
}
```

This checks every recorded payload even while pending. It never treats unknown
or extra saves as settling traffic. `finalReady` separately validates the
post-release third save; do not call the pre-completion baseline evaluator
after releasing completion.

- [x] **Step 2: Commit and push the repair.**

```bash
git add tests/helpers/streamSaveBaseline.ts
git commit -m "test: await acknowledged streaming save baseline" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin experiment/voice-natural-long
```

- [x] **Step 3: Inspect automatic acceptance.**

```bash
revision=$(git rev-parse HEAD)
gh run list -R xujxu/agents-chat --commit "$revision" --limit 10 \
  --json databaseId,workflowName,status,conclusion,url
```

Require contract cases and the real held-confirmation UI case to pass, including
the2500ms no-save check and acknowledged final save. Check all6 ordinary E2E
jobs and applicable automatic persistence/typography checks, preserving earlier
voice acceptance. No broader manual native/voice batch is needed for test-only
changes outside those scopes.

If the actual payload differs from the inspected evidence, report the exact
difference before changing the contract; do not permit extra saves or stream
content merely to obtain green. If teardown produces a retained route failure,
fix its lifecycle cause rather than adding ignored-error cleanup. Keep unrelated
failures separate and do not rerun them until green.

## Task 3: Persist acceptance evidence

**Files:** the approved specification and this plan; existing Draft PR #2 body.

- [x] **Step 1: Record actual red/green results.**

Add source revisions, exact run URLs, red held-response assertion diagnostics,
green contract/browser results and relevant artifact IDs/digests if inspected.
Mark task checkboxes by actual outcome. Do not claim that this repair diagnoses
historical transport resets or Windows leftovers.

- [x] **Step 2: Commit and push evidence.**

```bash
git add docs/superpowers/specs/2026-09-26-stream-save-baseline-design.md \
  docs/superpowers/plans/2026-09-26-stream-save-baseline.md
git commit -m "docs: retain streaming baseline acceptance evidence" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin experiment/voice-natural-long
```

- [x] **Step 3: Refresh and update PR #2 without removing historical evidence.**

Fetch the current body with `gh pr view 2 -R xujxu/agents-chat --json body`.
Add the scoped repair and actual results, preserving all unrelated sections.
Use `gh pr edit --body-file` and verify the resulting body and Draft state.
Stop the progress reminder and close only this approved repair.

## Self-review

The same baseline evaluator is used by contract tests and the real browser
case. The gate holds a validated real response after backend success and before
fulfillment; acknowledgement is set only after fulfillment. Setup saves are
retained and drained before `beginTurn`; any later save belongs to the strict
turn sequence. Late callbacks/errors are retained by the existing completion
tracker. Final-save identity and acknowledgement remain separate from baseline
readiness. No production exports, new runners, timeout increases or retries
are introduced.

## Initial red evidence and fixture correction

Source c38382e7f7c7abca9e3054af0870c2cfb25d3c38, full E2E
[36287256431](https://github.com/xujxu/agents-chat/actions/runs/36287256431):
four jobs passed; desktop2 failed precisely the two baseline contracts
(initial-only returned1; duplicate-operation evaluator did not throw).
Desktop3 reached the intended held-response assertion: trace `expect@176`
at194041.672 reports "Confirmation response is held; the baseline must remain
pending", received2. However, teardown then reported "Send arrived during
fixture teardown", masking the primary assertion in the job log.

The retained desktop3 trace identifies the late request as `set-last-chat`
at194059.986, after releasing the confirmation response. This is metadata,
not a chat save. The initial fixture incorrectly enrolled every POST in the
save-completion tracker. Correct the fixture by distinguishing that explicit
metadata action before registering save lifecycle work, retaining its existing
shape assertion and normal `route.continue` rejection behavior. Unknown or
disguised saves still fail; actual save callbacks remain tracked and drained.
No error is caught or ignored and the baseline evaluator remains unchanged.

Artifact10920812695, `playwright-artifacts-desktop-3`, is2835256 bytes;
archive SHA256
`6f5c37b7879222ba0246a04d4456ac6327c4a89e66c86d32c71f95cbc93c6fdb`.
The trace contains both the browser request and its `route.fetch` request;
those paired network records are not duplicate frontend save arrivals.

Push this metadata-classification correction as a new red revision and confirm
the intended UI failure appears without the teardown violation before applying
Task2. This is a fixture repair with new source, not a retry of the same revision.

Corrected red source f38aa52b58e2e124018f6ef887b5834909b3d6d9,
[36288035696](https://github.com/xujxu/agents-chat/actions/runs/36288035696),
now reports only the intended held-confirmation failure in the browser scenario:
received2 where pending was required. Desktop3 has78 passed,2 skipped,1 failed;
desktop2 has79 passed and the2 expected contract failures. Other4 jobs passed.
The teardown violation is absent. This is the required clean red checkpoint;
Task2 changes only the baseline evaluator, leaving those assertions unchanged.

## Green acceptance

Source6a261b91b450e4c84d53645d3d3678a01eaf660f passed
[E2E36288645244](https://github.com/xujxu/agents-chat/actions/runs/36288645244),
all6 jobs. Desktop shards passed81,81,79,46 cases with2 and35 existing skips
in the latter two; Android123 passed/3 skipped; iPhone122 passed/4 skipped.
The4 new contract cases and actual held-confirmation streaming UI case passed
in their desktop-selected jobs, including final save acknowledgement.

[Persistence36288645351](https://github.com/xujxu/agents-chat/actions/runs/36288645351),
[typography36288645251](https://github.com/xujxu/agents-chat/actions/runs/36288645251)
and [voice36288645247](https://github.com/xujxu/agents-chat/actions/runs/36288645247)
also passed. No manual reruns, product changes or local validation were used.
The companion specification retains the complete red/fixture-correction/green
evidence and its limits. PR #2 remains Draft; historical transport-reset and
Windows-residual causes remain unresolved.
