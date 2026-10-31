import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as recovery from '../scripts/deployment/windows-cold-activation-recovery.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const [control, pwsh] = process.argv.slice(2);
assert.equal(typeof recovery.prepareWindowsColdTerminalRestore, 'function');
const state = await readFile(path.join(control, 'state.json'));
const lock = await readFile(path.join(control, 'lock/owner.json'));
const journal = path.join(control, 'recovery-lock');
const names = (await readdir(journal)).sort();
const intent = JSON.parse(await readFile(path.join(journal, 'activation-intent.json')));
const completed = JSON.parse(await readFile(path.join(journal, 'completion-complete.json')));
const pending = path.join(control, 'cold-restore-terminal.json.pending-fixture');
await writeFile(pending, 'incomplete fixture publication', { flag: 'wx' });
try {
  await assert.rejects(recovery.prepareWindowsColdTerminalRestore({ control, pwsh, acceptDataLoss: true }),
    { code: 'DEPLOYMENT_WINDOWS_COLD_ACTIVATION_OBSERVATION_REFUSED' });
} finally { await unlink(pending); }
const prepared = await recovery.prepareWindowsColdTerminalRestore({ control, pwsh, acceptDataLoss: true });
assert.equal(prepared.status, 'cold-terminal-prepared');
assert.equal(prepared.operationId, intent.operationId);
assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.record) && Object.isFrozen(prepared.record.runtime));
assert.equal(prepared.record.oldState, state.toString('utf8'));
assert.deepEqual(JSON.parse(prepared.record.nextState), {
  ...intent.state, phase: 'restored', previousPhase: 'restore-activating',
  updatedAt: JSON.parse(prepared.record.nextState).updatedAt,
});
assert.deepEqual(prepared.record.runtime, completed.runtime);
const file = path.join(control, 'cold-restore-terminal.json');
const bytes = await readFile(file);
assert.equal(createHash('sha256').update(bytes).digest('hex'), prepared.sha256);
const original = await lstat(file, { bigint: true });
assert.deepEqual(await recovery.prepareWindowsColdTerminalRestore({ control, pwsh, acceptDataLoss: true }), prepared);
const current = await lstat(file, { bigint: true });
assert.equal(current.dev, original.dev);
assert.equal(current.ino, original.ino);
assert.deepEqual(await readFile(file), bytes);
assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lock);
assert.deepEqual((await readdir(journal)).sort(), names);
assert.equal(await processIdentity(completed.runtime.pid), completed.runtime.identity);
console.log('PASS: cold terminal handoff binds proposed state and original released runtime without changing state, lock or journal');
