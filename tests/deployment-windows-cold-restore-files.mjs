import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import streams, { writeFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';

const [control, pwsh, mode] = process.argv.slice(2);
const { restoreWindowsColdFiles } = await import('../scripts/deployment/windows-cold-restore-files.mjs');
const stateBytes = await readFile(path.join(control, 'state.json'));
const lockBytes = await readFile(path.join(control, 'lock', 'owner.json'));
const state = JSON.parse(stateBytes);
const backup = path.join(control, 'backup');
const snapshot = await verifySnapshot(backup);
const options = { control, project: state.project, backup, node: process.execPath, pwsh,
  profile: 'agents-chat-auth-638c553', acceptDataLoss: true };
const boundary = path.join(control, 'cold-files-fixture-boundary.json');

if (mode === 'crash-copy') {
  const lease = await claimWindowsColdRestore(options);
  const original = streams.createWriteStream;
  let armed = false;
  try {
    await new Promise((resolve, reject) => process.send({
      pid: process.pid, native: lease.identity, admission: lease.admissionIdentity,
    }, error => error ? reject(error) : resolve()));
    await restoreWindowsColdFiles({
      control, lease, acceptDataLoss: true,
      onProgress({ stage }) {
        if (stage !== 'project-files') return;
        assert.equal(armed, false);
        armed = true;
        streams.createWriteStream = (file, writeOptions) => {
          const output = original(file, writeOptions);
          if (file === path.join(state.project, '.env.local')) {
            output.once('finish', () => {
              writeFileSync(boundary, JSON.stringify({ pid: process.pid, stage: 'project-file-copy' }),
                { flag: 'wx', mode: 0o600 });
              process.kill(process.pid, 'SIGKILL');
              throw new Error('Cold restore copy crash did not terminate the original actor.');
            });
          }
          return output;
        };
        syncBuiltinESMExports();
      },
    });
    throw new Error('Cold restoration did not reach its real copy interruption.');
  } finally {
    streams.createWriteStream = original;
    syncBuiltinESMExports();
    await lease.close();
  }
} else {
  assert.equal(mode, undefined);
  const files = snapshot.entries.filter(entry => entry.kind === 'file').map(entry => entry.path);
  assert.ok(files.indexOf('.env.local') >= 0 && files.indexOf('writer.cjs') > files.indexOf('.env.local'));
  const external = await Promise.all(snapshot.externalFiles.map(async entry => ({
    path: entry.path, bytes: await readFile(entry.path), identity: await lstat(entry.path, { bigint: true }),
  })));
  const child = fork(fileURLToPath(import.meta.url), [control, pwsh, 'crash-copy'],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const signal = AbortSignal.timeout(360000);
  const exited = once(child, 'exit', { signal });
  let held;
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(-8192); });
  try {
    [held] = await Promise.race([
      once(child, 'message', { signal }),
      exited.then(() => { throw new Error(`Cold copy actor exited before ownership: ${diagnostic}`); }),
    ]);
    assert.equal(held.pid, child.pid);
    await exited;
    assert.deepEqual(JSON.parse(await readFile(boundary, 'utf8')), { pid: child.pid, stage: 'project-file-copy' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    if (held) {
      for (const identity of [held.native, held.admission]) {
        const deadline = Date.now() + 30000;
        while (await processIdentity(identity.pid) === identity.processIdentity) {
          assert.ok(Date.now() < deadline, 'Original cold copy authority survived its controller');
          await delay(100);
        }
      }
    }
  }
  assert.deepEqual(await readFile(path.join(state.project, '.env.local')),
    await readFile(path.join(backup, 'files', '.env.local')));
  await assert.rejects(lstat(path.join(state.project, 'writer.cjs')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(control, 'lock', 'owner.json')), lockBytes);
  const lease = await claimWindowsColdRestore(options);
  try {
    await assert.rejects(restoreWindowsColdFiles({ control, lease: { ...lease }, acceptDataLoss: true }));
    await assert.rejects(restoreWindowsColdFiles({ control, lease, acceptDataLoss: false }));
    await assert.rejects(restoreWindowsColdFiles({ control, lease, acceptDataLoss: true, timeoutSeconds: 0 }));
    await assert.rejects(restoreWindowsColdFiles({ control, lease, acceptDataLoss: true, onProgress: true }));
    await assert.rejects(restoreWindowsColdFiles({ control, lease, acceptDataLoss: true, signal: AbortSignal.abort() }));
    const restored = await restoreWindowsColdFiles({ control, lease, acceptDataLoss: true });
    assert.equal(restored.status, 'files-restored');
    assert.equal(restored.runtimeBundle.directory, path.join(control, `runtime-${lease.owner.operationId}`));
    assert.equal(restored.runtimeBundle.sha256, snapshot.runtime.task.configurationSha256);
    assert.deepEqual(await lease.checkStopped(), {
      stopped: true, inhibited: true, operationId: lease.owner.operationId,
    });
    for (const file of files) {
      assert.deepEqual(await readFile(path.join(state.project, file)), await readFile(path.join(backup, 'files', file)));
    }
    for (const original of external) {
      assert.deepEqual(await readFile(original.path), original.bytes);
      const identity = await lstat(original.path, { bigint: true });
      assert.equal(identity.dev, original.identity.dev);
      assert.equal(identity.ino, original.identity.ino);
    }
    assert.deepEqual(await verifySnapshot(backup), snapshot);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
    assert.deepEqual(await readFile(path.join(control, 'lock', 'owner.json')), lockBytes);
  } finally { await lease.close(); }
  await assert.rejects(lease.checkStopped(), /closed/);
  console.log('PASS: cold file restoration retries an actual partial copy with a fresh archived runtime bundle and unchanged original evidence');
}
