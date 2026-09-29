import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment, acceptOperation } from './deployment-fixture.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';
import { publishDeploymentReceipt, readDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'control');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  const identity = { source: 'a'.repeat(40), build: 'b'.repeat(64), dependencies: 'c'.repeat(64),
    config: 'd'.repeat(64), service: 'e'.repeat(64) };
  return { control, lock, identity, checkAccepted: async () => ({ ...identity }) };
}

test('deployment receipts require accepted state and fresh matching source/artifact/runtime checks', async t => {
  const f = await fixture(t);
  assert.equal(await readDeploymentReceipt(f.control, f.lock.project), null);
  await assert.rejects(publishDeploymentReceipt(f), /accepted/i);
  await acceptOperation(f.control, f.lock);
  const receipt = await publishDeploymentReceipt(f);
  assert.equal(receipt.status, 'accepted');
  assert.deepEqual(receipt.identity, f.identity);
  assert.equal(receipt.operationId, f.lock.operationId);
  assert.deepEqual(await readDeploymentReceipt(f.control, f.lock.project), receipt);
  await publishDeploymentReceipt(f);
  await assert.rejects(publishDeploymentReceipt({ ...f,
    checkAccepted: async () => ({ ...f.identity, build: 'f'.repeat(64) }) }), /identity|changed/i);
  await assert.rejects(readDeploymentReceipt(f.control, path.dirname(f.lock.project)), /project/i);
});

test('incomplete or foreign staged receipts are retained rather than overwritten', async t => {
  const f = await fixture(t);
  await acceptOperation(f.control, f.lock);
  const stage = path.join(f.control, '.deployment.json.staging');
  await writeFile(stage, '{"partial":', { mode: 0o600 });
  await assert.rejects(publishDeploymentReceipt(f), /staged|receipt/i);
  assert.equal(await readFile(stage, 'utf8'), '{"partial":');
  assert.equal(await readDeploymentReceipt(f.control, f.lock.project), null);
});

test('receipt publication cannot hide a failed live acceptance check or invalid identity', async t => {
  const f = await fixture(t);
  await acceptOperation(f.control, f.lock);
  await assert.rejects(publishDeploymentReceipt({ ...f, checkAccepted: async () => { throw new Error('runtime replaced'); } }),
    /runtime replaced/);
  await assert.rejects(publishDeploymentReceipt({ ...f, identity: { ...f.identity, source: 'f'.repeat(40) } }),
    /source|state/i);
  await assert.rejects(publishDeploymentReceipt({ ...f, identity: { ...f.identity, config: 'missing' } }), /identity/i);
  assert.equal(await readDeploymentReceipt(f.control, f.lock.project), null);
});
