import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createColdActivationState, captureColdActivationIntent,
} from '../scripts/deployment/linux-cold-activation-state.mjs';
import { linuxOriginalServiceHistory } from '../scripts/deployment/linux-service-stop-evidence.mjs';
import { createWindowsColdActivationIntent } from '../scripts/deployment/windows-cold-activation-intent.mjs';

test('original running history requires a real positive process and invocation identity', () => {
  const runtime = { mainPid: 7, activeState: 'active', processIdentity: 'retained-process', invocationId: 'a'.repeat(32) };
  assert.deepEqual(linuxOriginalServiceHistory({ identity: { runtime } }), {
    priorRuntime: 'running', runtimeIdentity: runtime.invocationId,
  });
  for (const changed of [
    { mainPid: 0 }, { mainPid: -1 }, { mainPid: 1.5 }, { activeState: 'failed' },
    { processIdentity: null }, { invocationId: '' }, { invocationId: 'legacy-unit.service' },
  ]) {
    assert.throws(() => linuxOriginalServiceHistory({ identity: { runtime: { ...runtime, ...changed } } }),
      /running.*identity/i);
  }
});

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

test('Windows cold activation binds original owner and file-completion bytes without changing root state', () => {
  const source = {
    ...record('running'), project: 'C:\\application',
    snapshotSha256: 'c'.repeat(64), stateSha256: 'd'.repeat(64),
    state: { sourceCommit: 'a'.repeat(40), priorRuntime: 'running',
      runtimeIdentity: '12345678-1234-1234-1234-123456789abc' },
  };
  const original = structuredClone(source);
  const ownerBytes = Buffer.from(`${JSON.stringify(source)}\n`);
  const runtimeBundle = { directory: 'C:\\control\\runtime-new',
    configuration: 'C:\\control\\runtime-new\\configuration.json', sha256: 'e'.repeat(64) };
  const receipt = { record: { runtimeBundle }, bytes: Buffer.from(`${JSON.stringify({ runtimeBundle })}\n`) };
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const expected = {
    version: 1, phase: 'activation-intent', ownerSha256: digest(ownerBytes),
    filesReceiptSha256: digest(receipt.bytes), operationId: source.lock.operationId,
    backupId: source.backupId, snapshotSha256: source.snapshotSha256,
    stateSha256: source.stateSha256, runtimeBundle,
    state: {
      version: 1, operationId: source.lock.operationId, project: source.project, operation: 'restore',
      phase: 'restore-activating', previousPhase: 'restoring', sourceCommit: source.state.sourceCommit,
      targetCommit: source.targetCommit, backupId: source.backupId, priorRuntime: 'running',
      runtimeIdentity: source.state.runtimeIdentity,
      startedAt: source.owner.createdAt, updatedAt: source.owner.createdAt, errorCode: null,
    },
  };
  assert.deepEqual(createWindowsColdActivationIntent(source, ownerBytes, receipt, source.targetCommit), expected);
  assert.deepEqual(source, original);
  for (const runtimeIdentity of ['', null, 'a'.repeat(32), '00000000-0000-0000-0000-000000000000',
    source.state.runtimeIdentity.toUpperCase(), `stopped:${'a'.repeat(64)}`]) {
    assert.throws(() => createWindowsColdActivationIntent({
      ...source, state: { ...source.state, runtimeIdentity },
    }, ownerBytes, receipt, source.targetCommit), /original Windows cold activation/);
  }
  assert.throws(() => createWindowsColdActivationIntent({
    ...source, state: { ...source.state, priorRuntime: 'stopped' },
  }, ownerBytes, receipt, source.targetCommit), /original Windows cold activation/);
  for (const target of [null, '', 'not-a-commit', 'a'.repeat(41)]) {
    assert.throws(() => createWindowsColdActivationIntent(source, ownerBytes, receipt, target), /target commit/);
  }
  const sha256Commit = 'b'.repeat(64);
  assert.equal(createWindowsColdActivationIntent(source, ownerBytes, receipt, sha256Commit).state.targetCommit, sha256Commit);
  assert.notEqual(createWindowsColdActivationIntent(source, Buffer.concat([ownerBytes, Buffer.from('\n')]),
    receipt, source.targetCommit).ownerSha256, expected.ownerSha256);
  assert.notEqual(createWindowsColdActivationIntent(source, ownerBytes, {
    ...receipt, bytes: Buffer.concat([receipt.bytes, Buffer.from('\n')]),
  }, source.targetCommit).filesReceiptSha256, expected.filesReceiptSha256);
});

