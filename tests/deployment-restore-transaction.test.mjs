import assert from 'node:assert/strict';
import test from 'node:test';
import { runRestore } from '../scripts/deployment/restore-transaction.mjs';

function fixture(failAt) {
  const calls = [];
  const phases = [];
  const snapshot = { id: 'retained', source: { commit: 'a'.repeat(40) } };
  const operations = { record: async (phase, context) => {
    phases.push(phase);
    if (phase === 'restored') assert.equal(context.snapshot, snapshot);
  } };
  for (const name of ['inspect', 'inspectBackup', 'capacity', 'stop', 'restoreFiles', 'configure', 'start', 'verify']) {
    operations[name] = async context => {
      calls.push(name);
      assert.equal(context.signal.aborted, false);
      if (name === failAt) throw new Error(`fixture failure: ${name}`);
      if (name === 'inspect') return { exists: true, running: true, owned: true };
      if (name === 'inspectBackup') return { snapshot, check: async ({ signal }) => {
        assert.equal(signal.aborted, false);
        calls.push('recheck');
        if (failAt === 'recheck') throw new Error('backup changed');
      } };
    };
  }
  return { calls, phases, operations, snapshot };
}

const options = { operation: 'restore', acceptDataLoss: true };

test('restore requires explicit data-loss acknowledgement before any callback', async () => {
  for (const acceptDataLoss of [undefined, false, 'true', 1]) {
    const f = fixture();
    await assert.rejects(runRestore({ ...options, acceptDataLoss }, f.operations), /data.loss|acknowledg/i);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.phases, []);
  }
});

test('restore validates retained backup before downtime and never builds, installs or rotates', async () => {
  const f = fixture();
  for (const name of ['build', 'dependencies', 'snapshot', 'rotate', 'selectSource']) {
    f.operations[name] = () => assert.fail(`restore must not call ${name}`);
  }
  assert.deepEqual(await runRestore(options, f.operations), { status: 'restored', backupId: 'retained' });
  assert.deepEqual(f.calls, ['inspect', 'inspectBackup', 'capacity', 'recheck', 'stop',
    'restoreFiles', 'configure', 'start', 'verify']);
  assert.deepEqual(f.phases, ['restore-preflight', 'restoring', 'restore-activating', 'restored']);
});

for (const stage of ['inspect', 'inspectBackup', 'capacity', 'recheck']) {
  test(`restore ${stage} refusal leaves the current runtime untouched`, async () => {
    const f = fixture(stage);
    await assert.rejects(runRestore(options, f.operations), /fixture failure|backup changed/);
    assert.equal(f.calls.includes('stop'), false);
    assert.deepEqual(f.phases, []);
  });
}

test('missing or malformed retained backup check never admits restoration', async () => {
  for (const value of [null, {}, { snapshot: { id: 'saved' }, check: false }]) {
    const f = fixture();
    f.operations.inspectBackup = async () => value;
    await assert.rejects(runRestore(options, f.operations), /backup|check/i);
    assert.equal(f.calls.includes('stop'), false);
  }
});

test('unowned runtime and no-wait restoration are rejected before downtime', async () => {
  const f = fixture();
  f.operations.inspect = async () => ({ exists: true, running: true, owned: false });
  await assert.rejects(runRestore(options, f.operations), /ownership|owned/i);
  assert.equal(f.calls.includes('stop'), false);
  for (const overrides of [{ waitSeconds: 0 }, { timeoutSeconds: 0 }, { dryRun: true }, { operation: 'update' }]) {
    const invalid = fixture();
    await assert.rejects(runRestore({ ...options, ...overrides }, invalid.operations));
    assert.deepEqual(invalid.calls, []);
  }
});

for (const stage of ['stop', 'restoreFiles', 'configure', 'start', 'verify']) {
  test(`restore ${stage} failure retains recovery state and never claims success`, async () => {
    const f = fixture(stage);
    await assert.rejects(runRestore(options, f.operations), /fixture failure|cleanup/i);
    assert.equal(f.calls.at(-1), 'stop');
    assert.equal(f.phases.at(-1), 'recovery-required');
    assert.equal(f.phases.includes('restored'), false);
    if (stage === 'restoreFiles' || stage === 'configure') assert.equal(f.calls.includes('start'), false);
  });
}

test('unsettled restore writer forbids further stop, activation or file operations', async () => {
  const f = fixture();
  f.operations.restoreFiles = async () => {
    f.calls.push('restoreFiles');
    throw new Error('wrapper', { cause: Object.assign(new Error('writer'), { recoveryAllowed: false }) });
  };
  await assert.rejects(runRestore(options, f.operations), /wrapper/);
  assert.equal(f.calls.at(-1), 'restoreFiles');
  assert.equal(f.phases.at(-1), 'blocked');
  assert.equal(f.calls.filter(name => name === 'stop').length, 1);
});

test('restore stage cancellation settles before cleanup with a fresh signal', async () => {
  const f = fixture();
  const controller = new AbortController();
  let settled = false;
  f.operations.restoreFiles = async ({ signal }) => {
    controller.abort();
    assert.equal(signal.aborted, true);
    settled = true;
    signal.throwIfAborted();
  };
  f.operations.stop = async ({ signal, recovering }) => {
    assert.equal(signal.aborted, false);
    if (recovering) assert.equal(settled, true);
  };
  await assert.rejects(runRestore({ ...options, signal: controller.signal }, f.operations),
    { code: 'DEPLOYMENT_STAGE_CANCELLED' });
  assert.equal(f.phases.at(-1), 'recovery-required');
});

test('cleanup and state-write errors retain the original restoration failure', async () => {
  const f = fixture('restoreFiles');
  let stops = 0;
  f.operations.stop = async () => {
    if (++stops === 2) throw Object.assign(new Error('cleanup failed'), { recoveryAllowed: false });
  };
  f.operations.record = async phase => {
    if (phase === 'blocked') throw new Error('state failed');
  };
  await assert.rejects(runRestore(options, f.operations), error =>
    error instanceof AggregateError && error.errors.length === 3
      && /restoreFiles/.test(error.errors[0].message) && error.recoveryAllowed === false);
});
