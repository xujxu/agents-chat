import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { runOwnedWorker } from '../scripts/deployment/owned-worker.mjs';
import { runStage } from '../scripts/deployment/stage-runner.mjs';

const workerId = '649276eb-c039-420b-9d28-bd76646f29fc';
const owner = {
  project: path.resolve('deployment-fixture'), operationId: 'operation-1',
  workerId, controllerIdentity: 'controller-start-identity',
};
const linux = {
  kind: 'systemd', bootId: '98f127de-7a8e-4f9e-8c46-3ce9d2215991',
  manager: 'system', unit: `agents-deploy-${workerId}.service`,
  invocationId: 'd4578a02f9344b869643f15bc37f8a87',
  controlGroup: `/system.slice/agents-deploy-${workerId}.service`,
};
const windows = {
  kind: 'windows-job', name: `Local\\agents-deploy-${workerId}`,
  generation: workerId, accountSid: 'S-1-5-21-123-456-789-1001', sessionId: 0,
  ownerIdentity: owner.controllerIdentity,
};

function fixture(identity = linux) {
  const calls = [];
  const receipts = [];
  const controller = new AbortController();
  let nativeSignal;
  const domain = {
    identity: { ...identity },
    async run({ signal }) {
      calls.push('run');
      assert.equal(signal, nativeSignal);
      signal.throwIfAborted();
      return 23;
    },
    async closeAdmission() { calls.push('closeAdmission'); assert.equal(nativeSignal.aborted, true); },
    async stop() { calls.push('stop'); },
    async join() { calls.push('join'); },
    async observe() { calls.push('observe'); return { identity: { ...identity }, empty: true }; },
    async retire() { assert.equal(calls.at(-1), 'settled'); },
  };
  const adapters = {
    async record(receipt) { calls.push(receipt.phase); receipts.push(receipt); },
    async prepare({ owner: saved, signal }) {
      calls.push('prepare');
      assert.deepEqual(saved, owner);
      nativeSignal = signal;
      return domain;
    },
  };
  const run = () => runOwnedWorker({ owner, signal: controller.signal }, adapters);
  return { calls, receipts, controller, domain, adapters, run };
}

function unsettled(error) {
  assert.equal(error.code, 'DEPLOYMENT_WORKER_UNSETTLED');
  assert.equal(error.recoveryAllowed, false);
  return true;
}

test('both native domains require admission and full settlement before success', async () => {
  for (const identity of [linux, windows]) {
    const { run, calls, receipts } = fixture(identity);
    assert.equal(await run(), 23);
    assert.deepEqual(calls, [
      'intent', 'prepare', 'owned', 'admitted', 'run',
      'closeAdmission', 'stop', 'join', 'observe', 'settled',
    ]);
    assert.deepEqual(receipts.map(receipt => receipt.domain), [null, identity, identity, identity]);
    for (const receipt of receipts) {
      assert.equal(receipt.version, 1);
      assert.deepEqual(receipt.owner, owner);
      assert.equal(Object.isFrozen(receipt), true);
      assert.equal(Object.isFrozen(receipt.owner), true);
      if (receipt.domain) assert.equal(Object.isFrozen(receipt.domain), true);
    }
  }
});

test('abort before intent performs no native or journal operations', async () => {
  const { run, calls, controller } = fixture();
  const reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(run(), error => error === reason);
  assert.deepEqual(calls, []);
});

test('cancellation at each admission boundary never grants target execution', async () => {
  for (const boundary of ['intent', 'prepare', 'owned', 'admitted']) {
    const { run, calls, adapters, controller } = fixture();
    const reason = new Error(`cancel at ${boundary}`);
    const record = adapters.record;
    adapters.record = async receipt => {
      await record(receipt);
      if (receipt.phase === boundary) controller.abort(reason);
    };
    const prepare = adapters.prepare;
    adapters.prepare = async context => {
      const domain = await prepare(context);
      if (boundary === 'prepare') controller.abort(reason);
      return domain;
    };
    await assert.rejects(run(), error => error === reason);
    assert.equal(calls.includes('run'), false);
    assert.equal(calls.at(-1), 'settled');
    if (boundary === 'intent') assert.equal(calls.includes('prepare'), false);
    else assert.deepEqual(calls.slice(-5), ['closeAdmission', 'stop', 'join', 'observe', 'settled']);
  }
});

test('ordinary command failure preserves its exact error after descendant settlement', async () => {
  const { run, calls, domain } = fixture();
  const original = new Error('command failed');
  domain.run = async () => { calls.push('run'); throw original; };
  await assert.rejects(run(), error => error === original);
  assert.deepEqual(calls.slice(-5), ['closeAdmission', 'stop', 'join', 'observe', 'settled']);
});

