import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectWindowsColdActivationRecovery } from '../scripts/deployment/windows-cold-activation-recovery.mjs';

const [control, pwsh] = process.argv.slice(2);
const directory = path.join(control, 'recovery-lock');
const names = (await readdir(directory)).sort();
const files = [
  'state.json', 'lock/owner.json', 'backup/manifest.json',
  ...names.map(name => `recovery-lock/${name}`),
];
const originals = await Promise.all(files.map(async name => ({
  file: path.join(control, name), bytes: await readFile(path.join(control, name)),
})));
const state = JSON.parse(originals[0].bytes);
const stoppedBytes = await readFile(path.join(directory, 'activation-stopped.json'));
const stopped = JSON.parse(stoppedBytes);
const proof = await inspectWindowsColdActivationRecovery({ control, pwsh });
try {
  assert.equal(proof.observation.status, 'cold-activation-stopped');
  assert.equal(proof.observation.mutationAuthority, false);
  assert.equal(proof.observation.operationId, state.operationId);
  assert.equal(proof.observation.taskName, stopped.taskName);
  assert.equal(proof.observation.historySha256, createHash('sha256').update(stoppedBytes).digest('hex'));
  assert.deepEqual(proof.observation.runtime, stopped.runtime);
  assert.deepEqual(await proof.check(), proof.observation);
  await assert.rejects(writeFile(path.join(directory, 'activation-stopped.json'), stoppedBytes));
  assert.deepEqual(await proof.check(), proof.observation);
} finally {
  await proof.close();
}
await assert.rejects(proof.check(), /closed/);
assert.deepEqual((await readdir(directory)).sort(), names);
for (const original of originals) assert.deepEqual(await readFile(original.file), original.bytes);
console.log('PASS: independent cold activation inspection retains stopped history and proves old/new runtime absence without mutation authority');
