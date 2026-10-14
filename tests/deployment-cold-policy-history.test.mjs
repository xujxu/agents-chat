import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const owner = pid => ({
  controllerPid: pid, controllerIdentity: `${pid}:1234`,
  bridgePid: pid + 1, bridgeIdentity: `${pid + 1}:5678`,
});
function fixture() {
  const binding = {
    operationId: '11111111-1111-4111-8111-111111111111', taskName: 'agents-chat',
    ownerSha256: 'a'.repeat(64), filesReceiptSha256: 'b'.repeat(64),
    intentSha256: 'c'.repeat(64), historySha256: 'd'.repeat(64), stateSha256: 'e'.repeat(64),
    sourceDefinition: '<Task>guarded-disabled</Task>',
    targetDefinition: '<Task>original-disabled</Task>', securityDescriptor: 'original-security',
  };
  const encode = entries => {
    let previousSha256 = binding.historySha256;
    return entries.map((entry, index) => {
      const bytes = Buffer.from(JSON.stringify({
        version: 1, ...binding, sequence: index + 1, previousSha256, ...owner(100), ...entry,
      }, null, index === 0 ? 2 : 0));
      previousSha256 = digest(bytes);
      return bytes;
    });
  };
  return { binding, encode };
}

test('cold policy recovery journal preserves write-ahead steps and distinct takeover owners', async () => {
  const { captureWindowsColdPolicyHistory } = await import('../scripts/deployment/windows-cold-policy-history.mjs');
  const { binding, encode } = fixture();
  const entries = [
    { kind: 'claim', step: 'initial' },
    { kind: 'request', step: 'requested' },
    { kind: 'claim', step: 'requested', ...owner(200) },
    { kind: 'claim', step: 'requested', ...owner(300) },
    { kind: 'restored', step: 'restored', ...owner(300) },
    { kind: 'claim', step: 'restored', ...owner(400) },
  ];
  for (let count = 0; count <= entries.length; count++) {
    const records = encode(entries.slice(0, count));
    const captured = captureWindowsColdPolicyHistory({ binding, records });
    assert.equal(captured.mutationAuthority, false);
    assert.equal(captured.sequence, count);
    assert.equal(captured.step, count ? entries[count - 1].step : 'initial');
    assert.equal(captured.sha256, count ? digest(records.at(-1)) : binding.historySha256);
    assert.deepEqual(captured.owner, count ? owner(count >= 6 ? 400 : count >= 4 ? 300 : count >= 3 ? 200 : 100) : null);
    assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.records));
    assert.ok(captured.records.every(Object.isFrozen));
    if (captured.owner) assert.ok(Object.isFrozen(captured.owner));
  }
});

