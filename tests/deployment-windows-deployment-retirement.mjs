import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [control, pwsh, mode] = process.argv.slice(2);
const recovery = path.join(control, 'recovery-engine');
const savedImport = name => import(pathToFileURL(path.join(recovery, name)).href);
const api = await savedImport('windows-task-completion-proof.mjs');
const { withWindowsAdmission } = await savedImport('windows-admission.mjs');
const { processIdentity } = await savedImport('process-identity.mjs');
const { acquireLock, releaseLock, reconcileInterruptedOperation } = await savedImport('state.mjs');
const { captureWindowsDeploymentRetirement } = await savedImport('windows-deployment-retirement-record.mjs');
for (const name of ['beginWindowsDeploymentRetirement',
  'openWindowsDeploymentRetirement', 'retireNextWindowsDeploymentEntry']) {
  assert.equal(typeof api[name], 'function', `Missing native deployment retirement API: ${name}`);
}
const useScope = callback => withWindowsAdmission(control, { pwsh }, async admission => {
  const scope = await api.openWindowsDeploymentRetirement({ control, pwsh, admission });
  try { return await callback(scope, admission); }
  finally { await scope.close(); }
});
const hold = async (scope, admission, count) => {
  let observation = await scope.check();
  while (observation.retiredEntries < count) {
    const expected = observation.retiredEntries + 1;
    observation = await api.retireNextWindowsDeploymentEntry(control, scope, admission);
    assert.equal(observation.retiredEntries, expected);
    assert.equal(observation.status, 'retiring-deployment');
  }
  assert.equal((await reconcileInterruptedOperation(control)).status, 'blocked');
  await assert.rejects(acquireLock(control, {
    project: observation.manifest.record.task.intent.intent.project,
    operationId: randomUUID(), admission, pwsh,
  }), /maintenance|retirement/i);
  await new Promise((resolve, reject) => process.send(
    { observation, proof: scope.identity, admission: admission.identity },
    error => error ? reject(error) : resolve()));
  await delay(120000);
  throw new Error('Parent did not terminate the deployment retirement actor.');
};
if (mode === 'hold') {
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const task = await api.openWindowsTaskRetirement({ control, pwsh, admission });
    const scope = await api.beginWindowsDeploymentRetirement(control, task, admission);
    try {
      assert.deepEqual(scope.identity, task.identity);
      await assert.rejects(task.check(), /unavailable|transferred/i);
      await assert.rejects(task.close(), /unavailable|transferred/i);
      await assert.rejects(api.retireNextWindowsTaskFile(control, task, admission), /unavailable|transferred/i);
      for (const [root, retained, admitted] of [
        [control, { ...scope }, admission], [`${control}-foreign`, scope, admission],
        [control, scope, { ...admission }],
      ]) await assert.rejects(api.retireNextWindowsDeploymentEntry(root, retained, admitted), /retained.*retirement/i);
      await hold(scope, admission, 7);
    } finally { await scope.close(); }
  });
} else if (mode === 'hold-final') {
  await useScope((scope, admission) => hold(scope, admission, scope.observation.manifest.record.entries.length));
} else {
  const state = await readFile(path.join(control, 'state.json'));
  const initial = new Map(await Promise.all((await readdir(control)).map(async name => {
    const info = await lstat(path.join(control, name), { bigint: true });
    return [name, { dev: info.dev, ino: info.ino }];
  })));
  const crash = async mode => {
    const child = fork(fileURLToPath(import.meta.url), [control, pwsh, mode], {
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
    const deadline = AbortSignal.timeout(180000);
    const exited = once(child, 'exit', { signal: deadline });
    exited.catch(() => {});
    let ready;
    try {
      [ready] = await Promise.race([
        once(child, 'message', { signal: deadline }),
        exited.then(() => { throw new Error(`Deployment retirement actor exited: ${stderr}`); }),
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
        assert.ok(Date.now() < until, 'Native deployment cleanup survived its Node controller.');
        await delay(100);
      }
    }
    return ready.observation;
  };
  const original = await crash('hold');
  assert.equal(original.retiredEntries, 7);
  const retiredRoots = new Set(original.manifest.record.entries.map(entry => entry.path.split('\\')[0]));
  const preserved = [...initial.keys()].filter(name => !retiredRoots.has(name)).sort();
  const captured = captureWindowsDeploymentRetirement(original);
  assert.deepEqual(captured, original);
  assert.ok(Object.isFrozen(captured.manifest.record.entries));
  for (const retiredEntries of [-1, original.manifest.record.entries.length + 1, 1.5, '7']) {
    assert.throws(() => captureWindowsDeploymentRetirement({ ...original, retiredEntries }));
  }
  assert.throws(() => captureWindowsDeploymentRetirement({ ...original, status: 'retired' }));
  assert.throws(() => captureWindowsDeploymentRetirement({ ...original, mutationAuthority: true }));
  assert.deepEqual(await useScope(scope => scope.check()), original);
  const refused = () => assert.rejects(useScope(scope => scope.check()), error => error.recoveryAllowed === false);
  const fileAt = entry => path.join(control, entry.path);
  const held = path.join(control, 'retirement-fixture-held');
  const hole = fileAt(original.manifest.record.entries[9]);
  await rename(hole, held);
  try { await refused(); }
  finally { await rename(held, hole); }
  const next = fileAt(original.manifest.record.entries[7]);
  const bytes = await readFile(next);
  await rename(next, held);
  try {
    await writeFile(next, bytes);
    await refused();
  } finally {
    await unlink(next);
    await rename(held, next);
  }
  const marker = path.join(control, 'worker-retirement.json');
  const markerBytes = await readFile(marker);
  for (const mutate of [
    value => { value.entries[7].path = 'state.json'; },
    value => { value.task.checkpoint.enabled = !value.task.checkpoint.enabled; },
    value => { value.entries.push(value.entries[7]); },
  ]) {
    const changed = structuredClone(original.manifest.record);
    mutate(changed);
    try {
      await writeFile(marker, JSON.stringify(changed));
      await refused();
    } finally { await writeFile(marker, markerBytes); }
  }
  assert.deepEqual(await useScope(scope => scope.check()), original);
  const beforeCommit = await crash('hold-final');
  assert.equal(beforeCommit.retiredEntries, original.manifest.record.entries.length);
  assert.deepEqual(beforeCommit.manifest, original.manifest);
  assert.deepEqual(await useScope(scope => scope.check()), beforeCommit);
  assert.deepEqual((await readdir(control)).sort(), [...preserved, 'worker-retirement.json'].sort());
  const completed = await useScope((scope, admission) => api.retireNextWindowsDeploymentEntry(control, scope, admission));
  assert.equal(completed.status, 'retired');
  assert.deepEqual(completed.manifest, original.manifest);
  assert.equal(completed.retiredEntries, beforeCommit.retiredEntries);
  assert.deepEqual((await readdir(control)).sort(), preserved);
  for (const name of preserved) {
    const info = await lstat(path.join(control, name), { bigint: true });
    assert.deepEqual({ dev: info.dev, ino: info.ino }, initial.get(name), `Unrelated retained entry changed: ${name}`);
  }
  assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
  assert.equal((await reconcileInterruptedOperation(control)).status, 'idle');
  const lock = await acquireLock(control, {
    project: original.manifest.record.task.intent.intent.project, operationId: randomUUID(), pwsh,
  });
  await releaseLock(control, lock, { pwsh });
  assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
  console.log('PASS: same-controller deployment handoff, two crash prefixes, independent saved recovery, exact native cleanup and final unlock preserve accepted state and runtime');
}
