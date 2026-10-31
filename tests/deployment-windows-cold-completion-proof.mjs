import assert from 'node:assert/strict';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as recovery from '../scripts/deployment/windows-cold-activation-recovery.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const [control, pwsh] = process.argv.slice(2);
assert.equal(typeof recovery.inspectWindowsColdRuntimeCompletion, 'function');
const directory = path.join(control, 'recovery-lock');
const stateBytes = await readFile(path.join(control, 'state.json'));
const lockBytes = await readFile(path.join(control, 'lock/owner.json'));
const names = (await readdir(directory)).sort();
const completedBytes = await readFile(path.join(directory, 'completion-complete.json'));
const completed = JSON.parse(completedBytes);
const proof = await recovery.inspectWindowsColdRuntimeCompletion({ control, pwsh });
try {
  assert.equal(proof.observation.status, 'cold-runtime-completed');
  assert.equal(proof.observation.mutationAuthority, false);
  assert.equal(proof.observation.lease, 'released');
  assert.deepEqual(proof.observation.runtime, completed.runtime);
  assert.equal(proof.observation.port, completed.port);
  assert.deepEqual(proof.observation.providers, completed.providers);
  assert.equal(proof.advance, undefined);
  assert.equal(proof.archive, undefined);
  assert.equal(proof.prepareTerminal, undefined);
  assert.ok(Object.isFrozen(proof.observation.runtime));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(proof.check({ signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await proof.check(), proof.observation);
  const foreign = path.join(directory, 'foreign-completion.json');
  await writeFile(foreign, '{}', { flag: 'wx' });
  try { await assert.rejects(proof.check(), /refused/); }
  finally { await unlink(foreign); }
} finally { await proof.close(); }
const reopened = await recovery.inspectWindowsColdRuntimeCompletion({ control, pwsh });
try { assert.deepEqual(await reopened.check(), reopened.observation); }
finally { await reopened.close(); }
await assert.rejects(reopened.check(), /closed/);
assert.equal(await processIdentity(completed.runtime.pid), completed.runtime.identity);
assert.notEqual(await processIdentity(completed.controllerPid), completed.controllerIdentity);
assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
assert.deepEqual(await readFile(path.join(directory, 'completion-complete.json')), completedBytes);
assert.deepEqual((await readdir(directory)).sort(), names);
console.log('PASS: independent cold completion observation retains the released runtime and exact journal without mutation authority');
