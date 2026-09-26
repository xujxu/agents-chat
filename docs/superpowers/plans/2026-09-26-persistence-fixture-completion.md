# Persistence Fixture Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution. That skill is unavailable here; use user-approved inline task checkpoints.

**Goal:** Wait for fixture send processing to finish without weakening dispatch assertions or suppressing errors.

**Architecture:** A dependency-free test helper tracks arrival, settlement and shutdown. The existing persistence fixture registers whole send callbacks and exposes explicit completion waits and ordered teardown. Deferred unit tests and one real-fixture browser regression protect the boundary.

**Tech Stack:** TypeScript, Node24 strip-types/test, Playwright, existing GitHub Actions persistence workflow.

---

Approved spec8da51e0:
`docs/superpowers/specs/2026-09-26-persistence-fixture-completion-design.md`.
No product edits. All validation runs in Actions, never locally.

## Files

- Create `tests/helpers/fixtureCompletion.ts`: lifecycle tracking only.
- Create `tests/chat-fixture-completion.test.ts`: deterministic helper contracts.
- Modify `tests/chat-persistence.spec.ts`: register existing callback, wait at
  positive consumers, centralized disposal and browser regression.
- Modify `.github/workflows/chat-persistence.yml`: contracts job and optional
  contracts-only dispatch, preserving existing full suite.
- Update approved spec and this plan with evidence after execution.

## Task 1: Deterministic red contracts

- [x] Create the following dependency-free test file before the helper:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createFixtureCompletion } from './helpers/fixtureCompletion.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('arrival precedes completion through all three stages', { timeout: 2000 }, async () => {
  const tracker = createFixtureCompletion();
  const gates = [deferred(), deferred(), deferred()];
  const entered: number[] = [];
  const running = tracker.run(async () => {
    for (const [index, gate] of gates.entries()) {
      entered.push(index);
      await gate.promise;
    }
  });
  let completed = false;
  const waiting = tracker.waitForCount(1).then(() => { completed = true; });
  try {
    assert.equal(tracker.count, 1);
    for (let index = 0; index < gates.length; index++) {
      await nextTurn();
      assert.deepEqual(entered, Array.from({ length: index + 1 }, (_, n) => n));
      assert.equal(tracker.completedCount, 0);
      assert.equal(completed, false);
      gates[index].resolve();
    }
    await running;
    await waiting;
    assert.equal(tracker.completedCount, 1);
    assert.equal(completed, true);
  } finally {
    gates.forEach(gate => gate.resolve());
    await Promise.all([running, waiting]);
  }
});

for (const stage of [0, 1, 2]) {
  test(`stage ${stage} rejection remains observable`, async () => {
    const tracker = createFixtureCompletion();
    const failure = new Error(`stage-${stage}`);
    const reached: number[] = [];
    const running = tracker.run(async () => {
      for (let index = 0; index < 3; index++) {
        reached.push(index);
        if (index === stage) throw failure;
        await Promise.resolve();
      }
    });
    await assert.rejects(running, error => error === failure);
    await assert.rejects(tracker.waitForCount(1), error => error === failure);
    assert.throws(() => tracker.assertHealthy(), error => error === failure);
    let deleted = false;
    await assert.rejects(tracker.close(async () => {}, async () => {
      deleted = true;
    }), error => error === failure);
    assert.equal(deleted, true);
    assert.equal(tracker.completedCount, 0);
    assert.deepEqual(reached, Array.from({ length: stage + 1 }, (_, n) => n));
  });
}

test('exact count rejects extra arrival even during a wait', async () => {
  const tracker = createFixtureCompletion();
  const gate = deferred();
  const first = tracker.run(() => gate.promise);
  const waiting = tracker.waitForCount(1);
  const rejected = assert.rejects(waiting, /Expected 1 sends, received 2/);
  const second = tracker.run(async () => {});
  gate.resolve();
  await Promise.all([first, second, rejected]);
  await assert.rejects(tracker.waitForCount(1), /Expected 1 sends, received 2/);
  await tracker.waitForCount(2);
});

