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
