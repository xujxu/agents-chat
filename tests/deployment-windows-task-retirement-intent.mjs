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
import { captureWindowsTaskRetirement } from '../scripts/deployment/windows-task-retirement-record.mjs';
import {
  openWindowsTaskCompletionProof, prepareWindowsTaskRetirement,
} from '../scripts/deployment/windows-task-completion-proof.mjs';

const [control, pwsh, mode] = process.argv.slice(2);
async function prepare(check) {
  return withWindowsAdmission(control, { pwsh }, async admission => {
    const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
    try {
      await assert.rejects(prepareWindowsTaskRetirement(control, { ...proof }, admission),
        /Original retained completed-task proof/);
      await assert.rejects(prepareWindowsTaskRetirement(`${control}-foreign`, proof, admission),
        /Original retained completed-task proof/);
      await assert.rejects(prepareWindowsTaskRetirement(control, proof, { ...admission }),
        /Original retained completed-task proof/);
      const prepared = await prepareWindowsTaskRetirement(control, proof, admission);
      assert.equal(prepared.status, 'prepared');
      assert.equal(prepared.descriptor.path, 'task-retirement.json');
      assert.deepEqual(prepared.intent.completion, proof.observation);
      const bytes = await readFile(path.join(control, prepared.descriptor.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), prepared.descriptor.sha256);
      assert.deepEqual(JSON.parse(bytes), prepared.intent);
      for (const entry of [prepared.descriptor, prepared.intent.lockFile, prepared.intent.state, ...prepared.intent.files]) {
        const info = await stat(path.join(control, entry.path), { bigint: true });
        assert.equal(String(info.dev), entry.dev);
        assert.equal(String(info.ino), entry.ino);
        assert.equal(Number(info.size), entry.bytes);
      }
      for (const [name, identity] of [
        ['', prepared.intent.controlIdentity], ['lock', prepared.intent.lockIdentity],
        ['task-maintenance', prepared.intent.maintenanceIdentity],
      ]) {
        const info = await stat(path.join(control, name), { bigint: true });
        assert.equal(String(info.dev), identity.dev);
        assert.equal(String(info.ino), identity.ino);
      }
      assert.deepEqual(captureWindowsTaskRetirement(structuredClone(prepared)), prepared);
      assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.intent)
        && Object.isFrozen(prepared.intent.files) && prepared.intent.files.every(Object.isFrozen)
        && Object.isFrozen(prepared.intent.creator) && Object.isFrozen(prepared.intent.lock));
      assert.deepEqual(await prepareWindowsTaskRetirement(control, proof, admission), prepared);
      await proof.check();
      await check?.(prepared, proof, admission);
      return prepared;
    } finally { await proof.close(); }
  });
}

if (mode === 'hold') {
  await prepare(async (prepared, proof, admission) => {
    await new Promise((resolve, reject) => process.send(
      { prepared, proof: proof.identity, admission: admission.identity }, error => error ? reject(error) : resolve()));
    await delay(120000);
    throw new Error('Parent did not terminate original retirement-intent controller.');
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
      exited.then(() => { throw new Error(`Retirement fixture exited before readiness: ${stderr}`); }),
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
      assert.ok(Date.now() < until, 'Original native retirement/admission controller survived its Node owner.');
      await delay(100);
    }
  }
  assert.deepEqual(await prepare(), ready.prepared);
  const original = ready.prepared;
  const marker = path.join(control, original.descriptor.path);
  const bytes = await readFile(marker);
  const changed = mutate => {
    const value = structuredClone(original.intent);
    mutate(value);
    return value;
  };
  const invalid = [
    changed(value => { value.project += '-foreign'; }),
    changed(value => { value.files[0].path = 'state.json'; }),
    changed(value => { value.completion.mutationAuthority = true; }),
    changed(value => { value.files.pop(); }),
    changed(value => { value.creator.unexpected = true; }),
  ];
  for (const intent of invalid) {
    assert.throws(() => captureWindowsTaskRetirement({ ...original, intent }));
  }
  const liveCreator = changed(value => { value.creator.pid = process.pid; });
  liveCreator.creator.processIdentity = await processIdentity(process.pid);
  const changedIdentity = changed(value => { value.files[0].ino = String(BigInt(value.files[0].ino) + 1n); });
  for (const text of [...invalid, liveCreator, changedIdentity].map(value => JSON.stringify(value)).concat(
    '{"version":1', bytes.toString().replace('"version":1', '"version":1,"version":1'),
  )) {
    try {
      await writeFile(marker, text);
      await assert.rejects(prepare(), error =>
        error.code === 'DEPLOYMENT_WINDOWS_COMPLETION_PROOF_REFUSED'
        && /prepare-retirement/.test(error.diagnostic ?? ''));
      assert.equal(await readFile(marker, 'utf8'), text, 'Refused intent must not be rewritten.');
    } finally { await writeFile(marker, bytes); }
  }
  assert.deepEqual(await prepare(), original);
  console.log('PASS: native task retirement intent binds original private evidence, survives original actor loss, and refuses changed/live-creator intent without deletion or unlock');
}