test('out-of-order settlement never completes the pending operation', async () => {
  const tracker = createFixtureCompletion();
  const gate = deferred();
  const first = tracker.run(() => gate.promise);
  await tracker.run(async () => {});
  assert.equal(tracker.count, 2);
  assert.equal(tracker.completedCount, 1);
  let finished = false;
  const waiting = tracker.waitForCount(2).then(() => { finished = true; });
  await nextTurn();
  assert.equal(finished, false);
  gate.resolve();
  await Promise.all([first, waiting]);
  assert.equal(tracker.completedCount, 2);
});

test('close drains before deleting and rejects late work', { timeout: 2000 }, async () => {
  const tracker = createFixtureCompletion();
  const gate = deferred();
  const events: string[] = [];
  const running = tracker.run(async () => { await gate.promise; events.push('settled'); });
  const closing = tracker.close(
    async () => { events.push('stop'); },
    async () => { events.push('delete'); },
  );
  const rejected = assert.rejects(closing, /Send arrived during fixture teardown/);
  let lateRan = false;
  assert.throws(() => tracker.run(async () => { lateRan = true; }), /Send arrived during fixture teardown/);
  await nextTurn();
  assert.deepEqual(events, ['stop']);
  gate.resolve();
  await Promise.all([running, rejected]);
  assert.equal(lateRan, false);
  assert.deepEqual(events, ['stop', 'settled', 'delete']);
});

test('shutdown preserves stop, operation and deletion failures', async () => {
  const tracker = createFixtureCompletion();
  const operation = new Error('operation');
  const stop = new Error('stop');
  const deletion = new Error('deletion');
  await assert.rejects(tracker.run(async () => { throw operation; }), error => error === operation);
  await assert.rejects(tracker.close(
    async () => { throw stop; },
    async () => { throw deletion; },
  ), error => error instanceof AggregateError
    && error.errors.length === 3
    && error.errors.includes(operation)
    && error.errors.includes(stop)
    && error.errors.includes(deletion));
});
```

- [x] Add `tests/helpers/fixtureCompletion.ts` to workflow PR path selectors.
  Add manual input and contracts job; set persistence job dependency/gate:

```yaml
  workflow_dispatch:
    inputs:
      contracts_only:
        description: Run fixture completion contracts without application/browser jobs
        type: boolean
        default: false
```

```yaml
  contracts:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.20.0
      - run: node --test tests/chat-fixture-completion.test.ts
  persistence:
    needs: contracts
    if: ${{ !inputs.contracts_only }}
```

  Keep remaining persistence job steps unchanged. TypeScript imports include
  `.ts` for direct Node execution; no package installation is needed in contracts.
- [x] Commit tests/workflow/plan, push and dispatch the red contracts:

```bash
gh workflow run chat-persistence.yml -R xujxu/agents-chat --ref experiment/voice-natural-long -f contracts_only=true
```

  Expect missing-helper import failure and skipped persistence job. Record run ID
  and inspect intended failure before implementation; do not repeat on recovery.

## Task 2: Completion helper

- [x] Implement the helper with ordered settlement records and retained failures:

```ts
type Outcome = { ok: true } | { ok: false; error: unknown };
type Operation = { done: Promise<Outcome>; outcome?: Outcome };

function throwFailures(errors: unknown[]) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Fixture lifecycle failed');
}

