import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnsettledWorker } from '../scripts/deployment/worker-errors.mjs';

const unsafe = () => Object.assign(new Error('writer still alive'), { recoveryAllowed: false });

test('worker uncertainty survives nested causes and aggregates without changing the errors', () => {
  const original = unsafe();
  const wrapped = new Error('adapter failed', { cause: original });
  const aggregate = new AggregateError([new Error('ordinary'), wrapped]);
  Object.assign(aggregate, { recoveryAllowed: true });
  assert.equal(hasUnsettledWorker(original), true);
  assert.equal(hasUnsettledWorker(wrapped), true);
  assert.equal(hasUnsettledWorker(aggregate), true);
  assert.equal(aggregate.recoveryAllowed, true);
  assert.equal(wrapped.cause, original);
});

test('ordinary failures and primitive causes do not forbid normal recovery', () => {
  for (const error of [
    undefined, null, 'failure', 0, false, new Error('ordinary'),
    new Error('wrapper', { cause: 'text' }),
    new AggregateError([null, new Error('ordinary')]),
    Object.freeze(new Error('frozen ordinary')),
  ]) assert.equal(hasUnsettledWorker(error), false);
  assert.equal(hasUnsettledWorker(Object.freeze(unsafe())), true);
});

test('cycles terminate and do not hide reachable uncertain workers', () => {
  const first = new Error('first');
  const second = new Error('second', { cause: first });
  first.cause = second;
  assert.equal(hasUnsettledWorker(first), false);
  second.errors = [first, unsafe()];
  assert.equal(hasUnsettledWorker(first), true);
});

test('oversized or malformed graphs block rather than discard uninspected errors', () => {
  let deep = new Error('leaf');
  for (let index = 0; index < 300; index++) deep = new Error('wrapper', { cause: deep });
  assert.equal(hasUnsettledWorker(deep), true);
  assert.equal(hasUnsettledWorker(new AggregateError(Array(300).fill(null))), true);
  assert.equal(hasUnsettledWorker({ errors: 'uninspectable collection' }), true);
  assert.equal(hasUnsettledWorker({ errors: new Array(1) }), true);
});

test('accessor error fields and array entries are never executed', () => {
  let invoked = 0;
  const get = () => { invoked++; throw new Error('must not execute getter'); };
  for (const key of ['recoveryAllowed', 'cause', 'errors']) {
    const error = Object.defineProperty(new Error('accessor'), key, { get });
    assert.equal(hasUnsettledWorker(error), true);
  }
  const errors = [null];
  Object.defineProperty(errors, '0', { get });
  assert.equal(hasUnsettledWorker({ errors }), true);
  assert.equal(invoked, 0);
});

test('proxy inspection failure is unsafe and custom array iterators are not invoked', () => {
  const error = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('unreadable'); } });
  assert.equal(hasUnsettledWorker(error), true);
  const errors = [unsafe()];
  errors[Symbol.iterator] = () => assert.fail('custom iterator must not run');
  assert.equal(hasUnsettledWorker({ errors }), true);
});

test('inherited worker markers and callable error objects retain the prior safety behavior', () => {
  class NativeFailure extends Error {}
  NativeFailure.prototype.recoveryAllowed = false;
  assert.equal(hasUnsettledWorker(new NativeFailure('native failure')), true);
  const callable = Object.assign(() => {}, { recoveryAllowed: false });
  assert.equal(hasUnsettledWorker(callable), true);
  const inheritedCause = Object.create({ cause: unsafe() });
  assert.equal(hasUnsettledWorker(inheritedCause), true);
  let invoked = false;
  const prototype = Object.defineProperty({}, 'recoveryAllowed', {
    get() { invoked = true; return false; },
  });
  assert.equal(hasUnsettledWorker(Object.create(prototype)), true);
  assert.equal(invoked, false);
});
