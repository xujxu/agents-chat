import assert from 'node:assert/strict';
import test from 'node:test';
import { runDeployment } from '../scripts/deployment/transaction.mjs';

function fixture(failAt) {
  const calls = [];
  const operations = {};
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
  return { calls, operations };
}

test('existing deployment backs up before any source or build mutation', async () => {
  const { calls, operations } = fixture();
  await runDeployment({ operation: 'upgrade' }, operations);
  assert.deepEqual(calls, [
    'inspect', 'resolveTarget', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
    'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify',
  ]);
});

test('capacity refusal leaves running application and source untouched', async () => {
  const { calls, operations } = fixture('capacity');
  await assert.rejects(runDeployment({ operation: 'upgrade' }, operations), /capacity/);
  assert.deepEqual(calls, ['inspect', 'resolveTarget', 'capacity']);
});

test('backup failure restarts the unchanged previously running application', async () => {
  const { calls, operations } = fixture('snapshot');
  await assert.rejects(runDeployment({ operation: 'upgrade' }, operations), /snapshot/);
  assert.equal(calls.includes('selectSource'), false);
  assert.equal(calls.at(-1), 'start');
});
