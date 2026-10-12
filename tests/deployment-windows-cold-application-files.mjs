import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertWindowsRestoredProjectBytes } from './deployment-windows-restore-evidence.mjs';

export async function verifyWindowsColdApplicationFiles({ directory, project, control, backup, snapshot, pwsh }) {
  const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)));
  const { claimWindowsColdRestore } = await captured('windows-cold-restore-lease.mjs');
  const { restoreWindowsColdFiles } = await captured('windows-cold-restore-files.mjs');
  const { verifySnapshot } = await captured('snapshot.mjs');
  const lock = await readFile(path.join(control, 'lock', 'owner.json'));
  const state = await readFile(path.join(control, 'state.json'));
  const receipt = await readFile(path.join(control, 'deployment.json'));
  const proof = JSON.parse(await readFile(path.join(control, 'restore-crash-fixture.json'), 'utf8'));
  assert.equal(proof.scenario, 'copy-crashed');
  assert.notEqual(proof.lock.pid, process.pid);
  await assert.rejects(lstat(path.join(project, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')),
    { code: 'ENOENT' });
  const bundles = (await readdir(control)).filter(name => name.startsWith('runtime-')).sort();
  const originals = await Promise.all(snapshot.externalFiles.map(async entry => {
    let identity;
    try { identity = await lstat(entry.path, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { file: entry.path, bytes: identity ? await readFile(entry.path) : null, identity };
  }));
  process.stderr.write(`${new Date().toISOString()} Actual cold file restoration: claiming original interrupted snapshot\n`);
  const lease = await claimWindowsColdRestore({
    control, project, backup, node: process.execPath, pwsh,
    profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
  });
  try {
    const restored = await restoreWindowsColdFiles({
      control, lease, acceptDataLoss: true,
      onProgress({ stage }) {
        process.stderr.write(`${new Date().toISOString()} Actual cold file restoration: ${stage}\n`);
      },
    });
    assert.equal(restored.status, 'files-restored');
    assert.equal(restored.runtimeBundle.directory, path.join(control, `runtime-${lease.owner.operationId}`));
    assert.deepEqual((await readdir(control)).filter(name => name.startsWith('runtime-')).sort(),
      [...bundles, `runtime-${lease.owner.operationId}`].sort());
    await assertWindowsRestoredProjectBytes(project, backup);
    assert.ok(snapshot.entries.some(entry => entry.path === '.data/chats.db' && entry.kind === 'file'));
    assert.deepEqual(await readFile(path.join(project, '.data/chats.db')),
      await readFile(path.join(backup, 'files/.data/chats.db')));
    for (const original of originals) {
      if (!original.identity) {
        await assert.rejects(lstat(original.file), { code: 'ENOENT' });
        continue;
      }
      assert.deepEqual(await readFile(original.file), original.bytes);
      const current = await lstat(original.file, { bigint: true });
      assert.equal(current.dev, original.identity.dev);
      assert.equal(current.ino, original.identity.ino);
    }
    assert.deepEqual(await verifySnapshot(backup), snapshot);
    assert.deepEqual(await readFile(path.join(control, 'lock', 'owner.json')), lock);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
    await lease.checkStopped();
    return { status: 'files-restored', operationId: lease.owner.operationId, runtime: proof.runtime };
  } finally { await lease.close(); }
}
