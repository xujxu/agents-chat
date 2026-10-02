import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import * as api from '../scripts/deployment/windows-task-completion-proof.mjs';

const [control, pwsh, mode] = process.argv.slice(2);
for (const name of ['beginWindowsTaskRetirement', 'openWindowsTaskRetirement', 'retireNextWindowsTaskFile']) {
  assert.equal(typeof api[name], 'function', `Missing native receipt retirement API: ${name}`);
}
const fileAt = entry => path.join(control, entry.path);
const useRetirement = callback => withWindowsAdmission(control, { pwsh }, async admission => {
  const scope = await api.openWindowsTaskRetirement({ control, pwsh, admission });
  try { return await callback(scope, admission); }
  finally { await scope.close(); }
});
if (mode === 'hold') {
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const proof = await api.openWindowsTaskCompletionProof({ control, pwsh, admission });
    const scope = await api.beginWindowsTaskRetirement(control, proof, admission);
    try {
      assert.deepEqual(scope.identity, proof.identity, 'Handoff replaced the original native controller.');
      await assert.rejects(proof.check(), /unavailable|transferred/i);
      await assert.rejects(api.prepareWindowsTaskRetirement(control, proof, admission), /unavailable|transferred/i);
      for (const [root, retained, admitted] of [
        [control, { ...scope }, admission], [`${control}-foreign`, scope, admission],
        [control, scope, { ...admission }],
      ]) await assert.rejects(api.retireNextWindowsTaskFile(root, retained, admitted), /retained.*retirement/i);
      let observation = await scope.check();
      assert.equal(observation.retiredFiles, 0);
      for (let count = 1; count <= 3; count++) {
        observation = await api.retireNextWindowsTaskFile(control, scope, admission);
        assert.equal(observation.retiredFiles, count);
      }
      await new Promise((resolve, reject) => process.send(
        { observation, proof: scope.identity, admission: admission.identity },
        error => error ? reject(error) : resolve()));
      await delay(120000);
      throw new Error('Parent did not terminate original retirement controller.');
    } finally { await scope.close(); }
  });
} else {
  const state = await readFile(path.join(control, 'state.json'));
  const owner = await readFile(path.join(control, 'lock', 'owner.json'));
  const child = fork(fileURLToPath(import.meta.url), [control, pwsh, 'hold'], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
  const deadline = AbortSignal.timeout(120000);
  const exited = once(child, 'exit', { signal: deadline });
  exited.catch(() => {});
  let ready;
  try {
    [ready] = await Promise.race([
      once(child, 'message', { signal: deadline }),
      exited.then(() => { throw new Error(`Receipt retirement fixture exited before readiness: ${stderr}`); }),
    ]);
    for (const identity of [ready.proof, ready.admission]) {
      assert.equal(await processIdentity(identity.pid), identity.processIdentity);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
  const until = Date.now() + 20000;
  for (const identity of [ready.proof, ready.admission]) {
    while (await processIdentity(identity.pid) === identity.processIdentity) {
      assert.ok(Date.now() < until, 'Original retirement/admission survived its Node owner.');
      await delay(100);
    }
  }
  const original = ready.observation;
  assert.deepEqual(await useRetirement(scope => scope.check()), original);
  const descriptors = original.checkpoint.intent.intent.files;
  const refused = () => assert.rejects(useRetirement(scope => scope.check()), error =>
    error.recoveryAllowed === false);
  const held = path.join(control, 'retirement-fixture-held');
  const hole = fileAt(descriptors[8]);
  await rename(hole, held);
  try { await refused(); }
  finally { await rename(held, hole); }
  const next = fileAt(descriptors[3]);
  const bytes = await readFile(next);
  try {
    await writeFile(next, Buffer.concat([bytes, Buffer.from('\n')]));
    await refused();
  } finally { await writeFile(next, bytes); }
  await rename(next, held);
  try {
    await writeFile(next, bytes);
    await refused();
  } finally {
    await unlink(next);
    await rename(held, next);
  }
  const extra = path.join(control, 'task-maintenance', 'unexpected.json');
  await writeFile(extra, '{}');
  try { await refused(); }
  finally { await unlink(extra); }
  const checkpointFile = fileAt(original.checkpoint.descriptor);
  const checkpointBytes = await readFile(checkpointFile);
  const changed = structuredClone(original.checkpoint.checkpoint);
  changed.creator.pid = process.pid;
  changed.creator.processIdentity = await processIdentity(process.pid);
  try {
    await writeFile(checkpointFile, JSON.stringify(changed));
    await refused();
  } finally { await writeFile(checkpointFile, checkpointBytes); }
  await useRetirement(async (scope, admission) => {
    assert.deepEqual(await scope.check(), original);
    for (let count = 4; count <= descriptors.length; count++) {
      const observation = await api.retireNextWindowsTaskFile(control, scope, admission);
      assert.equal(observation.retiredFiles, count);
      assert.deepEqual(observation.checkpoint, original.checkpoint);
    }
    await assert.rejects(api.retireNextWindowsTaskFile(control, scope, admission), /exhausted/i);
    assert.equal((await scope.check()).retiredFiles, descriptors.length);
  });
  const complete = await useRetirement(scope => scope.check());
  assert.equal(complete.retiredFiles, 23);
  assert.deepEqual(complete.checkpoint, original.checkpoint);
  assert.deepEqual(await readdir(path.join(control, 'task-maintenance')), []);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
  assert.deepEqual(await readFile(path.join(control, 'lock', 'owner.json')), owner);
  console.log('PASS: native checkpoint handoff retires exact receipts, survives original actor loss, rejects holes/replacements/live creators and reopens at the completed prefix without unlock');
}
