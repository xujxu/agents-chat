import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { restoreProjectSnapshot } from '../scripts/deployment/restore-project.mjs';
import { validateWindowsSnapshotSecurity } from '../scripts/deployment/windows-snapshot-security.mjs';

for (const missingTarget of [false, true]) {
  test(`Windows directory-link snapshot restores complete project with missing dependency target=${missingTarget}`,
    { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
      const root = await temporaryDeployment(t);
      const project = path.join(root, 'app');
      const target = path.join(project, 'node_modules/dependency');
      const output = path.join(project, '.next/node_modules');
      await mkdir(target, { recursive: true });
      await mkdir(output, { recursive: true });
      await mkdir(path.join(project, '.data'));
      await writeFile(path.join(target, 'payload'), 'original module bytes');
      await writeFile(path.join(project, '.data/state'), 'original data');
      const link = path.join(output, 'dependency');
      await symlink(target, link, 'junction');
      const symbolicLinks = [path.join(output, 'dependency-absolute'), path.join(output, 'dependency-relative')];
      await symlink(target, symbolicLinks[0], 'dir');
      await symlink('../../node_modules/dependency', symbolicLinks[1], 'dir');
      const backup = path.join(root, 'backup');
      const manifest = await createSnapshot({
        project, destination: backup, id: 'junction-project',
        ...await inspectSnapshotScope({ project }),
        source: { commit: 'a'.repeat(40), provenance: 'observed' },
        runtime: { platform: 'win32', state: 'stopped' },
      });
      assert.equal(manifest.version, 3);
      assert.equal(manifest.windowsSecurity.version, 2);
      assert.equal(manifest.windowsSecurity.project, project);
      assert.equal(manifest.windowsSecurity.junctions.length, 1);
      assert.equal(manifest.windowsSecurity.symlinks.length, 2);
      assert.equal(manifest.windowsSecurity.junctions[0].path, '.next/node_modules/dependency');
      assert.equal(manifest.entries.find(entry => entry.kind === 'link').target, '../../node_modules/dependency');
      await assert.rejects(lstat(path.join(backup, 'files/.next/node_modules/dependency')), { code: 'ENOENT' });
      for (const file of symbolicLinks) {
        await assert.rejects(lstat(path.join(backup, 'files', path.relative(project, file))), { code: 'ENOENT' });
      }
      assert.deepEqual(await verifySnapshot(backup), manifest);
      const invalid = structuredClone(manifest.windowsSecurity);
      const bytes = Buffer.from(invalid.junctions[0].data, 'base64');
      bytes.writeUInt32LE(0xa000000c, 0);
      invalid.junctions[0].data = bytes.toString('base64');
      assert.throws(() => validateWindowsSnapshotSecurity(invalid, manifest.entries, project), /junction|reparse/i);
      assert.throws(() => validateWindowsSnapshotSecurity(manifest.windowsSecurity, manifest.entries,
        path.join(root, 'other')), /project|junction/i);
      for (const mutate of [
        record => { record.junctions = []; },
        record => { record.junctions[0].data += '\n'; },
        record => { record.junctions[0].path = 'node_modules/dependency'; },
        record => { record.entries.find(entry => entry.path === '.next/node_modules/dependency').attributes = 16; },
      ]) {
        const changed = structuredClone(manifest.windowsSecurity);
        mutate(changed);
        assert.throws(() => validateWindowsSnapshotSecurity(changed, manifest.entries, project));
      }
      const changedTarget = structuredClone(manifest.entries);
      changedTarget.find(entry => entry.kind === 'link').target = '../../node_modules/other';
      assert.throws(() => validateWindowsSnapshotSecurity(manifest.windowsSecurity, changedTarget, project), /target/i);
      const virtualPayload = path.join(backup, 'files/.next/node_modules/dependency');
      await writeFile(virtualPayload, 'not an archived junction');
      await assert.rejects(verifySnapshot(backup), /inventory|junction/i);
      await rm(virtualPayload);
      await writeFile(path.join(project, '.data/state'), 'changed data');
      if (missingTarget) await rm(target, { recursive: true });
      else await writeFile(path.join(target, 'payload'), 'changed module');
      await restoreProjectSnapshot({
        project, backup, expectedSnapshot: manifest, acceptDataLoss: true,
        checkStopped: async () => ({ stopped: true, inhibited: true }),
      });
      assert.equal((await lstat(link)).isSymbolicLink(), true);
      assert.equal(await realpath(link), await realpath(target));
      assert.equal(await readFile(path.join(link, 'payload'), 'utf8'), 'original module bytes');
      for (const file of symbolicLinks) {
        assert.equal((await lstat(file)).isSymbolicLink(), true);
        assert.equal(await realpath(file), await realpath(target));
        assert.equal(await readFile(path.join(file, 'payload'), 'utf8'), 'original module bytes');
      }
      assert.equal(await readFile(path.join(project, '.data/state'), 'utf8'), 'original data');
      assert.deepEqual(await verifySnapshot(backup), manifest);
    });
}