export function createFixtureCompletion() {
  const operations: Operation[] = [];
  const violations: Error[] = [];
  let closing = false;
  const failures = () => [
    ...operations.flatMap(operation =>
      operation.outcome && !operation.outcome.ok ? [operation.outcome.error] : []),
    ...violations,
  ];
  const checkCount = (expected: number) => {
    if (operations.length !== expected) {
      throw new Error(`Expected ${expected} sends, received ${operations.length}`);
    }
  };
  return {
    get count() { return operations.length; },
    get completedCount() {
      return operations.filter(operation => operation.outcome?.ok).length;
    },
    assertHealthy() { throwFailures(failures()); },
    run(work: () => Promise<void>): Promise<void> {
      if (closing) {
        const error = new Error('Send arrived during fixture teardown');
        violations.push(error);
        throw error;
      }
      const running = Promise.resolve().then(work);
      const operation: Operation = {
        done: running.then(
          (): Outcome => {
            operation.outcome = { ok: true };
            return operation.outcome;
          },
          (error: unknown): Outcome => {
            operation.outcome = { ok: false, error };
            return operation.outcome;
          },
        ),
      };
      operations.push(operation);
      return running;
    },
    async waitForCount(expected: number) {
      checkCount(expected);
      await Promise.all(operations.map(operation => operation.done));
      throwFailures(failures());
      checkCount(expected);
    },
    async close(stopTraffic: () => Promise<unknown>, removeChat: () => Promise<unknown>) {
      closing = true;
      const errors: unknown[] = [];
      try { await stopTraffic(); } catch (error) { errors.push(error); }
      await Promise.all(operations.map(operation => operation.done));
      try { await removeChat(); } catch (error) { errors.push(error); }
      errors.push(...failures());
      throwFailures(errors);
    },
  };
}
```

  Catching stop/removal errors is explicit aggregation, not suppression.
  `done` always resolves to a tagged outcome; original `running` still rejects
  for route callers. Registration happens synchronously before work's first
  microtask. No network retries, timer abstraction or product dependency.

- [x] Commit/push helper; dispatch contracts-only and expect8passed.
  Inspect any failures before proceeding. Counts:1stage-gate +3rejections
  +1count +1out-of-order +1drain +1aggregation.

## Task 3: Wire actual fixture and browser regression

- [x] Import the helper in `tests/chat-persistence.spec.ts`. Beside existing
  `sent` state add:

```ts
const completion = createFixtureCompletion();
let replyWriteGate: { promise: Promise<void>; entered: () => void } | null = null;
```

  Within the send branch wrap the existing body in
  `return completion.run(async () => { ... });`. Keep `sent.push` as the first
  operation inside that callback, before `loadStored`. No awaits precede it.
  Before the synthetic reply POST add:

```ts
if (replyWriteGate) {
  const gate = replyWriteGate;
  gate.entered();
  await gate.promise;
}
```

  Change the existing `return route.fulfill(...)` to
  `await route.fulfill(...)` within the tracked operation, so its Promise<void>
  resolves only after fulfillment. Preserve all existing message/route data.

- [x] Add these fixture methods:

```ts
get completedSends() { return completion.completedCount; },
async waitForSends(expected: number) {
  await expect.poll(() => {
    completion.assertHealthy();
    return completion.count;
  }).toBe(expected);
  await completion.waitForCount(expected);
},
holdReplyWrite() {
  if (replyWriteGate) throw new Error('Reply write is already held');
  let release!: () => void;
  let entered!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  replyWriteGate = { promise, entered };
  return {
    entered: reached,
    release() { replyWriteGate = null; release(); },
  };
},
async dispose(extraChatIds: string[] = []) {
  await completion.close(
    () => page.goto('about:blank'),
    async () => {
      const results = await Promise.allSettled(
        [chat.id, ...extraChatIds].map(async id => {
          expect((await request.delete(`/api/chats?id=${id}`)).ok()).toBeTruthy();
        }),
      );
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Fixture chat deletion failed');
    },
  );
},
```

  A positive wait uses existing Playwright polling for arrival, then awaits
  tracked settlement under the existing test timeout. It is not a new longer
  timeout. Preserve the one existing15second arrival wait, adding completion
  immediately after it rather than reducing that scenario's allowed interval.

- [x] For each successful-send assertion, retain the assertion and add
  `await fixture.waitForSends(expectedCount)` immediately after it. In cases
  relying solely on visible reply, also wait before reading/reloading/cleanup.
  Both large-message sends wait separately (counts1and2). Add completion after
  the durable-save case's positive count, before using savedBeforeSend.
  Negative sent assertions and intentional in-flight reloads remain unchanged.
- [x] Replace fixture-owning finally navigation/deletion pairs with
  `await fixture.dispose()`, after existing releases. For recovered-chat cleanup,
  use `await fixture.dispose(recoveredId ? [recoveredId] : [])`. Do not replace
  setup navigation, tests without this fixture, or intentional mid-test deletion.
  Check DELETE response semantics before expecting success for already-deleted
  fixture chats; preserve API idempotency rather than modifying product code.

- [x] Add actual-fixture browser coverage:

```ts
test('fixture completion waits for the synthetic reply write', async ({ page }) => {
  const fixture = await installPersistenceFixture(page);
  const held = fixture.holdReplyWrite();
  try {
    await send(page, 'Wait for fixture completion');
    await held.entered;
    expect(fixture.sent).toEqual(['Wait for fixture completion']);
    expect(fixture.completedSends).toBe(0);
    held.release();
    await fixture.waitForSends(1);
    expect(fixture.completedSends).toBe(1);
    await expect(page.getByText('Saved reply 1', { exact: true })).toBeVisible();
    expect(fixture.savedBeforeSend).toEqual([true]);
  } finally {
    held.release();
    await fixture.dispose();
  }
});
```

  The deterministic helper red/green proves ordering independent of timing;
  this browser case proves the real fixture uses that boundary. No forced
  unhandled Playwright route failure is added.

- [x] Commit/push fixture changes. Use the automatically triggered persistence
  run if present; otherwise dispatch full workflow once with
  `-f contracts_only=false`. Expect8helper checks and all original persistence
  coverage plus the new browser case across configured projects.

## Task 4: Acceptance and evidence

- [x] Read workflow build/typecheck and browser results. New work is test-only;
  ordinary production typecheck excludes tests, so rely on executed TypeScript
  contracts/browser compilation as well, not a misleading product-only check.
- [x] If transport failure reappears, retain artifacts and stop attribution:
  fixing fixture completion is not evidence of solving ECONNRESET. Do not add
  retries, ignored errors, payload reductions or new diagnostic cohorts.
- [x] Inspect other automatically triggered checks without duplicate dispatch.
  Repair only directly caused regressions; unrelated issues require approval.
- [x] Update spec/plan and refreshed Draft PR #2 with exact revisions/run IDs,
  counts, skips, artifact locations and unresolved original incidents.
- [x] Commit and push with trailer:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

- [x] Verify clean pushed state and stop progress reminder when scope completes
  or awaits user approval. No merge, release or product changes.

## Self-review

Helper tests cover stages, rejection identity, late arrival, exact count,
out-of-order completion and deletion sequencing. Browser gate covers actual
fixture wiring. Arrival semantics, interrupted-save behavior and assertion
thresholds remain intact. The only required workflow expansion is a small
contracts prerequisite with a manual contracts-only selector.

## Execution checkpoint

Inline execution was approved. Tests15be8f4 produced the intended missing-helper
red in36237914612; application job skipped. Helpera9b7770 run36237963315 passed
7/8: the out-of-order test exposed a redundant Promise reaction that published
the completed outcome after the original caller resumed. Correctionaa9aec9
publishes the outcome in the first observer, preserving the original rejection
and all assertions;36238009699 passed8/8, application job skipped.

Fixture wiring13c98eb registers whole send callbacks, keeps received-text
observations, adds explicit waits at positive consumers, and centralizes final
draining/deletion. Existing interrupted-save releases and negative dispatch
assertions remain intact. DELETE is idempotent in the current API/store, so
cleanup now checks the response without changing already-deleted-chat cases.
Persistence36238088471 passed8completion contracts,13existing logic checks,
build/typecheck,50desktop cases,8existing-send cases,40mobile cases and12existing
repeated WebKit network/reload cases. New gate regression passed all3projects.
Artifact10905595520 is retained and specified in the design evidence.
No transport failure recurred in this run; its historical cause remains unknown.

Voice36238088478 and typography36238088453 passed. Full E2E36238088445 had4jobs
pass and2fail: Android voice exact1second recording label absent, desktop3
streaming save count2rather than1. These tests do not import the changed fixture.
Their logs/artifact identities are recorded in the spec; no unrelated code
change, error suppression or rerun was performed. Fixture acceptance is complete,
but overall PR acceptance remains blocked on separately scoped investigation.