test('a result cannot succeed after cancellation during execution or settlement', async () => {
  for (const boundary of ['run', 'observe', 'settled']) {
    const { run, calls, domain, adapters, controller } = fixture();
    const reason = new Error('late cancellation');
    if (boundary === 'settled') {
      const record = adapters.record;
      adapters.record = async receipt => {
        await record(receipt);
        if (receipt.phase === boundary) controller.abort(reason);
      };
    } else {
      const operation = domain[boundary];
      domain[boundary] = async context => {
        const result = await operation(context);
        controller.abort(reason);
        return result;
      };
    }
    await assert.rejects(run(), error => error === reason);
    assert.equal(calls.at(-1), 'settled');
  }
});

test('every cleanup failure blocks, attempts remaining cleanup, and forbids empty observation', async () => {
  for (const boundary of ['closeAdmission', 'stop', 'join']) {
    const { run, calls, domain } = fixture();
    const failure = new Error(`${boundary} failed`);
    domain[boundary] = async () => { calls.push(boundary); throw failure; };
    await assert.rejects(run(), error => {
      unsettled(error);
      assert.equal(error.cause, failure);
      return true;
    });
    assert.deepEqual(calls.slice(-4), ['closeAdmission', 'stop', 'join', 'blocked']);
    assert.equal(calls.includes('observe'), false);
    assert.equal(calls.includes('settled'), false);
  }
});

test('only an exact-domain empty observation can certify settlement', async () => {
  for (const observation of [
    null, { identity: linux, empty: false }, { identity: linux, empty: 1 },
    { identity: { ...linux, invocationId: '0'.repeat(32) }, empty: true },
    { identity: { ...linux, bootId: workerId }, empty: true },
    { identity: { ...linux, controlGroup: '/foreign.slice' }, empty: true },
    { identity: { ...linux, unexpected: 'extra' }, empty: true },
  ]) {
    const { run, calls, domain } = fixture();
    domain.observe = async () => { calls.push('observe'); return observation; };
    await assert.rejects(run(), unsettled);
    assert.equal(calls.at(-1), 'blocked');
    assert.equal(calls.includes('settled'), false);
  }
});

test('Windows account, session, generation and owner replacement cannot certify settlement', async () => {
  for (const mutation of [
    { accountSid: 'S-1-5-18' }, { sessionId: 2 }, { generation: linux.bootId },
    { ownerIdentity: 'reused-owner' }, { name: `Local\\agents-deploy-${linux.bootId}` },
  ]) {
    const { run, domain } = fixture(windows);
    domain.observe = async () => ({ identity: { ...windows, ...mutation }, empty: true });
    await assert.rejects(run(), unsettled);
  }
});

test('identity is captured before asynchronous journal callbacks can mutate the adapter object', async () => {
  const { run, adapters, domain, receipts } = fixture();
  const record = adapters.record;
  adapters.record = async receipt => {
    await record(receipt);
    if (receipt.phase === 'owned') domain.identity.invocationId = '0'.repeat(32);
  };
  assert.equal(await run(), 23);
  assert.equal(receipts.at(-1).domain.invocationId, linux.invocationId);
});

test('property ordering does not change native identity', async () => {
  const { run, domain } = fixture();
  domain.observe = async () => ({
    identity: Object.fromEntries(Object.entries(linux).reverse()), empty: true,
  });
  assert.equal(await run(), 23);
});

test('intent journal failure cannot create a native domain', async () => {
  const { run, calls, adapters } = fixture();
  const failure = new Error('disk full');
  adapters.record = async () => { throw failure; };
  await assert.rejects(run(), error => error === failure);
  assert.deepEqual(calls, []);
});

test('owned, admitted and settlement receipt failures remain unsafe even with no surviving process', async () => {
  for (const boundary of ['owned', 'admitted', 'settled']) {
    const { run, calls, adapters } = fixture();
    const failure = new Error('journal failure');
    const record = adapters.record;
    adapters.record = async receipt => {
      await record(receipt);
      if (receipt.phase === boundary) throw failure;
    };
    await assert.rejects(run(), error => {
      unsettled(error);
      assert.equal(error.cause, failure);
      return true;
    });
    assert.equal(calls.at(-1), 'blocked');
    if (boundary !== 'settled') assert.equal(calls.includes('run'), false);
    assert.equal(calls.includes('observe'), true);
  }
});

test('ambiguous preparation and failed blocked recording preserve both errors', async () => {
  const { run, calls, adapters } = fixture();
  const creation = new Error('transport lost after creation');
  const journal = new Error('blocked write failed');
  adapters.prepare = async () => { calls.push('prepare'); throw creation; };
  const record = adapters.record;
  adapters.record = async receipt => {
    await record(receipt);
    if (receipt.phase === 'blocked') throw journal;
  };
  await assert.rejects(run(), error => {
    unsettled(error);
    assert.deepEqual(error.cause.errors, [creation, journal]);
    return true;
  });
  assert.deepEqual(calls, ['intent', 'prepare', 'blocked']);
});

