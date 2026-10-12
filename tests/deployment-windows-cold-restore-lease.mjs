import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const implementation = new URL('../scripts/deployment/windows-cold-restore-lease.mjs', import.meta.url);
async function options(control, pwsh) {
  const state = JSON.parse(await readFile(path.join(control, 'state.json'), 'utf8'));
  return { control, project: state.project, backup: path.join(control, 'backup'), node: process.execPath,
    pwsh, profile: 'agents-chat-auth-638c553', acceptDataLoss: true };
}
if (process.argv[2] === 'hold-cold-lease') {
  const [control, pwsh] = process.argv.slice(3);
  const { claimWindowsColdRestore } = await import(implementation);
  const lease = await claimWindowsColdRestore(await options(control, pwsh));
  try {
    await lease.check();
    await new Promise((resolve, reject) => process.send({
      pid: process.pid, owner: lease.owner, native: lease.identity, admission: lease.admissionIdentity,
    }, error => error ? reject(error) : resolve()));
    await delay(180000);
    throw new Error('Parent did not terminate the original cold restore lease owner.');
  } finally { await lease.close(); }
}

export async function verifyWindowsColdRestoreLease({ control, pwsh }) {
  const { claimWindowsColdRestore, assertWindowsColdRestoreLease } = await import(implementation);
  const supplied = await options(control, pwsh);
  const lockFile = path.join(control, 'lock', 'owner.json');
  const stateFile = path.join(control, 'state.json');
  const originalLock = await readFile(lockFile);
  const originalState = await readFile(stateFile);
  await assert.rejects(claimWindowsColdRestore({ ...supplied, acceptDataLoss: false }));
  let predecessor;
  for (let round = 0; round < 2; round++) {
    const child = fork(fileURLToPath(import.meta.url), ['hold-cold-lease', control, pwsh],
      { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const signal = AbortSignal.timeout(240000);
    const exited = once(child, 'exit', { signal });
    let diagnostic = '';
    let held;
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(-8192); });
    try {
      [held] = await Promise.race([
        once(child, 'message', { signal }),
        exited.then(() => { throw new Error(`Cold lease actor exited before retention: ${diagnostic}`); }),
      ]);
      assert.equal(held.pid, child.pid);
      const bytes = await readFile(path.join(control, 'recovery-lock', 'owner.json'));
      const record = JSON.parse(bytes);
      assert.deepEqual(record.owner, held.owner);
      assert.notEqual(record.owner.operationId, JSON.parse(originalLock).operationId);
      if (predecessor) assert.notDeepEqual(record.owner, predecessor.owner);
      await assert.rejects(claimWindowsColdRestore(supplied));
      assert.deepEqual(await readFile(path.join(control, 'recovery-lock', 'owner.json')), bytes);
      predecessor = record;
      assert.equal(child.kill(), true);
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      if (held) {
        for (const identity of [held.native, held.admission]) {
          const deadline = Date.now() + 30000;
          while (await processIdentity(identity.pid) === identity.processIdentity) {
            assert.ok(Date.now() < deadline, 'Original cold lease helper did not settle after actor loss');
            await delay(100);
          }
        }
      }
    }
    assert.deepEqual(await readFile(lockFile), originalLock);
    assert.deepEqual(await readFile(stateFile), originalState);
  }
  const lease = await claimWindowsColdRestore(supplied);
  try {
    await assertWindowsColdRestoreLease(control, lease);
    await assert.rejects(assertWindowsColdRestoreLease(control, { ...lease }));
    await assert.rejects(assertWindowsColdRestoreLease(`${control}-foreign`, lease));
    assert.notDeepEqual(lease.owner, predecessor.owner);
    assert.deepEqual(lease.lock, JSON.parse(originalLock));
    assert.deepEqual(lease.state, JSON.parse(originalState));
    assert.equal(lease.snapshot.id, lease.state.backupId);
    await assert.rejects(claimWindowsColdRestore(supplied));
    await lease.check();
  } finally { await lease.close(); }
  await assert.rejects(lease.check());
  await assert.rejects(claimWindowsColdRestore(supplied), /alive/);
  assert.deepEqual(await readFile(lockFile), originalLock);
  assert.deepEqual(await readFile(stateFile), originalState);
  console.log('PASS: cold restore claims distinct durable ownership, refuses overlap and survives two recovery-controller deaths without replacing original lock/state');
}
