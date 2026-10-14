import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectWindowsColdActivationRecovery } from '../scripts/deployment/windows-cold-activation-recovery.mjs';

const [control, pwsh, phase = 'stopped', mode = 'runtime'] = process.argv.slice(2);
assert.ok(['start-requested', 'running', 'stopped'].includes(phase));
assert.ok(['runtime', 'prepared'].includes(mode));
const prepared = mode === 'prepared';
if (prepared) assert.equal(phase, 'start-requested');
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
const lastFile = path.join(directory, `activation-${phase}.json`);
const stoppedBytes = await readFile(lastFile);
const stopped = JSON.parse(stoppedBytes);
if (phase === 'running') assert.ok(!names.includes('activation-stopped.json'));
let launch;
if (phase === 'start-requested') {
  assert.equal(stopped.runtime, null);
  assert.ok(!names.includes('activation-running.json') && !names.includes('activation-stopped.json'));
  const bundle = path.dirname(stopped.configuration);
  const launchNames = (await readdir(bundle)).filter(name => name.startsWith('launch-'));
  assert.equal(launchNames.length, prepared ? 0 : 1);
  if (prepared) {
    assert.equal(stopped.version, 2);
    for (const name of ['enable-requested.json', 'runtime-33-1234.json', 'launch-33-1234.json']) {
      const file = path.join(bundle, name);
      await assert.rejects(lstat(file), { code: 'ENOENT' });
      await writeFile(file, '{}', { flag: 'wx' });
      try { await assert.rejects(inspectWindowsColdActivationRecovery({ control, pwsh })); }
      finally { await unlink(file); }
    }
  } else {
    const file = path.join(bundle, launchNames[0]);
    const bytes = await readFile(file);
    launch = { file, bytes };
    originals.push(launch);
  }
}
const proof = await inspectWindowsColdActivationRecovery({ control, pwsh });
try {
  assert.equal(proof.observation.status, phase === 'stopped' ? 'cold-activation-stopped' : 'cold-activation-inactive');
  assert.equal(proof.observation.mutationAuthority, false);
  assert.equal(proof.advance, undefined);
  assert.equal(proof.archive, undefined);
  assert.equal(proof.observation.operationId, state.operationId);
  assert.equal(proof.observation.taskName, stopped.taskName);
  assert.equal(proof.observation.historySha256, createHash('sha256').update(stoppedBytes).digest('hex'));
  assert.deepEqual(proof.observation.runtime, stopped.runtime);
  if (prepared) {
    assert.equal(proof.observation.preparationSha256, proof.observation.historySha256);
    assert.equal(proof.observation.launch, undefined);
    assert.equal(proof.observation.launchSha256, undefined);
  }
  if (launch) {
    assert.deepEqual(proof.observation.launch, JSON.parse(launch.bytes));
    assert.ok(Object.isFrozen(proof.observation.launch));
    assert.equal(proof.observation.launchSha256, createHash('sha256').update(launch.bytes).digest('hex'));
    await assert.rejects(writeFile(launch.file, launch.bytes));
  }
  assert.deepEqual(await proof.check(), proof.observation);
  await assert.rejects(writeFile(lastFile, stoppedBytes));
  assert.deepEqual(await proof.check(), proof.observation);
} finally {
  await proof.close();
}
await assert.rejects(proof.check(), /closed/);
assert.deepEqual((await readdir(directory)).sort(), names);
for (const original of originals) assert.deepEqual(await readFile(original.file), original.bytes);
console.log(prepared
  ? 'PASS: independent never-enabled preparation inspection refuses enable/launch/readiness evidence and retains null runtime without mutation authority'
  : `PASS: independent cold activation inspection retains ${phase} history and proves old/new runtime absence without mutation authority`);
