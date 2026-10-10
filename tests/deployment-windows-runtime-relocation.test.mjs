import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { restoreExternalSnapshot } from '../scripts/deployment/restore-external.mjs';
import { inspectWindowsSnapshotSecurity } from '../scripts/deployment/windows-snapshot-security.mjs';
import { windowsRestoredSecurityMatches } from '../scripts/deployment/windows-restore-security.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

for (const sharedParent of [false, true]) {
  test(`Windows external restore relocates only archived runtime members: sharedParent=${sharedParent}`, {
    skip: process.platform !== 'win32',
  }, async t => {
    const root = await temporaryDeployment(t);
    const project = path.join(root, 'app');
    const historical = path.join(root, 'historical-runtime');
    const directory = path.join(root, 'restored-runtime');
    for (const file of [project, historical, directory]) await mkdir(file);
    await writeFile(path.join(project, 'app.txt'), 'project remains\n');
    const helper = 'archived-helper.ps1';
    const bytes = Buffer.from('archived helper fixture\n');
    const configurationBytes = Buffer.from(JSON.stringify({
      version: 1, helpers: { [helper]: digest(bytes) },
      command: { file: process.execPath, args: [], cwd: project, environment: {} },
    }));
    const files = new Map([[helper, bytes], ['configuration.json', configurationBytes]]);
    for (const [name, data] of files) {
      await writeFile(path.join(historical, name), data);
      await writeFile(path.join(directory, name), data);
    }
    const externalFiles = [...files.keys()].map(name => ({ path: path.join(historical, name), optional: false }));
    const extra = path.join(historical, '.env.local');
    const absent = path.join(historical, 'absent.env');
    if (sharedParent) {
      await writeFile(extra, 'saved external configuration\n');
      externalFiles.push({ path: extra, optional: false }, { path: absent, optional: true });
    }
    const backup = path.join(root, 'backup');
    const snapshot = await createSnapshot({
      project, destination: backup, id: 'runtime-relocation', ...await inspectSnapshotScope({ project }), externalFiles,
      source: { commit: 'a'.repeat(40), provenance: 'observed' },
      runtime: { platform: 'win32', state: 'stopped', task: {
        version: 1, name: 'runtime-relocation-fixture', definition: '<Task/>',
        securityDescriptor: 'O:SYG:SYD:P(A;;FA;;;SY)',
        configuration: path.join(historical, 'configuration.json'), configurationSha256: digest(configurationBytes),
      } },
    });
    if (sharedParent) {
      await writeFile(extra, 'later external configuration\n');
      await writeFile(absent, 'later optional file\n');
      for (const name of files.keys()) await unlink(path.join(historical, name));
    } else {
      await rename(historical, path.join(root, 'retired-historical-runtime'));
    }
    const runtimeBundle = {
      directory, configuration: path.join(directory, 'configuration.json'), sha256: digest(configurationBytes),
    };
    const options = { project, backup, expectedSnapshot: snapshot, runtimeBundle,
      authorizedPaths: externalFiles.map(entry => entry.path), acceptDataLoss: true,
      checkStopped: async () => ({ stopped: true, inhibited: true }),
    };
    const identities = new Map(await Promise.all([...files.keys()].map(async name =>
      [name, await lstat(path.join(directory, name), { bigint: true })])));
    for (const change of [
      { authorizedPaths: options.authorizedPaths.slice(1) },
      { runtimeBundle: { ...runtimeBundle, sha256: '0'.repeat(64) } },
      { runtimeBundle: { ...runtimeBundle, directory: historical } },
      { runtimeBundle: { ...runtimeBundle, directory: project } },
      { checkStopped: async () => ({ stopped: false, inhibited: true }) },
    ]) await assert.rejects(restoreExternalSnapshot({ ...options, ...change }));
    const stale = path.join(directory, 'runtime-stale.json');
    await writeFile(stale, '{}\n');
    await assert.rejects(restoreExternalSnapshot(options));
    await unlink(stale);
    await writeFile(path.join(directory, helper), 'changed helper\n');
    await assert.rejects(restoreExternalSnapshot(options));
    await writeFile(path.join(directory, helper), bytes);
    if (sharedParent) assert.equal(await readFile(extra, 'utf8'), 'later external configuration\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await restoreExternalSnapshot(options), snapshot);
      for (const [name, data] of files) assert.deepEqual(await readFile(path.join(directory, name)), data);
      assert.deepEqual((await readdir(directory)).sort(), [...files.keys()].sort());
      const parent = snapshot.windowsExternalSecurity.parents.find(parent => parent.path === historical);
      const entries = parent.metadata.entries.filter(entry => files.has(entry.path))
        .map(entry => ({ path: entry.path, kind: 'file' }));
      const observed = await inspectWindowsSnapshotSecurity({ project: directory, destinationParent: backup, entries });
      try {
        const savedPolicies = new Map(parent.metadata.entries.map(entry =>
          [entry.path, { attributes: entry.attributes, policy: parent.metadata.descriptors[entry.security] }]));
        for (const entry of observed.metadata.entries) {
          assert.deepEqual({ attributes: entry.attributes, policy: observed.metadata.descriptors[entry.security] },
            savedPolicies.get(entry.path));
        }
        if (!sharedParent) assert.ok(windowsRestoredSecurityMatches(parent.metadata, observed.metadata, entries));
      } finally { await observed.close(); }
      if (sharedParent) {
        assert.equal(await readFile(extra, 'utf8'), 'saved external configuration\n');
        await assert.rejects(lstat(absent), { code: 'ENOENT' });
        for (const name of files.keys()) await assert.rejects(lstat(path.join(historical, name)), { code: 'ENOENT' });
      } else await assert.rejects(lstat(historical), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(project, 'app.txt'), 'utf8'), 'project remains\n');
      assert.deepEqual(await verifySnapshot(backup), snapshot);
    }
    for (const [name, original] of identities) {
      const current = await lstat(path.join(directory, name), { bigint: true });
      assert.equal(current.dev, original.dev);
      assert.equal(current.ino, original.ino);
    }
  });
}