test('wrapped unsafe run failure cannot be downgraded by later empty-domain observation', async () => {
  const { run, calls, domain } = fixture();
  const failure = new Error('adapter failed', {
    cause: Object.assign(new Error('lost child authority'), { recoveryAllowed: false }),
  });
  domain.run = async () => { throw failure; };
  await assert.rejects(run(), error => {
    unsettled(error);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(calls.at(-1), 'blocked');
  assert.equal(calls.includes('settled'), false);
});

test('malformed handles are blocked while any available cleanup callbacks still run', async () => {
  const { run, calls, domain } = fixture();
  delete domain.run;
  await assert.rejects(run(), unsettled);
  assert.deepEqual(calls.slice(-4), ['closeAdmission', 'stop', 'join', 'blocked']);
});

test('invalid or foreign identity never grants a command', async () => {
  for (const mutation of [
    { unit: 'foreign.service' }, { controlGroup: '/' }, { controlGroup: '/x/../system.slice' },
    { manager: 'user' }, { invocationId: '' }, { bootId: 'unknown' },
  ]) {
    const { run, calls, domain } = fixture();
    Object.assign(domain.identity, mutation);
    await assert.rejects(run(), unsettled);
    assert.equal(calls.includes('run'), false);
    assert.equal(calls.includes('owned'), false);
  }
});

test('invalid owner or callbacks fail before journal or native work', async () => {
  const { calls, adapters } = fixture();
  for (const invalid of [
    { ...owner, project: 'relative' }, { ...owner, workerId: 'reused-name' },
    { ...owner, controllerIdentity: '' }, { ...owner, unknown: true },
  ]) {
    await assert.rejects(runOwnedWorker({ owner: invalid }, adapters), /owner/i);
  }
  await assert.rejects(runOwnedWorker({ owner }, { ...adapters, prepare: null }), /adapter/i);
  assert.deepEqual(calls, []);
});

test('native evidence is retired only after the settlement receipt is durable', async () => {
  const { run, calls, domain } = fixture();
  domain.retire = async () => { calls.push('retire'); };
  assert.equal(await run(), 23);
  assert.deepEqual(calls.slice(-3), ['observe', 'settled', 'retire']);
});

test('native evidence is retained when cleanup or receipt recording is uncertain', async () => {
  for (const boundary of ['stop', 'settled']) {
    const { run, domain, adapters, calls } = fixture();
    domain.retire = async () => assert.fail('uncertain evidence must not be retired');
    if (boundary === 'stop') domain.stop = async () => { throw new Error('stop failed'); };
    else {
      const record = adapters.record;
      adapters.record = async receipt => {
        if (receipt.phase === 'settled') throw new Error('write failed');
        await record(receipt);
      };
    }
    await assert.rejects(run(), unsettled);
    assert.equal(calls.at(-1), 'blocked');
  }
});

test('retirement failure cannot leave a successful operation result', async () => {
  const { run, domain, calls } = fixture();
  const failure = new Error('native handle close failed');
  domain.retire = async () => { throw failure; };
  await assert.rejects(run(), error => {
    unsettled(error);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(calls.at(-1), 'blocked');
});

test('empty observation waits for every launch-capable controller to finish', async () => {
  const { run, domain, calls } = fixture();
  const entered = Promise.withResolvers();
  const joined = Promise.withResolvers();
  domain.join = async () => {
    calls.push('join');
    entered.resolve();
    await joined.promise;
  };
  const completion = run();
  await entered.promise;
  assert.equal(calls.includes('observe'), false);
  assert.equal(calls.includes('settled'), false);
  joined.resolve();
  assert.equal(await completion, 23);
  assert.equal(calls.includes('observe'), true);
});

test('late preparation after the stage settlement deadline cannot launch target code', async () => {
  const { adapters, controller, calls } = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const prepare = adapters.prepare;
  adapters.prepare = async context => {
    const domain = await prepare(context);
    entered.resolve();
    await release.promise;
    return domain;
  };
  let ownedOutcome;
  const stage = runStage('build', signal => {
    const worker = runOwnedWorker({ owner, signal }, adapters);
    ownedOutcome = worker.then(value => ({ value }), error => ({ error }));
    return worker;
  }, { timeoutMs: 10000, settlementMs: 30, signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('cancelled while preparing'));
  await assert.rejects(stage, unsettled);
  assert.equal(calls.includes('run'), false);
  release.resolve();
  const outcome = await ownedOutcome;
  assert.equal(outcome.error.code, 'DEPLOYMENT_STAGE_CANCELLED');
  assert.equal(calls.includes('run'), false);
  assert.deepEqual(calls.slice(-5), ['closeAdmission', 'stop', 'join', 'observe', 'settled']);
});