const coldHistoryFixture = () => {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const source = {
    ...record('running'), project: 'C:\\application',
    snapshotSha256: 'c'.repeat(64), stateSha256: 'd'.repeat(64),
    state: { sourceCommit: 'a'.repeat(40), priorRuntime: 'running',
      runtimeIdentity: '12345678-1234-1234-1234-123456789abc' },
  };
  const runtimeBundle = { directory: 'C:\\control\\runtime-new',
    configuration: 'C:\\control\\runtime-new\\configuration.json', sha256: 'e'.repeat(64) };
  const intent = createWindowsColdActivationIntent(source, Buffer.from(JSON.stringify(source)), {
    record: { runtimeBundle }, bytes: Buffer.from(JSON.stringify({ runtimeBundle })),
  }, source.targetCommit);
  const intentBytes = Buffer.from(JSON.stringify(intent));
  const runtime = {
    pid: 33, identity: '33:1234', generation: '22345678-1234-1234-1234-123456789abc',
    instanceGuid: '32345678-1234-1234-1234-123456789abc', sessionId: 0,
    configurationSha256: runtimeBundle.sha256, launcherPid: 34, readySha256: 'f'.repeat(64),
  };
  const common = {
    version: 1, operationId: intent.operationId, ownerSha256: intent.ownerSha256,
    filesReceiptSha256: intent.filesReceiptSha256, intentSha256: digest(intentBytes),
    controllerPid: 22, controllerIdentity: '22:1234', taskName: 'fixture-task',
    definition: '<Task />', securityDescriptor: 'O:SYG:SYD:P(A;;FA;;;SY)',
    configuration: runtimeBundle.configuration, configurationSha256: runtimeBundle.sha256,
  };
  const encode = entries => {
    let previousSha256 = digest(intentBytes);
    return entries.map(entry => {
      const bytes = Buffer.from(`${JSON.stringify({ ...common, previousSha256, ...entry })}\n`);
      previousSha256 = digest(bytes);
      return bytes;
    });
  };
  return { intent, intentBytes, runtime, taskName: common.taskName, encode };
};

test('Windows cold journal captures exact requested, running and stopped prefixes without mutation authority', async () => {
  const { captureWindowsColdActivationHistory } = await import('../scripts/deployment/windows-cold-activation-history.mjs');
  const fixture = coldHistoryFixture();
  const requested = { phase: 'start-requested', runtime: null };
  const running = { phase: 'running', runtime: fixture.runtime };
  for (const entries of [
    [requested], [requested, running], [requested, { phase: 'stopped', runtime: null }],
    [requested, { phase: 'stopped', runtime: fixture.runtime }],
    [requested, running, { phase: 'stopped', runtime: fixture.runtime }],
  ]) {
    const records = fixture.encode(entries);
    const captured = captureWindowsColdActivationHistory({ ...fixture, records });
    assert.equal(captured.mutationAuthority, false);
    assert.equal(captured.phase, entries.at(-1).phase);
    assert.equal(captured.controllerPid, 22);
    assert.equal(captured.controllerIdentity, '22:1234');
    assert.deepEqual(captured.runtime, entries.at(-1).runtime);
    assert.equal(captured.sha256, createHash('sha256').update(records.at(-1)).digest('hex'));
    assert.equal(captured.records.length, entries.length);
    assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.records));
    assert.ok(captured.records.every(Object.isFrozen));
    if (captured.runtime) assert.ok(Object.isFrozen(captured.runtime));
  }
});

test('Windows cold journal refuses altered owners, chain, task, runtime and unsupported prefixes', async () => {
  const { captureWindowsColdActivationHistory } = await import('../scripts/deployment/windows-cold-activation-history.mjs');
  const fixture = coldHistoryFixture();
  const requested = { phase: 'start-requested', runtime: null };
  const running = { phase: 'running', runtime: fixture.runtime };
  const stopped = { phase: 'stopped', runtime: fixture.runtime };
  const capture = entries => captureWindowsColdActivationHistory({ ...fixture, records: fixture.encode(entries) });
  for (const changed of [
    { version: 2 }, { operationId: 'another-operation' }, { ownerSha256: '0'.repeat(64) },
    { filesReceiptSha256: '0'.repeat(64) }, { intentSha256: '0'.repeat(64) },
    { previousSha256: '0'.repeat(64) }, { controllerPid: 23, controllerIdentity: '23:1234' },
    { controllerIdentity: '22:5678' }, { taskName: 'another-task' },
    { configuration: 'C:\\foreign\\configuration.json' }, { configurationSha256: '0'.repeat(64) },
    { definition: '' }, { securityDescriptor: 'foreign' }, { runtime: null }, { unknown: true },
    { runtime: { ...fixture.runtime, generation: fixture.intent.state.runtimeIdentity } },
    { runtime: { ...fixture.runtime, configurationSha256: '0'.repeat(64) } },
    { runtime: { ...fixture.runtime, pid: 22, identity: '22:1234' } },
  ]) assert.throws(() => capture([requested, { ...running, ...changed }]));
  for (const entries of [
    [], [running], [stopped], [requested, requested], [requested, running, running],
    [requested, stopped, running], [requested, running, stopped, stopped],
    [{ ...requested, runtime: fixture.runtime }],
    [{ ...requested, controllerPid: 0, controllerIdentity: '0:1234' }],
    [{ ...requested, controllerIdentity: '22:0' }],
    [requested, running, { ...stopped, runtime: null }],
    [requested, running, { ...stopped, runtime: { ...fixture.runtime, readySha256: '0'.repeat(64) } }],
  ]) assert.throws(() => capture(entries));
  const records = fixture.encode([requested, running]);
  records[0] = Buffer.concat([records[0], Buffer.from('\n')]);
  assert.throws(() => captureWindowsColdActivationHistory({ ...fixture, records }));
  assert.throws(() => captureWindowsColdActivationHistory({
    ...fixture, intentBytes: Buffer.from('{}'), records: fixture.encode([requested]),
  }));
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{'), Buffer.alloc(4194305), '{}']) {
    assert.throws(() => captureWindowsColdActivationHistory({ ...fixture, records: [bytes] }));
  }
});
