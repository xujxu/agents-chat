import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createColdActivationState, captureColdActivationIntent,
} from '../scripts/deployment/linux-cold-activation-state.mjs';

const record = priorRuntime => ({
  project: '/application', lock: { operationId: 'original-operation' },
  owner: { createdAt: '2026-10-01T00:00:00.000Z' }, backupId: 'retained-backup',
  state: { sourceCommit: 'a'.repeat(40), priorRuntime,
    runtimeIdentity: priorRuntime === 'stopped' ? `stopped:${'d'.repeat(64)}` : 'legacy-unit.service' },
  targetCommit: 'b'.repeat(40),
  runtimeIdentity: priorRuntime === 'stopped' ? `stopped:${'d'.repeat(64)}` : 'c'.repeat(32),
});

for (const priorRuntime of ['running', 'stopped']) {
  test(`cold ${priorRuntime} activation preserves its exact versioned state`, () => {
    const source = record(priorRuntime);
    const expected = {
      version: priorRuntime === 'running' ? 1 : 2,
      state: {
        version: 1, operationId: 'original-operation', project: '/application', operation: 'restore',
        phase: 'restore-activating', previousPhase: 'restoring', sourceCommit: 'a'.repeat(40),
        targetCommit: 'b'.repeat(40), backupId: 'retained-backup', priorRuntime,
        runtimeIdentity: source.runtimeIdentity,
        startedAt: source.owner.createdAt, updatedAt: source.owner.createdAt, errorCode: null,
      },
    };
    assert.deepEqual(createColdActivationState(source), expected);
    const intent = { version: expected.version, owner: source.owner, lock: source.lock, state: expected.state };
    assert.deepEqual(captureColdActivationIntent(intent, source), intent);
    for (const changed of [
      { ...intent, version: priorRuntime === 'running' ? 2 : 1 },
      { ...intent, state: { ...intent.state, priorRuntime: priorRuntime === 'running' ? 'stopped' : 'running' } },
      { ...intent, state: { ...intent.state, sourceCommit: 'e'.repeat(40) } },
      { ...intent, state: { ...intent.state, targetCommit: 'not-a-commit' } },
      { ...intent, state: { ...intent.state, runtimeIdentity: '' } },
      { ...intent, state: { ...intent.state, unknown: true } },
      { ...intent, unknown: true },
      { ...intent, owner: { ...source.owner, createdAt: '2026-10-02T00:00:00.000Z' } },
    ]) {
      assert.throws(() => captureColdActivationIntent(changed, source), /activation|intent/i);
    }
  });
}

test('cold activation refuses unsupported original roles and unbound stopped markers', () => {
  for (const priorRuntime of ['absent', 'unknown', undefined]) {
    assert.throws(() => createColdActivationState(record(priorRuntime)), /activation|identity/i);
  }
  const stopped = record('stopped');
  for (const runtimeIdentity of ['c'.repeat(32), `stopped:${'e'.repeat(64)}`, null, '']) {
    assert.throws(() => createColdActivationState({ ...stopped, runtimeIdentity }), /activation|identity/i);
  }
  const legacy = record('running');
  assert.notEqual(legacy.state.runtimeIdentity, legacy.runtimeIdentity);
  assert.equal(createColdActivationState(legacy).state.runtimeIdentity, legacy.runtimeIdentity);
});
