import assert from 'node:assert/strict';
import test from 'node:test';
import { runDeployment } from '../scripts/deployment/transaction.mjs';

function fixture(failAt) {
  const calls = [];
  const phases = [];
  const operations = { record: async phase => { phases.push(phase); } };
  for (const name of [
    'inspect', 'resolveTarget', 'admit', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
    'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify',
  ]) {
    operations[name] = async () => {
      calls.push(name);
      if (name === failAt) throw new Error(`fixture failure: ${name}`);
      if (name === 'inspect') return { exists: true, running: true, owned: true };
      if (name === 'resolveTarget') return { commit: 'a'.repeat(40) };
      if (name === 'admit') return { compatibility: 'passed', current: null };
    };
  }
  return { calls, phases, operations };
}

test('existing deployment backs up before any source or build mutation', async () => {
  const { calls, operations } = fixture();
  await runDeployment({ operation: 'update' }, operations);
  assert.deepEqual(calls, [
    'inspect', 'resolveTarget', 'admit', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
    'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify',
  ]);
});

test('capacity refusal leaves running application and source untouched', async () => {
  const { calls, operations } = fixture('capacity');
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /capacity/);
  assert.deepEqual(calls, ['inspect', 'resolveTarget', 'admit', 'capacity']);
});

test('retained compatibility is rechecked after capacity and before any downtime or source mutation', async () => {
  for (const existing of [false, true]) {
    const f = fixture();
    f.operations.inspect = async () => ({ exists: existing, running: existing, owned: true });
    const admission = { compatibility: 'passed', check: async ({ signal }) => {
      assert.equal(signal.aborted, false);
      assert.equal(f.calls.at(-1), 'capacity');
      assert.deepEqual(f.phases, []);
      throw new Error('configuration changed after admission');
    } };
    f.operations.admit = async () => admission;
    await assert.rejects(runDeployment({ operation: existing ? 'update' : 'deploy' }, f.operations), /configuration changed/);
    assert.equal(f.calls.includes('stop'), false);
    assert.equal(f.calls.includes('selectSource'), false);
    assert.deepEqual(f.phases, []);
  }
});

test('compatibility recheck uses its own cancellable stage and must settle before returning timeout', async () => {
  const f = fixture();
  let admittedSignal;
  let settled = false;
  f.operations.admit = async ({ signal }) => {
    admittedSignal = signal;
    return { compatibility: 'passed', check: async ({ signal: recheckSignal }) => {
      assert.notEqual(recheckSignal, admittedSignal);
      await new Promise(resolve => recheckSignal.addEventListener('abort', resolve, { once: true }));
      settled = true;
      recheckSignal.throwIfAborted();
    } };
  };
  await assert.rejects(runDeployment({ operation: 'update', timeoutSeconds: 1 }, f.operations),
    { code: 'DEPLOYMENT_STAGE_TIMEOUT', stage: 'compatibility-recheck', recoveryAllowed: true });
  assert.equal(settled, true);
  assert.equal(f.calls.includes('stop'), false);
});

test('a malformed retained-check field is not ignored as an absent checker', async () => {
  for (const check of [null, false, 'not-callable']) {
    const f = fixture();
    f.operations.admit = async () => ({ compatibility: 'passed', check });
    await assert.rejects(runDeployment({ operation: 'update' }, f.operations), /callable/);
    assert.equal(f.calls.includes('capacity'), false);
    assert.deepEqual(f.phases, []);
  }
});

test('backup failure restarts the unchanged previously running application', async () => {
  const { calls, phases, operations } = fixture('snapshot');
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /snapshot/);
  assert.equal(calls.includes('selectSource'), false);
  assert.deepEqual(calls.slice(-2), ['start', 'verify']);
  assert.equal(phases.at(-1), 'prior-runtime-restored');
});

test('native recovery callbacks receive the original failure code before publishing completion', async () => {
  for (const code of ['DEPLOYMENT_SNAPSHOT_FAILED', undefined]) {
    const f = fixture();
    const failure = Object.assign(new Error('backup failed before source mutation'), code ? { code } : {});
    const observed = [];
    f.operations.snapshot = async () => { throw failure; };
    for (const stage of ['start', 'verify']) {
      f.operations[stage] = async context => {
        observed.push({ stage, errorCode: context.errorCode, purpose: context.activationPurpose, recovering: context.recovering });
      };
    }
    await assert.rejects(runDeployment({ operation: 'update' }, f.operations), error => error === failure);
    assert.deepEqual(observed, ['start', 'verify'].map(stage => ({
      stage, errorCode: code ?? 'DEPLOYMENT_FAILED', purpose: 'prior-runtime', recovering: true,
    })));
    assert.equal(f.phases.at(-1), 'prior-runtime-restored');
    assert.equal(f.phases.includes('accepted'), false);
  }
});

