import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { captureWindowsTaskRetirementCheckpoint } from '../scripts/deployment/windows-task-retirement-checkpoint.mjs';
import {
  openWindowsTaskCompletionProof, prepareWindowsTaskRetirement,
  prepareWindowsTaskRetirementCheckpoint,
} from '../scripts/deployment/windows-task-completion-proof.mjs';

const [control, pwsh, mode] = process.argv.slice(2);
async function prepare(check) {
  return withWindowsAdmission(control, { pwsh }, async admission => {
    const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
    try {
      for (const [location, retained, admitted] of [
        [control, { ...proof }, admission], [`${control}-foreign`, proof, admission],
        [control, proof, { ...admission }],
      ]) await assert.rejects(prepareWindowsTaskRetirementCheckpoint(location, retained, admitted),
        /Original retained completed-task proof/);
      const intent = await prepareWindowsTaskRetirement(control, proof, admission);
      const result = await prepareWindowsTaskRetirementCheckpoint(control, proof, admission);
      assert.equal(result.status, 'prepared');
      assert.equal(result.descriptor.path, 'task-retirement-checkpoint.json');
      assert.deepEqual(result.intent, intent);
      assert.deepEqual(result.checkpoint.intent, intent.descriptor);
      const file = path.join(control, result.descriptor.path);
      const bytes = await readFile(file);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.descriptor.sha256);
      assert.deepEqual(JSON.parse(bytes), result.checkpoint);
      const info = await stat(file, { bigint: true });
      assert.equal(String(info.dev), result.descriptor.dev);
      assert.equal(String(info.ino), result.descriptor.ino);
      assert.equal(Number(info.size), result.descriptor.bytes);
      assert.deepEqual(captureWindowsTaskRetirementCheckpoint(structuredClone(result)), result);
      assert.ok(Object.isFrozen(result) && Object.isFrozen(result.checkpoint)
        && Object.isFrozen(result.checkpoint.listener) && Object.isFrozen(result.checkpoint.creator)
        && Object.isFrozen(result.checkpoint.retiredOwner) && Object.isFrozen(result.intent.intent));
      assert.deepEqual(await prepareWindowsTaskRetirementCheckpoint(control, proof, admission), result);
      await proof.check();
      await check?.(result, proof, admission);
      return result;
    } finally { await proof.close(); }
  });
}
if (mode === 'hold') {
  await prepare(async (result, proof, admission) => {
    await new Promise((resolve, reject) => process.send(
      { result, proof: proof.identity, admission: admission.identity }, error => error ? reject(error) : resolve()));
    await delay(120000);
    throw new Error('Parent did not terminate original checkpoint controller.');
  });
} else {
  const child = fork(fileURLToPath(import.meta.url), [control, pwsh, 'hold'], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
  const deadline = AbortSignal.timeout(90000);
  const exited = once(child, 'exit', { signal: deadline });
  exited.catch(() => {});
  let ready;
  try {
    [ready] = await Promise.race([
      once(child, 'message', { signal: deadline }),
      exited.then(() => { throw new Error(`Checkpoint fixture exited before readiness: ${stderr}`); }),
    ]);
    for (const identity of [ready.proof, ready.admission]) {
      assert.equal(await processIdentity(identity.pid), identity.processIdentity);
    }
    await assert.rejects(acquireLock(control, { pwsh }), error => /acquire\/busy/.test(error.diagnostic ?? ''));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
  const until = Date.now() + 20000;
  for (const identity of [ready.proof, ready.admission]) {
    while (await processIdentity(identity.pid) === identity.processIdentity) {
      assert.ok(Date.now() < until, 'Original native checkpoint/admission survived its Node owner.');
      await delay(100);
    }
  }
  const original = ready.result;
  assert.deepEqual(await prepare(), original);
  const file = path.join(control, original.descriptor.path);
  const bytes = await readFile(file);
  const changed = mutate => {
    const value = structuredClone(original.checkpoint);
    mutate(value);
    return value;
  };
  const invalid = [
    changed(value => { value.unexpected = true; }),
    changed(value => { value.listener.processIdentity = 'invalid'; }),
    changed(value => { value.listener.createdAt = '9223372036854775808'; }),
    changed(value => { value.listener.address = '192.0.2.1'; }),
    changed(value => { value.enabled = 'true'; }),
    changed(value => { value.listener.pairedRecords = 'true'; }),
    changed(value => { value.intent.ino = String(BigInt(value.intent.ino) + 1n); }),
  ];
  for (const checkpoint of invalid) {
    assert.throws(() => captureWindowsTaskRetirementCheckpoint({ ...original, checkpoint }));
  }
  const liveCreator = changed(value => { value.creator.pid = process.pid; });
  liveCreator.creator.processIdentity = await processIdentity(process.pid);
  const nativeChanges = [
    changed(value => { value.definitionSha256 = '0'.repeat(64); }),
    changed(value => { value.listener.createdAt = String(BigInt(value.listener.createdAt) + 1n); }),
    invalid.at(-1), liveCreator,
  ];
  for (const text of nativeChanges.map(value => JSON.stringify(value)).concat(
    '{"version":1', bytes.toString().replace('"version":1', '"version":1,"version":1'),
  )) {
    try {
      await writeFile(file, text);
      await assert.rejects(prepare(), error =>
        error.code === 'DEPLOYMENT_WINDOWS_COMPLETION_PROOF_REFUSED'
        && /prepare-retirement-checkpoint/.test(error.diagnostic ?? ''));
      assert.equal(await readFile(file, 'utf8'), text, 'Refused checkpoint must not be rewritten.');
    } finally { await writeFile(file, bytes); }
  }
  assert.deepEqual(await prepare(), original);
  console.log('PASS: private native runtime checkpoint survives original actor loss and refuses altered policy, listener, intent and live creators without deleting evidence');
}
