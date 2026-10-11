import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertWindowsRestoredProjectBytes } from './deployment-windows-restore-evidence.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const proofPath = control => path.join(control, 'restore-crash-fixture.json');
const boundaryPath = control => path.join(control, 'restore-crash-boundary.json');

export async function prepareWindowsRestoreCrash({ control, backup, lock, runtime, receipt }) {
  const owner = await readFile(path.join(control, 'lock', 'owner.json'));
  assert.deepEqual(JSON.parse(owner), lock);
  await writeFile(proofPath(control), JSON.stringify({
    lock, runtime, lockSha256: digest(owner), receiptSha256: digest(receipt),
    manifestSha256: digest(await readFile(path.join(backup, 'manifest.json'))),
  }), { flag: 'wx', mode: 0o600 });
  return ({ phase, stage }) => {
    assert.equal(phase, 'restoring');
    assert.equal(stage, 'external-files');
    writeFileSync(boundaryPath(control), JSON.stringify({ phase, stage, pid: process.pid }), { flag: 'wx', mode: 0o600 });
    process.kill(process.pid, 'SIGKILL');
    throw new Error('Restore crash injection did not terminate its original actor.');
  };
}

export async function verifyWindowsCrashedRestore({ project, control, backup, snapshot, recovery }) {
  const { captureLockOwner, loadState } = await import(pathToFileURL(path.join(recovery.directory, 'state.mjs')));
  const proof = JSON.parse(await readFile(proofPath(control), 'utf8'));
  const lock = captureLockOwner(proof.lock);
  assert.equal(lock.project, project);
  assert.notEqual(lock.pid, process.pid, 'Crash verification must run in a distinct actor.');
  assert.deepEqual(JSON.parse(await readFile(boundaryPath(control), 'utf8')), {
    phase: 'restoring', stage: 'external-files', pid: lock.pid,
  });
  assert.equal(digest(await readFile(path.join(control, 'lock', 'owner.json'))), proof.lockSha256);
  assert.equal(digest(await readFile(path.join(control, 'deployment.json'))), proof.receiptSha256);
  assert.equal(digest(await readFile(path.join(backup, 'manifest.json'))), proof.manifestSha256);
  const state = await loadState(control);
  assert.equal(state.operation, 'restore');
  assert.equal(state.phase, 'restoring');
  assert.equal(state.previousPhase, 'restore-preflight');
  assert.equal(state.errorCode, null);
  assert.equal(state.operationId, lock.operationId);
  assert.equal(state.backupId, snapshot.id);
  assert.equal(state.targetCommit, snapshot.source.commit);
  assert.equal(state.runtimeIdentity, proof.runtime.generation);
  await assertWindowsRestoredProjectBytes(project, backup);
  return { status: 'crash-verified', operationId: lock.operationId, runtime: proof.runtime };
}
