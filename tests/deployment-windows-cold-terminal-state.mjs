import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const [control, pwshArgument, target] = process.argv.slice(2);
const pwsh = realpathSync.native(pwshArgument);
assert.ok(['state-staged', 'state-published', 'complete'].includes(target));
assert.equal(process.env.PATH, undefined);
const snapshot = await verifySnapshot(path.join(control, 'backup'));
const saved = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
const recovery = await import(pathToFileURL(path.join(saved.directory, 'windows-cold-activation-recovery.mjs')));
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
const stateBytes = await readFile(statePath);
const stagedBefore = target === 'state-published'
  ? { bytes: await readFile(`${statePath}.lock`), info: await lstat(`${statePath}.lock`, { bigint: true }) } : null;
for (const changed of [
  { ...snapshot, id: `${snapshot.id}-foreign` },
  { ...snapshot, source: { ...snapshot.source, commit: 'f'.repeat(40) } },
  { ...snapshot, recoveryEngine: 'f'.repeat(64) },
  { ...snapshot, runtime: { ...snapshot.runtime, task: { ...snapshot.runtime.task, name: 'Foreign-State-Task' } } },
  { ...snapshot, entries: [] },
]) {
  await assert.rejects(recovery.publishWindowsColdTerminalState({
    control, pwsh, acceptDataLoss: true, expectedSnapshot: changed,
  }), /differs from the verified saved restore snapshot/);
  assert.deepEqual(await readFile(statePath), stateBytes);
  const current = await lstat(statePath, { bigint: true });
  for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(current[key], before[key]);
  assert.deepEqual(await readFile(terminalPath), terminalBytes);
  for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(control, name)), bytes);
  if (stagedBefore) {
    assert.deepEqual(await readFile(`${statePath}.lock`), stagedBefore.bytes);
    const info = await lstat(`${statePath}.lock`, { bigint: true });
    for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(info[key], stagedBefore.info[key]);
  } else {
    await assert.rejects(lstat(`${statePath}.lock`), { code: 'ENOENT' });
  }
}
const result = await recovery.publishWindowsColdTerminalState({
  control, pwsh, acceptDataLoss: true, expectedSnapshot: snapshot,
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
