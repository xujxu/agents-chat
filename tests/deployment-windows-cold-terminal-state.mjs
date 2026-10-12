import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as recovery from '../scripts/deployment/windows-cold-activation-recovery.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const [control, pwsh, target] = process.argv.slice(2);
assert.ok(['state-staged', 'state-published', 'complete'].includes(target));
assert.equal(typeof recovery.publishWindowsColdTerminalState, 'function');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const terminalPath = path.join(control, 'cold-restore-terminal.json');
const terminalBytes = await readFile(terminalPath);
const terminal = JSON.parse(terminalBytes);
const journal = path.join(control, 'recovery-lock');
const names = (await readdir(journal)).sort();
const originals = new Map(await Promise.all([
  'lock/owner.json', 'task-maintenance/transaction.json', 'backup/manifest.json',
  ...names.map(name => `recovery-lock/${name}`),
].map(async name => [name, await readFile(path.join(control, name))])));
const statePath = path.join(control, 'state.json');
const before = await lstat(statePath, { bigint: true });
const result = await recovery.publishWindowsColdTerminalState({
  control, pwsh, acceptDataLoss: true,
  onProgress: async progress => {
    assert.ok(Object.isFrozen(progress) && Object.isFrozen(progress.identity));
    assert.equal(progress.operationId, terminal.operationId);
    if (progress.step !== target) return;
    assert.equal((await readFile(statePath)).toString('utf8'),
      target === 'state-staged' ? terminal.oldState : terminal.nextState);
    if (target === 'state-staged') {
      assert.equal((await readFile(`${statePath}.lock`)).toString('utf8'), terminal.nextState);
    } else {
      await assert.rejects(lstat(`${statePath}.lock`), { code: 'ENOENT' });
    }
    process.stdout.write(`${JSON.stringify({ progress })}\n`);
    await new Promise(() => {});
  },
});
assert.equal(target, 'complete', 'Interruption callback was skipped.');
assert.ok(Object.isFrozen(result));
assert.deepEqual(result, {
  status: 'cold-terminal-state-published', operationId: terminal.operationId,
  terminalSha256: digest(terminalBytes), stateSha256: digest(Buffer.from(terminal.nextState)),
});
assert.equal((await readFile(statePath)).toString('utf8'), terminal.nextState);
const after = await lstat(statePath, { bigint: true });
assert.equal(after.dev, before.dev);
assert.equal(after.ino, before.ino);
await assert.rejects(lstat(`${statePath}.lock`), { code: 'ENOENT' });
assert.deepEqual(await readFile(terminalPath), terminalBytes);
assert.deepEqual((await readdir(journal)).sort(), names);
for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(control, name)), bytes);
assert.equal(await processIdentity(terminal.runtime.pid), terminal.runtime.identity);
process.stdout.write(`${JSON.stringify({ result })}\n`);
