import assert from 'node:assert/strict';
import test from 'node:test';
import { runDeployment } from '../scripts/deployment/transaction.mjs';

function fixture(failAt) {
  const calls = [];
  const phases = [];
  const operations = { record: async phase => { phases.push(phase); } };
  for (const name of [
    'inspect', 'resolveTarget', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
    'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify',
  ]) {
    operations[name] = async () => {
      calls.push(name);
      if (name === failAt) throw new Error(`fixture failure: ${name}`);
      if (name === 'inspect') return { exists: true, running: true, owned: true };
    };
  }
  return { calls, phases, operations };
}

test('existing deployment backs up before any source or build mutation', async () => {
  const { calls, operations } = fixture();
  await runDeployment({ operation: 'update' }, operations);
  assert.deepEqual(calls, [
    'inspect', 'resolveTarget', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
    'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify',
  ]);
});

test('capacity refusal leaves running application and source untouched', async () => {
  const { calls, operations } = fixture('capacity');
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /capacity/);
  assert.deepEqual(calls, ['inspect', 'resolveTarget', 'capacity']);
});

test('backup failure restarts the unchanged previously running application', async () => {
  const { calls, operations } = fixture('snapshot');
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /snapshot/);
  assert.equal(calls.includes('selectSource'), false);
  assert.equal(calls.at(-1), 'start');
});

test('backup failure never starts an application that was already stopped', async () => {
  const { calls, operations } = fixture('snapshot');
  operations.inspect = async () => {
    calls.push('inspect');
    return { exists: true, running: false, owned: true };
  };
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /snapshot/);
  assert.equal(calls.includes('start'), false);
});

test('a build failure cannot start partially replaced artifacts', async () => {
  const { calls, operations } = fixture('build');
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /build/);
  assert.equal(calls.includes('start'), false);
  assert.equal(calls.at(-1), 'stop');
});

test('activation failure stops the owned partial deployment', async () => {
  const { calls, operations } = fixture('verify');
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /verify/);
  assert.equal(calls.at(-1), 'stop');
  assert.equal(calls.filter(name => name === 'snapshot').length, 1);
});

test('first deployment skips backup, update requires an existing installation', async () => {
  const first = fixture();
  first.operations.inspect = async () => {
    first.calls.push('inspect');
    return { exists: false, running: false, owned: true };
  };
  const result = await runDeployment({ operation: 'deploy' }, first.operations);
  assert.equal(result.status, 'accepted');
  assert.equal(first.calls.includes('snapshot'), false);
  assert.equal(first.calls.includes('stop'), false);
  first.calls.length = 0;
  await assert.rejects(runDeployment({ operation: 'update' }, first.operations), /existing/i);
  assert.deepEqual(first.calls, ['inspect']);
});

test('no-wait activation is unverified, never accepted', async () => {
  const { calls, operations } = fixture();
  const result = await runDeployment({ operation: 'update', waitSeconds: 0 }, operations);
  assert.equal(result.status, 'activation-unverified');
  assert.equal(calls.includes('verify'), false);
  assert.equal(calls.at(-1), 'start');
});

test('foreign service and incomplete inspection results fail before mutation', async () => {
  for (const inspected of [undefined, {}, { exists: true, running: true, owned: false }]) {
    const { calls, operations } = fixture();
    operations.inspect = async () => { calls.push('inspect'); return inspected; };
    await assert.rejects(runDeployment({ operation: 'update' }, operations), /ownership|inspect/i);
    assert.deepEqual(calls, ['inspect']);
  }
});

test('cleanup failure retains both errors rather than masking the original failure', async () => {
  const { operations } = fixture('snapshot');
  operations.start = async () => { throw new Error('restart failed'); };
  await assert.rejects(runDeployment({ operation: 'update' }, operations), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /snapshot/);
    assert.match(error.errors[1].message, /restart/);
    return true;
  });
});

test('phase is durable before source, dependency and build mutations', async () => {
  const { phases, operations } = fixture();
  for (const [name, phase] of [
    ['selectSource', 'source-selected'], ['dependencies', 'dependencies'],
    ['build', 'building'], ['configure', 'configuring'], ['start', 'activating'],
  ]) {
    operations[name] = async () => { assert.equal(phases.at(-1), phase); };
  }
  await runDeployment({ operation: 'update' }, operations);
  assert.deepEqual(phases, [
    'preflight', 'stopped', 'copying', 'rotating', 'backup-ready',
    'source-selected', 'dependencies', 'building', 'configuring', 'activating', 'accepted',
  ]);
});

test('failed state write prevents the associated source mutation', async () => {
  const { calls, operations } = fixture();
  operations.record = async phase => {
    if (phase === 'source-selected') throw new Error('journal write failed');
  };
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /journal write/);
  assert.equal(calls.includes('selectSource'), false);
});

test('failed activation retains recovery-required state', async () => {
  const { phases, operations } = fixture('verify');
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /verify/);
  assert.equal(phases.at(-1), 'recovery-required');
});
