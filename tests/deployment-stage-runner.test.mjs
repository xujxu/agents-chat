import assert from 'node:assert/strict';
import test from 'node:test';
import { runStage } from '../scripts/deployment/stage-runner.mjs';

const budget = { timeoutMs: 20, settlementMs: 100 };

test('stage returns completed result and preserves ordinary failure identity', async () => {
  assert.equal(await runStage('build', async signal => {
    assert.equal(signal.aborted, false);
    return 42;
  }, budget), 42);
  const failure = new Error('build failed');
  await assert.rejects(runStage('build', async () => { throw failure; }, budget),
    error => error === failure);
});

test('deadline waits for cancellation settlement and never returns late success', async () => {
  let settled = false;
  await assert.rejects(runStage('build', signal => new Promise(resolve => {
    signal.addEventListener('abort', () => {
      setTimeout(() => { settled = true; resolve('late success'); }, 10);
    }, { once: true });
  }), budget), error => {
    assert.equal(settled, true);
    assert.equal(error.code, 'DEPLOYMENT_STAGE_TIMEOUT');
    assert.equal(error.recoveryAllowed, true);
    assert.equal(error.stage, 'build');
    assert.ok(error.elapsedMs >= budget.timeoutMs);
    return true;
  });
});

test('unsettled worker blocks recovery after the termination allowance', async () => {
  let aborted = false;
  await assert.rejects(runStage('snapshot', signal => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }), { timeoutMs: 10, settlementMs: 10 }), error => {
    assert.equal(aborted, true);
    assert.equal(error.code, 'DEPLOYMENT_WORKER_UNSETTLED');
    assert.equal(error.recoveryAllowed, false);
    assert.equal(error.cause.code, 'DEPLOYMENT_STAGE_TIMEOUT');
    return true;
  });
});

test('late worker rejection is retained without becoming an unhandled rejection', async () => {
  const failure = new Error('owned worker termination failed');
  await assert.rejects(runStage('build', signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(failure), { once: true });
  }), budget), error => {
    assert.equal(error.code, 'DEPLOYMENT_STAGE_TIMEOUT');
    assert.equal(error.cause, failure);
    return true;
  });
});

test('worker-reported unsafe settlement cannot authorize recovery', async () => {
  const failure = Object.assign(new Error('descendant is still alive'), { recoveryAllowed: false });
  await assert.rejects(runStage('build', signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(failure), { once: true });
  }), budget), error => {
    assert.equal(error.recoveryAllowed, false);
    assert.equal(error.code, 'DEPLOYMENT_WORKER_UNSETTLED');
    assert.equal(error.cause, failure);
    return true;
  });
});

test('cancellation before start never invokes worker; in-flight cancellation awaits settlement', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(runStage('build', () => assert.fail('worker invoked'), {
    ...budget, signal: before.signal,
  }), { code: 'DEPLOYMENT_STAGE_CANCELLED' });
  const during = new AbortController();
  let settled = false;
  await assert.rejects(runStage('build', signal => new Promise(resolve => {
    signal.addEventListener('abort', () => { settled = true; resolve(); }, { once: true });
    during.abort();
  }), { ...budget, signal: during.signal }), error => {
    assert.equal(error.code, 'DEPLOYMENT_STAGE_CANCELLED');
    assert.equal(error.recoveryAllowed, true);
    assert.equal(settled, true);
    return true;
  });
});

test('invalid budgets fail before worker invocation; huge budgets do not overflow timers', async () => {
  for (const timeoutMs of [0, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(runStage('build', () => assert.fail('worker invoked'),
      { timeoutMs }), /budget/i);
  }
  await assert.rejects(runStage('build', () => assert.fail('worker invoked'),
    { timeoutMs: 10, settlementMs: 0 }), /budget/i);
  assert.equal(await runStage('build', async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return 'completed';
  }, { timeoutMs: Number.MAX_SAFE_INTEGER }), 'completed');
});

test('late synchronous completion cannot outrun the deadline timer', async () => {
  await assert.rejects(runStage('build', () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    return 'too late';
  }, { timeoutMs: 10, settlementMs: 100 }), error => {
    assert.equal(error.code, 'DEPLOYMENT_STAGE_TIMEOUT');
    assert.equal(error.recoveryAllowed, true);
    return true;
  });
});
