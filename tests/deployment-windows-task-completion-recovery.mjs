import assert from 'node:assert/strict';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [control, pwsh, crashStep] = process.argv.slice(2);
const saved = path.join(control, 'recovery-engine');
const load = name => import(pathToFileURL(path.join(saved, name)).href);
const api = await load('windows-task-completion-proof.mjs');
const { withWindowsAdmission } = await load('windows-admission.mjs');
assert.equal(typeof api.openWindowsTaskCompletionRecovery, 'function',
  'Missing original-runtime completion recovery');
const stateFile = path.join(control, 'state.json');
const state = await readFile(stateFile);
const project = JSON.parse(state).project;
const directory = path.join(control, 'task-maintenance');
const originals = await Promise.all((await readdir(directory)).map(async name => ({
  name, bytes: await readFile(path.join(directory, name)),
  identity: await stat(path.join(directory, name), { bigint: true }),
})));
await withWindowsAdmission(control, { pwsh }, async admission => {
  const options = { control, pwsh, admission };
  const refused = () => assert.rejects(api.openWindowsTaskCompletionRecovery(options),
    { code: 'DEPLOYMENT_WINDOWS_COMPLETION_RECOVERY_REFUSED' });
  await assert.rejects(api.openWindowsTaskCompletionProof(options));
  if (crashStep === 'release-requested') {
    await refused();
    return;
  }
  const earlier = path.join(directory, 'task-complete-policy-staged.json');
  const moved = path.join(control, 'completion-negative-original.json');
  await rename(earlier, moved);
  try { await refused(); }
  finally { await rename(moved, earlier); }
  await writeFile(stateFile, Buffer.concat([state, Buffer.from(' ')]));
  try { await refused(); }
  finally { await writeFile(stateFile, state); }
  const health = path.join(project, 'health-mode');
  const priorHealth = await readFile(health);
  let scope = await api.openWindowsTaskCompletionRecovery(options);
  try {
    assert.equal(scope.observation.status, 'pending');
    await writeFile(health, 'unavailable');
    await assert.rejects(scope.advance());
  } finally {
    await writeFile(health, priorHealth);
    await scope.close();
  }
  scope = await api.openWindowsTaskCompletionRecovery(options);
  const initial = scope.observation;
  try {
    for (let count = 0; scope.observation.status !== 'complete'; count++) {
      assert.ok(count < 9, 'Recovery exceeded its finite completion sequence');
      await scope.advance();
      await scope.check();
      assert.deepEqual(scope.observation.runtime, initial.runtime);
      assert.equal(scope.observation.stateSha256, initial.stateSha256);
    }
    await scope.advance();
  } finally { await scope.close(); }
  const proof = await api.openWindowsTaskCompletionProof(options);
  try {
    const observed = await proof.check();
    assert.deepEqual(observed.runtime, initial.runtime);
    assert.equal(observed.stateSha256, initial.stateSha256);
  } finally { await proof.close(); }
});
assert.deepEqual(await readFile(stateFile), state);
for (const original of originals) {
  const file = path.join(directory, original.name);
  assert.deepEqual(await readFile(file), original.bytes);
  const identity = await stat(file, { bigint: true });
  assert.equal(identity.dev, original.identity.dev);
  assert.equal(identity.ino, original.identity.ino);
}
console.log('PASS: genuine completion interruption preserves original evidence and reconciles only released runtime');
