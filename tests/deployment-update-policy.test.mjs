import assert from 'node:assert/strict';
import test from 'node:test';
import { alreadyCurrent, previewUpdate } from '../scripts/deployment/update-policy.mjs';

function facts() {
  const identity = {
    source: 'a'.repeat(40), build: 'build-hash', dependencies: 'deps-hash',
    config: 'config-hash', service: 'service-hash',
  };
  return {
    operation: 'update', target: identity.source, phase: 'accepted',
    receipt: { status: 'accepted', identity: { ...identity } },
    observed: { verified: true, running: true, identity: { ...identity } },
  };
}

test('no-op requires every accepted and observed identity', () => {
  assert.equal(alreadyCurrent(facts()).skip, true);
  for (const key of Object.keys(facts().observed.identity)) {
    for (const value of [undefined, '', `different-${key}`]) {
      const input = facts();
      input.observed.identity[key] = value;
      assert.equal(alreadyCurrent(input).skip, false, `${key}: ${value}`);
    }
    const input = facts();
    delete input.receipt.identity[key];
    delete input.observed.identity[key];
    assert.equal(alreadyCurrent(input).skip, false, `both missing: ${key}`);
  }
});

test('same source alone never skips deploy or unaccepted/stopped updates', () => {
  for (const change of [
    { operation: 'deploy' }, { target: 'b'.repeat(40) },
    { phase: 'activation-unverified' }, { phase: 'recovery-required' },
    { phase: 'prior-runtime-restored' },
    { phase: 'building' }, { receipt: null }, { observed: null },
    { receipt: { ...facts().receipt, status: 'activation-unverified' } },
    { observed: { ...facts().observed, verified: false } },
    { observed: { ...facts().observed, running: false } },
  ]) {
    const result = alreadyCurrent({ ...facts(), ...change });
    assert.equal(result.skip, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }
});

test('preview calls read-only readers and explicitly reports pending remote checks', async () => {
  const calls = [];
  const readers = {
    inspect: async () => { calls.push('inspect'); return { exists: true }; },
    localTarget: async () => { calls.push('localTarget'); return null; },
    estimate: async () => { calls.push('estimate'); return { bytes: 123 }; },
    checks: async () => { calls.push('checks'); return [{ name: 'data', status: 'pending' }]; },
  };
  const result = await previewUpdate({ operation: 'update', dryRun: true }, readers);
  assert.equal(result.status, 'preview');
  assert.equal(result.target, null);
  assert.equal(result.remoteRefreshed, false);
  assert.ok(result.pendingChecks.includes('target'));
  assert.ok(result.pendingChecks.includes('data'));
  assert.deepEqual(calls, ['inspect', 'localTarget', 'estimate', 'checks']);
});

test('preview never turns reader errors or failed checks into a successful plan', async () => {
  const readers = {
    inspect: async () => ({ exists: true }),
    localTarget: async () => ({ commit: 'a'.repeat(40) }),
    estimate: async () => ({ bytes: 1 }),
    checks: async () => [{ name: 'config', status: 'failed' }],
  };
  await assert.rejects(previewUpdate({ operation: 'update', dryRun: true }, readers), /config/);
  readers.checks = async () => { throw new Error('unreadable database'); };
  await assert.rejects(previewUpdate({ operation: 'update', dryRun: true }, readers), /unreadable database/);
  readers.checks = async () => [{ name: 'data', status: 'unknown' }];
  await assert.rejects(previewUpdate({ operation: 'update', dryRun: true }, readers), /check/i);
  await assert.rejects(previewUpdate({ operation: 'update' }, readers), /preview|dry.run/i);
});
