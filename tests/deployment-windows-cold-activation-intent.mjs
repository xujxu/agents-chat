import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyWindowsColdActivationIntent({ control, lease, configuration, snapshot }) {
  await assert.rejects(lease.prepareActivation({ configuration: { ...configuration } }), /original retained configuration/i);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lease.prepareActivation({ configuration, signal: controller.signal }), { name: 'AbortError' });
  await lease.checkStopped();
  await configuration.checkFiles();
  const stateBytes = await readFile(path.join(control, 'state.json'));
  const ownerBytes = await readFile(path.join(control, 'recovery-lock/owner.json'));
  const receiptBytes = await readFile(path.join(control, 'recovery-lock/files-restored.json'));
  const receipt = JSON.parse(receiptBytes);
  const originalCommit = lease.snapshot.source.commit;
  lease.snapshot.source.commit = 'a'.repeat(40);
  let activation;
  try { activation = await lease.prepareActivation({ configuration }); }
  finally { lease.snapshot.source.commit = originalCommit; }
  const state = {
    version: 1, operationId: lease.lock.operationId, project: lease.lock.project, operation: 'restore',
    phase: 'restore-activating', previousPhase: 'restoring', sourceCommit: lease.state.sourceCommit,
    targetCommit: snapshot.source.commit, backupId: snapshot.id, priorRuntime: 'running',
    runtimeIdentity: lease.state.runtimeIdentity, startedAt: lease.owner.createdAt,
    updatedAt: lease.owner.createdAt, errorCode: null,
  };
  const file = path.join(control, 'recovery-lock/activation-intent.json');
  const bytes = await readFile(file);
  assert.deepEqual(JSON.parse(bytes), {
    version: 1, phase: 'activation-intent', ownerSha256: digest(ownerBytes),
    filesReceiptSha256: digest(receiptBytes), operationId: lease.lock.operationId,
    backupId: snapshot.id, snapshotSha256: receipt.snapshotSha256,
    stateSha256: receipt.stateSha256, runtimeBundle: receipt.runtimeBundle, state,
  });
  assert.deepEqual(activation.state, state);
  assert.deepEqual(await activation.check(), state);
  assert.ok(Object.isFrozen(activation.state));
  await assert.rejects(writeFile(file, 'changed'));
  await assert.rejects(lease.prepareActivation({ configuration }), /already prepared/);
  await assert.rejects(lease.checkStopped(), /already prepared/);
  await assert.rejects(lease.retireRuntime(), /already prepared/);
  await assert.rejects(lease.markFilesRestored({ runtimeBundle: receipt.runtimeBundle }), /already prepared/);
  await assert.rejects(lease.inspectRestoredConfiguration(), /already prepared/);
  await configuration.checkFiles();
  assert.deepEqual(await activation.check(), state);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(control, 'recovery-lock/owner.json')), ownerBytes);
  assert.deepEqual(await readFile(path.join(control, 'recovery-lock/files-restored.json')), receiptBytes);
  return activation;
}
