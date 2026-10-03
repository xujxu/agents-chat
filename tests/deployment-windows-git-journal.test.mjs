import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs, { chmod, lstat, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { git, gitMetadataFixture, gitWindowsSecurity } from './deployment-git-fixture.mjs';
import { inspectGitMetadata } from '../scripts/deployment/git-metadata.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { restoreGitMetadata } from '../scripts/deployment/restore-git.mjs';
import { windowsGitMetadataInventory } from '../scripts/deployment/windows-git-snapshot-security.mjs';
import { inspectWindowsSnapshotSecurity } from '../scripts/deployment/windows-snapshot-security.mjs';
import { windowsRestoredSecurityMatches } from '../scripts/deployment/windows-restore-security.mjs';

for (const layout of ['attached', 'packed', 'detached', 'packed-parents-absent']) {
  test(`Windows Git journal restores ${layout} metadata with private preparation and saved security`, {
    skip: process.platform !== 'win32',
  }, async t => {
    const f = await gitMetadataFixture(t, { broad: true });
    const directory = path.join(f.project, '.git');
    const index = path.join(directory, 'index');
    if (layout.startsWith('packed')) await git(f.project, 'pack-refs', '--all');
    if (layout === 'packed-parents-absent') {
      for (const relative of ['refs/heads', 'refs/tags']) {
        try { await rmdir(path.join(directory, relative)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }

      for (const pause of ['refs/heads/main', 'index', 'HEAD']) {
        test(`Windows native Git journal resumes after controller death following ${pause}`, {
          skip: process.platform !== 'win32',
        }, async t => {
          const f = await gitMetadataFixture(t, { broad: true });
          const index = path.join(f.project, '.git/index');
          await chmod(index, 0o400);
          const backup = path.join(f.root, 'backup');
          const manifest = await createSnapshot({
            project: f.project, destination: backup, id: 'native-git-resume',
            gitMetadata: await inspectGitMetadata(f), ...await inspectSnapshotScope({ project: f.project }),
            source: { commit: f.commit, provenance: 'observed' },
            runtime: { platform: process.platform, state: 'stopped' },
          });
          const saved = path.join(backup, 'git.json');
          const record = JSON.parse(await readFile(saved, 'utf8'));
          await chmod(index, 0o600);
          await writeFile(path.join(f.project, 'app.txt'), 'later\n');
          await git(f.project, 'commit', '-am', 'later');
          const child = fork(new URL('./deployment-git-restore-child.mjs', import.meta.url),
            [f.project, saved, pause, backup], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
          let diagnostic = '';
          child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
          const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
          t.after(async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await exited;
          });
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Native Git restore did not pause: ${diagnostic}`)), 60000);
            child.once('message', value => { clearTimeout(timer); resolve(value); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native Git restore exited ${code}: ${diagnostic}`)); });
            child.once('error', error => { clearTimeout(timer); reject(error); });
          });
          const options = { project: f.project, backup, record, checkStopped: async () => ({ stopped: true, inhibited: true }) };
          const proofFile = path.join(f.project, '.git/agents-chat-restore/intent.json');
          const proofBytes = await readFile(proofFile);
          const proof = JSON.parse(proofBytes);
          assert.equal(proof.version, 2);
          for (const [position, entry] of proof.entries.entries()) {
            const published = position <= proof.entries.findIndex(entry => entry.file === pause);
            const file = path.join(f.project, '.git', `${entry.file}${published ? '' : '.lock'}`);
            const info = await lstat(file, { bigint: true });
            assert.equal(entry.staged.dev, String(info.dev));
            assert.equal(entry.staged.ino, String(info.ino));
            assert.deepEqual(entry.staged.windowsSecurity, await gitWindowsSecurity(file));
          }
          await assert.rejects(restoreGitMetadata(options), /alive/i);
          child.kill('SIGKILL');
          await exited;
          if (pause === 'index') {
            const bytes = await readFile(index);
            await rename(index, `${index}.retained`);
            await writeFile(index, bytes);
            await assert.rejects(restoreGitMetadata(options), /changed|identity/i);
            assert.deepEqual(await readFile(proofFile), proofBytes);
            await unlink(index);
            await rename(`${index}.retained`, index);
            const originalPolicy = await gitWindowsSecurity(index);
            await gitWindowsSecurity(index, 'broaden-git-index-users');
            assert.notDeepEqual(await gitWindowsSecurity(index), originalPolicy);
            await assert.rejects(restoreGitMetadata(options), /changed|identity/i);
            assert.deepEqual(await readFile(proofFile), proofBytes);
            assert.deepEqual(await readFile(index), bytes);
            await gitWindowsSecurity(index, 'unbroaden-git-index-users');
            assert.deepEqual(await gitWindowsSecurity(index), originalPolicy);
          }
          await restoreGitMetadata(options);
          assert.equal(await git(f.project, 'rev-parse', 'HEAD'), f.commit);
          assert.deepEqual(await readFile(index), Buffer.from(record.index, 'base64'));
          assert.equal(await readFile(path.join(f.project, 'app.txt'), 'utf8'), 'later\n');
          await assert.rejects(lstat(path.join(f.project, '.git/agents-chat-restore')), { code: 'ENOENT' });
          assert.deepEqual(await verifySnapshot(backup), manifest);
        });
      }
    }
    if (layout === 'detached') await git(f.project, 'switch', '--detach', f.commit);
    await gitWindowsSecurity(index, 'broaden-git-index');
    await chmod(index, 0o400);
    const gitMetadata = await inspectGitMetadata(f);
    const backup = path.join(f.root, 'backup');
    const manifest = await createSnapshot({
      project: f.project, destination: backup, id: 'native-git-journal', gitMetadata,
      ...await inspectSnapshotScope({ project: f.project }),
      source: { commit: f.commit, provenance: 'observed' },
      runtime: { platform: process.platform, state: 'stopped' },
    });
    const record = JSON.parse(await readFile(path.join(backup, 'git.json'), 'utf8'));
    assert.equal(record.version, 2);
    if (layout === 'packed-parents-absent') {
      assert.deepEqual(record.absentPaths, ['refs/heads', 'refs/heads/main']);
    }
    await chmod(index, 0o600);
    if (layout.startsWith('packed')) await git(f.project, 'switch', '--detach', f.commit);
    await writeFile(path.join(f.project, 'app.txt'), 'updated\n');
    await git(f.project, 'commit', '-am', 'updated');
    const newer = await git(f.project, 'rev-parse', 'HEAD');
    if (layout === 'packed') {
      await git(f.project, 'tag', 'newer-retained', newer);
      await git(f.project, 'pack-refs', '--all');
    }
    const config = await readFile(path.join(directory, 'config'));
    const packed = layout.startsWith('packed') ? await readFile(path.join(directory, 'packed-refs')) : null;
    let privateCopies = 0;
    let privateProof = false;
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (String(file).startsWith(`${directory}${path.sep}`) && String(file).endsWith('.lock')) {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (...values) => {
          const security = await gitWindowsSecurity(file);
          assert.doesNotMatch(security.securityDescriptor, /;;;WD\)/);
          privateCopies++;
          return write(...values);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await restoreGitMetadata({
          project: f.project, backup, record,
          checkStopped: async () => {
            const guard = path.join(directory, 'agents-chat-restore');
            const proof = path.join(guard, 'intent.json');
            if (!privateProof) {
              let info;
              try { info = await lstat(proof); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
              if (info) {
                const intent = JSON.parse(await readFile(proof, 'utf8'));
                assert.equal(intent.version, 2);
                for (const file of [guard, proof]) {
                  assert.doesNotMatch((await gitWindowsSecurity(file)).securityDescriptor, /;;;WD\)/);
                }
                privateProof = true;
              }
            }
            return { stopped: true, inhibited: true };
          },
        });
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.ok(privateProof);
    assert.ok(privateCopies >= (record.ref === null ? 4 : 6));
    assert.equal(await git(f.project, 'rev-parse', 'HEAD'), f.commit);
    assert.deepEqual(await readFile(index), Buffer.from(record.index, 'base64'));
    assert.deepEqual(await readFile(path.join(directory, 'HEAD')), Buffer.from(record.head, 'base64'));
    assert.equal(await readFile(path.join(f.project, 'app.txt'), 'utf8'), 'updated\n');
    assert.deepEqual(await readFile(path.join(directory, 'config')), config);
    if (packed) assert.deepEqual(await readFile(path.join(directory, 'packed-refs')), packed);
    if (layout === 'packed') assert.equal(await git(f.project, 'rev-parse', 'newer-retained'), newer);
    await git(f.project, 'cat-file', '-e', `${newer}^{commit}`);
    await git(f.project, 'fsck', '--no-dangling');
    const entries = windowsGitMetadataInventory(record.ref).filter(entry => !record.absentPaths.includes(entry.path));
    const observed = await inspectWindowsSnapshotSecurity({ project: directory, destinationParent: backup, entries });
    try { assert.ok(windowsRestoredSecurityMatches(record.windowsSecurity, observed.metadata, entries)); }
    finally { await observed.close(); }
    await assert.rejects(lstat(path.join(directory, 'agents-chat-restore')), { code: 'ENOENT' });
    assert.deepEqual(await verifySnapshot(backup), manifest);
  });
}
