import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import streams, { writeFileSync } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertWindowsRestoredProjectBytes } from './deployment-windows-restore-evidence.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const proofPath = control => path.join(control, 'restore-crash-fixture.json');
const boundaryPath = control => path.join(control, 'restore-crash-boundary.json');
const laterFile = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

export async function prepareWindowsRestoreCrash({ scenario, project, control, backup, snapshot, lock, runtime, receipt }) {
  assert.ok(['crashed', 'copy-crashed'].includes(scenario));
  if (scenario === 'copy-crashed') {
    const files = snapshot.entries.filter(entry => entry.kind === 'file').map(entry => entry.path);
    assert.ok(files.indexOf('.env.local') >= 0 && files.indexOf(laterFile) > files.indexOf('.env.local'));
    assert.ok((await lstat(path.join(project, laterFile))).isFile());
  }
  const owner = await readFile(path.join(control, 'lock', 'owner.json'));
  assert.deepEqual(JSON.parse(owner), lock);
  await writeFile(proofPath(control), JSON.stringify({
    scenario, lock, runtime, lockSha256: digest(owner), receiptSha256: digest(receipt),
    manifestSha256: digest(await readFile(path.join(backup, 'manifest.json'))),
  }), { flag: 'wx', mode: 0o600 });
  const terminate = (phase, stage) => {
    assert.equal(phase, 'restoring');
    writeFileSync(boundaryPath(control), JSON.stringify({ phase, stage, pid: process.pid }), { flag: 'wx', mode: 0o600 });
    process.kill(process.pid, 'SIGKILL');
    throw new Error('Restore crash injection did not terminate its original actor.');
  };
  const original = streams.createWriteStream;
  let armed = false;
  return {
    onProgress({ phase, stage }) {
      if (scenario === 'crashed' && stage === 'external-files') terminate(phase, stage);
      if (scenario === 'copy-crashed' && stage === 'project-files') {
        assert.equal(armed, false);
        armed = true;
        streams.createWriteStream = (file, options) => {
          const stream = original(file, options);
          if (file === path.join(project, '.env.local')) {
            stream.once('finish', () => terminate(phase, 'project-file-copy'));
          }
          return stream;
        };
        syncBuiltinESMExports();
      }
    },
    close() {
      if (armed) {
        streams.createWriteStream = original;
        syncBuiltinESMExports();
      }
    },
  };
}

export async function verifyWindowsCrashedRestore({ project, control, backup, snapshot, recovery }) {
  const { captureLockOwner, loadState } = await import(pathToFileURL(path.join(recovery.directory, 'state.mjs')));
  const proof = JSON.parse(await readFile(proofPath(control), 'utf8'));
  assert.ok(['crashed', 'copy-crashed'].includes(proof.scenario));
  const lock = captureLockOwner(proof.lock);
  assert.equal(lock.project, project);
  assert.notEqual(lock.pid, process.pid, 'Crash verification must run in a distinct actor.');
  assert.deepEqual(JSON.parse(await readFile(boundaryPath(control), 'utf8')), {
    phase: 'restoring', stage: proof.scenario === 'crashed' ? 'external-files' : 'project-file-copy', pid: lock.pid,
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
  if (proof.scenario === 'crashed') {
    await assertWindowsRestoredProjectBytes(project, backup);
  } else {
    await assert.rejects(lstat(path.join(project, 'deployment-live-target.txt')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(project, '.env.local')),
      await readFile(path.join(backup, 'files', '.env.local')));
    await assert.rejects(lstat(path.join(project, laterFile)), { code: 'ENOENT' });
  }
  return { status: 'crash-verified', operationId: lock.operationId, runtime: proof.runtime };
}