test('cold policy recovery refuses phase rollback, owner reuse and unbound policy mutation', async () => {
  const { captureWindowsColdPolicyHistory } = await import('../scripts/deployment/windows-cold-policy-history.mjs');
  const { binding, encode } = fixture();
  const claim = { kind: 'claim', step: 'initial' };
  const request = { kind: 'request', step: 'requested' };
  const restored = { kind: 'restored', step: 'restored' };
  const capture = entries => captureWindowsColdPolicyHistory({ binding, records: encode(entries) });
  for (const entries of [
    [request], [restored], [{ ...claim, step: 'requested' }],
    [claim, claim], [claim, restored], [claim, request, request],
    [claim, request, { ...claim, ...owner(200) }],
    [claim, request, { kind: 'claim', step: 'restored', ...owner(200) }],
    [claim, { ...request, ...owner(200) }],
    [claim, request, { ...restored, ...owner(200) }],
    [claim, request, restored, request],
    [claim, { kind: 'claim', step: 'initial', bridgePid: 201, bridgeIdentity: '201:5678' }],
    [claim, { kind: 'claim', step: 'initial', controllerPid: 200, controllerIdentity: '200:1234' }],
    [claim, { kind: 'claim', step: 'initial', ...owner(200) },
      { kind: 'claim', step: 'initial', ...owner(100) }],
  ]) assert.throws(() => capture(entries));
  for (const changed of [
    { version: 2 }, { sequence: 3 }, { previousSha256: '0'.repeat(64) },
    { operationId: 'another-operation' }, { taskName: 'foreign-task' },
    { ownerSha256: '0'.repeat(64) }, { filesReceiptSha256: '0'.repeat(64) },
    { intentSha256: '0'.repeat(64) }, { historySha256: '0'.repeat(64) }, { stateSha256: '0'.repeat(64) },
    { sourceDefinition: '<foreign/>' }, { targetDefinition: '<enabled/>' },
    { securityDescriptor: 'foreign' }, { controllerPid: 0 }, { controllerIdentity: '100:0' },
    { bridgePid: 100, bridgeIdentity: '100:1234' }, { bridgeIdentity: '101:0' },
    { kind: 'complete' }, { step: 'complete' }, { unknown: true },
  ]) assert.throws(() => capture([claim, { ...request, ...changed }]));
  const records = encode([claim, request]);
  records[0] = Buffer.concat([records[0], Buffer.from('\n')]);
  assert.throws(() => captureWindowsColdPolicyHistory({ binding, records }));
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{'), Buffer.alloc(4194305), '{}']) {
    assert.throws(() => captureWindowsColdPolicyHistory({ binding, records: [bytes] }));
  }
  assert.throws(() => captureWindowsColdPolicyHistory({ binding, records: Array(257).fill(Buffer.from('{}')) }));
  assert.throws(() => captureWindowsColdPolicyHistory({
    binding: { ...binding, unknown: true }, records: [],
  }));
});

test('unacknowledged cold policy takeover retains the exact original launch digest', async () => {
  const { captureWindowsColdPolicyHistory } = await import('../scripts/deployment/windows-cold-policy-history.mjs');
  const { binding, encode } = fixture();
  binding.launchSha256 = 'f'.repeat(64);
  const entries = [
    { kind: 'claim', step: 'initial' },
    { kind: 'request', step: 'requested' },
    { kind: 'claim', step: 'requested', ...owner(200) },
    { kind: 'restored', step: 'restored', ...owner(200) },
  ];
  const records = encode(entries);
  const captured = captureWindowsColdPolicyHistory({ binding, records });
  assert.equal(captured.step, 'restored');
  assert.ok(captured.records.every(record => record.launchSha256 === binding.launchSha256));
  for (const launchSha256 of ['', null, '0'.repeat(64)]) {
    assert.throws(() => captureWindowsColdPolicyHistory({ binding: { ...binding, launchSha256 }, records }));
    assert.throws(() => captureWindowsColdPolicyHistory({
      binding, records: encode([entries[0], { ...entries[1], launchSha256 }]),
    }));
  }
  delete binding.launchSha256;
  assert.throws(() => captureWindowsColdPolicyHistory({ binding, records }));
});

test('cold policy journal enforces its exact aggregate byte budget without reserializing records', async () => {
  const { captureWindowsColdPolicyHistory } = await import('../scripts/deployment/windows-cold-policy-history.mjs');
  const { binding, encode } = fixture();
  const records = [];
  for (let index = 0; index < 5; index++) {
    const [bytes] = encode([{
      kind: 'claim', step: 'initial', ...owner(100 + index * 2), sequence: index + 1,
      previousSha256: index ? digest(records.at(-1)) : binding.historySha256,
    }]);
    records.push(Buffer.concat([bytes, Buffer.alloc(4194304 - bytes.length, 32)]));
  }
  assert.equal(captureWindowsColdPolicyHistory({ binding, records: records.slice(0, 4) }).sequence, 4);
  assert.throws(() => captureWindowsColdPolicyHistory({ binding, records }), /total byte budget/);
});

test('cold policy recovery requires explicit acknowledgement and honors early cancellation', async () => {
  const { prepareWindowsColdPolicyRecovery } = await import('../scripts/deployment/windows-cold-activation-recovery.mjs');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareWindowsColdPolicyRecovery({ signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(prepareWindowsColdPolicyRecovery(), /data-loss acknowledgement/);
});
