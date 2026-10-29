import assert from 'node:assert/strict';

export async function assertRestartPublicationProofs({
  publication, transport, ready, control, identity, captureWorkerFields, enterPhase,
}) {
  assert.ok(['directory', 'owner', 'committed', 'state-intent'].includes(publication));
  for (const stage of ['before', 'after']) {
    enterPhase(`restart-${publication}-${stage}-proof`);
    const proof = captureWorkerFields(await transport.wire.receive({ timeoutMs: 45000 }),
      ['type', 'stage', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'],
      `restart ${publication} ancestor proof`);
    assert.deepEqual(proof, {
      type: `restart-${publication}-proof`, stage, pid: ready.pid, processIdentity: ready.processIdentity,
      control, controllerIdentity: identity, value: ready.value,
    });
  }
  enterPhase(`restart-${publication}-result`);
}