test('verified prior-runtime restart remains a failed update even with no-wait or cancelled caller', async () => {
  const f = fixture('snapshot');
  const controller = new AbortController();
  const failure = new Error('backup failed');
  f.operations.snapshot = async () => { controller.abort(); throw failure; };
  for (const stage of ['start', 'verify']) {
    f.operations[stage] = async context => {
      f.calls.push(stage);
      assert.equal(context.activationPurpose, 'prior-runtime');
      assert.equal(context.recovering, true);
      assert.equal(context.signal.aborted, false);
    };
  }
  await assert.rejects(runDeployment({ operation: 'update', waitSeconds: 0, signal: controller.signal }, f.operations),
    error => error.code === 'DEPLOYMENT_STAGE_CANCELLED' && error.cause === failure);
  assert.equal(f.phases.at(-1), 'prior-runtime-restored');
  assert.equal(f.phases.includes('accepted'), false);
});

test('failed verification or recovered-state write retains original and recovery errors without success', async () => {
  for (const stage of ['verify', 'record']) {
    const f = fixture('snapshot');
    if (stage === 'verify') f.operations.verify = async () => { throw new Error('old runtime health failed'); };
    else {
      const record = f.operations.record;
      f.operations.record = async phase => {
        if (phase === 'prior-runtime-restored') throw new Error('recovery state flush failed');
        await record(phase);
      };
    }
    await assert.rejects(runDeployment({ operation: 'update' }, f.operations), error =>
      error instanceof AggregateError && /snapshot/.test(error.errors[0].message) && error.errors.length === 2);
    assert.equal(f.phases.includes('prior-runtime-restored'), false);
    assert.equal(f.phases.includes('accepted'), false);
    if (stage === 'verify') assert.equal(f.phases.at(-1), 'recovery-required');
  }
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

test('dry-run dispatch never calls transaction mutators or normal target resolver', async () => {
  const { calls, phases, operations } = fixture();
  operations.previewReaders = {
    inspect: async () => ({ exists: true }),
    localTarget: async () => null,
    estimate: async () => ({ bytes: 10 }),
    checks: async () => [],
  };
  const result = await runDeployment({ operation: 'update', dryRun: true }, operations);
  assert.equal(result.status, 'preview');
  assert.deepEqual(calls, []);
  assert.deepEqual(phases, []);
  delete operations.previewReaders;
  await assert.rejects(runDeployment({ operation: 'update', dryRun: true }, operations), /reader/i);
  assert.deepEqual(calls, []);
});

test('admission refusal stops before capacity, downtime, state or source changes', async () => {
  for (const admission of [undefined, {}, { compatibility: 'pending' }, { compatibility: 'failed' }]) {
    const { calls, phases, operations } = fixture();
    operations.admit = async () => { calls.push('admit'); return admission; };
    await assert.rejects(runDeployment({ operation: 'update' }, operations), /compatibility|admission/i);
    assert.deepEqual(calls, ['inspect', 'resolveTarget', 'admit']);
    assert.deepEqual(phases, []);
  }
});

test('blocked cleanup remains blocked when state recording also fails', async () => {
  const { operations } = fixture('build');
  let stops = 0;
  operations.stop = async () => {
    if (++stops === 2) throw Object.assign(new Error('owned writer remains'), { recoveryAllowed: false });
  };
  operations.record = async phase => {
    if (phase === 'blocked') throw new Error('journal unavailable');
  };
  await assert.rejects(runDeployment({ operation: 'update' }, operations), error => {
    assert.equal(error.recoveryAllowed, false);
    assert.equal(error.errors.length, 3);
    assert.match(error.errors[2].message, /journal unavailable/);
    return true;
  });
});

test('accepted identity skips update without replacing journal or rotating backup; deploy rebuilds', async () => {
  const { calls, phases, operations } = fixture();
  const identity = {
    source: 'a'.repeat(40), build: 'built', dependencies: 'installed',
    config: 'configuration', service: 'service',
  };
  operations.admit = async () => {
    calls.push('admit');
    return {
      compatibility: 'passed',
      current: {
        phase: 'accepted',
        receipt: { status: 'accepted', identity },
        observed: { running: true, verified: true, identity },
      },
    };
  };
  const result = await runDeployment({ operation: 'update' }, operations);
  assert.deepEqual(result, { status: 'already-current', backupCreated: false });
  assert.deepEqual(calls, ['inspect', 'resolveTarget', 'admit']);
  assert.deepEqual(phases, []);
  calls.length = 0;
  assert.equal((await runDeployment({ operation: 'deploy' }, operations)).status, 'accepted');
  assert.ok(calls.includes('build'));
});

test('transaction passes a stage cancellation signal and rejects invalid deadlines before inspection', async () => {
  const { calls, operations } = fixture();
  operations.build = async context => {
    assert.ok(context.signal instanceof AbortSignal);
    assert.equal(context.signal.aborted, false);
  };
  await runDeployment({ operation: 'update', timeoutSeconds: 2 }, operations);
  calls.length = 0;
  await assert.rejects(runDeployment({ operation: 'update', timeoutSeconds: 0 }, operations), /timeout/i);
  assert.deepEqual(calls, []);
});

test('unsafe worker failure forbids restarting runtime or beginning cleanup', async () => {
  for (const stage of ['snapshot', 'build']) {
    const { calls, phases, operations } = fixture();
    const failure = Object.assign(new Error('worker may still write'), {
      code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false,
    });
    operations[stage] = async () => { calls.push(stage); throw failure; };
    await assert.rejects(runDeployment({ operation: 'update' }, operations), error => error === failure);
    assert.equal(calls.at(-1), stage);
    assert.equal(phases.at(-1), 'blocked');
    assert.equal(calls.includes('start'), false);
  }
});

test('unsettled preflight worker is durable blocked without authorizing runtime changes', async () => {
  for (const stage of ['inspect', 'resolveTarget', 'admit', 'capacity']) {
    const { calls, phases, operations } = fixture();
    const failure = Object.assign(new Error('preflight child remains alive'), {
      code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false,
    });
    operations[stage] = async () => { calls.push(stage); throw failure; };
    operations.record = async (phase, context) => {
      phases.push(phase);
      assert.equal(context.errorCode, 'DEPLOYMENT_WORKER_UNSETTLED');
    };
    await assert.rejects(runDeployment({ operation: 'update' }, operations), error => error === failure);
    assert.deepEqual(phases, ['blocked']);
    assert.equal(calls.at(-1), stage);
    assert.equal(calls.includes('start'), false);
    assert.equal(calls.includes('stop'), false);
  }
});

test('readiness uses the shorter wait budget and stops partial runtime only after settlement', async () => {
  const { calls, operations } = fixture();
  let settled = false;
  let stops = 0;
  operations.verify = context => new Promise(resolve => {
    context.signal.addEventListener('abort', () => { settled = true; resolve(); }, { once: true });
  });
  operations.stop = async () => {
    calls.push('stop');
    if (++stops === 2) assert.equal(settled, true);
  };
  await assert.rejects(runDeployment({
    operation: 'update', timeoutSeconds: 30, waitSeconds: 1,
  }, operations), error => {
    assert.equal(error.code, 'DEPLOYMENT_STAGE_TIMEOUT');
    assert.equal(error.stage, 'verify');
    assert.ok(error.elapsedMs >= 1000);
    assert.ok(error.elapsedMs < 10000);
    return true;
  });
  assert.equal(stops, 2);
});

test('cancelling a stopped pre-source operation can restart untouched app using a fresh signal', async () => {
  const { calls, operations } = fixture();
  const controller = new AbortController();
  operations.snapshot = context => new Promise(resolve => {
    calls.push('snapshot');
    context.signal.addEventListener('abort', resolve, { once: true });
    controller.abort();
  });
  operations.start = async context => {
    assert.equal(context.signal.aborted, false);
    calls.push('start');
  };
  await assert.rejects(runDeployment({
    operation: 'update', signal: controller.signal,
  }, operations), { code: 'DEPLOYMENT_STAGE_CANCELLED' });
  assert.deepEqual(calls.slice(-2), ['start', 'verify']);
  assert.equal(calls.includes('selectSource'), false);
});

test('wrapped worker uncertainty blocks preflight and mutations without runtime cleanup', async () => {
  const unsafe = Object.assign(new Error('unsettled worker'), { recoveryAllowed: false });
  for (const stage of ['inspect', 'snapshot', 'build']) {
    for (const failure of [
      new Error('adapter context', { cause: unsafe }),
      new AggregateError([new Error('ordinary'), unsafe]),
    ]) {
      const { calls, phases, operations } = fixture();
      operations[stage] = async () => { calls.push(stage); throw failure; };
      await assert.rejects(runDeployment({ operation: 'update' }, operations), error => error === failure);
      assert.equal(calls.at(-1), stage);
      assert.equal(phases.at(-1), 'blocked');
      assert.equal(calls.includes('start'), false);
    }
  }
});

test('nested cleanup uncertainty survives a second journal failure', async () => {
  const { phases, operations } = fixture('build');
  const unsafe = Object.assign(new Error('writer still alive'), { recoveryAllowed: false });
  const cleanup = new Error('stop failed', { cause: unsafe });
  let stops = 0;
  operations.stop = async () => { if (++stops === 2) throw cleanup; };
  operations.record = async phase => {
    phases.push(phase);
    if (phase === 'blocked') throw new Error('journal failed');
  };
  await assert.rejects(runDeployment({ operation: 'update' }, operations), error => {
    assert.equal(error.recoveryAllowed, false);
    assert.equal(error.errors[1], cleanup);
    assert.match(error.errors[2].message, /journal failed/);
    return true;
  });
  assert.equal(phases.at(-1), 'blocked');
});
