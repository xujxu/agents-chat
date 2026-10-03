import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { gitWindowsSecurity as windowsFileSecurity } from './deployment-git-fixture.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { validateExternalSnapshot } from '../scripts/deployment/snapshot-external.mjs';
import { validateWindowsSnapshotSecurity } from '../scripts/deployment/windows-snapshot-security.mjs';

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const directory = path.join(root, 'system');
  await mkdir(project);
  await mkdir(directory);
  await writeFile(path.join(project, 'package.json'), '{}');
  const file = path.join(directory, '.env.local');
  await writeFile(file, 'SECRET=snapshot-fixture-only\n');
  const missing = path.join(directory, 'absent.env');
  return { root, project, directory, file, missing, options: {
    project, destination: path.join(root, 'staging'), id: 'windows-external', files: ['package.json'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  } };
}

for (const layout of ['mixed', 'multiple-parents', 'all-absent']) {
  test(`Windows external snapshot captures native file and parent security: ${layout}`, {
    skip: process.platform !== 'win32',
  }, async t => {
    const f = await fixture(t);
    await chmod(f.file, 0o400);
    const files = layout === 'all-absent' ? [] : [{ path: f.file, optional: false }];
    files.push({ path: f.missing, optional: true });
    if (layout === 'multiple-parents') {
      const directory = path.join(f.root, 'another-parent');
      await mkdir(directory);
      const file = path.join(directory, 'configuration.json');
      await writeFile(file, '{}');
      files.push({ path: file, optional: false });
    }
    const manifest = await createSnapshot({ ...f.options, externalFiles: files });
    assert.equal(manifest.version, 3);
    assert.equal(manifest.windowsExternalSecurity.version, 1);
    const parents = [...new Set(files.map(file => path.dirname(file.path)))];
    assert.deepEqual(manifest.windowsExternalSecurity.parents.map(entry => entry.path), parents);
    for (const parent of manifest.windowsExternalSecurity.parents) {
      const inventory = manifest.externalFiles.filter(entry =>
        path.dirname(entry.path) === parent.path && entry.kind === 'file')
        .map(entry => ({ path: path.basename(entry.path), kind: 'file' }));
      const metadata = validateWindowsSnapshotSecurity(parent.metadata, inventory);
      const policy = entry => ({
        securityDescriptor: metadata.descriptors[entry.security], attributes: entry.attributes,
      });
      assert.deepEqual(policy(metadata.root), await windowsFileSecurity(parent.path));
      for (const entry of metadata.entries) {
        assert.deepEqual(policy(entry), await windowsFileSecurity(path.join(parent.path, entry.path)));
      }
    }
    for (const [index, entry] of manifest.externalFiles.entries()) {
      const payload = path.join(f.options.destination, 'external', String(index));
      if (entry.kind === 'absent') await assert.rejects(lstat(payload), { code: 'ENOENT' });
      else {
        assert.deepEqual(await readFile(payload), await readFile(entry.path));
        assert.doesNotMatch((await windowsFileSecurity(payload)).securityDescriptor, /;;;WD\)/);
      }
    }
    assert.doesNotMatch(JSON.stringify(manifest), /snapshot-fixture-only/);
    assert.throws(() => validateExternalSnapshot(manifest.externalFiles, f.project), /Windows|native|security/i);
    for (const parents of [[], [...manifest.windowsExternalSecurity.parents, manifest.windowsExternalSecurity.parents[0]]]) {
      assert.throws(() => validateExternalSnapshot(manifest.externalFiles, f.project, {
        ...manifest.windowsExternalSecurity, parents,
      }), /external|security|parent|inventory/i);
    }
    await chmod(f.file, 0o600);
    await writeFile(f.file, 'changed\n');
    await writeFile(f.missing, 'now present\n');
    assert.deepEqual(await verifySnapshot(f.options.destination), manifest);
  });
}

for (const change of ['file-acl', 'new-presence', 'cancelled']) {
  test(`Windows external snapshot refuses ${change} at the final source boundary`, {
    skip: process.platform !== 'win32',
  }, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(createSnapshot({
      ...f.options, signal: controller.signal,
      externalFiles: [{ path: f.file, optional: false }, { path: f.missing, optional: true }],
      checkSource: async () => {
        if (++calls !== 2) return;
        if (change === 'file-acl') await windowsFileSecurity(f.file, 'broaden');
        else if (change === 'new-presence') await writeFile(f.missing, 'appeared\n');
        else controller.abort(new Error('External capture cancelled'));
      },
    }), /external|source|security|changed/i);
    assert.equal(calls, 2);
    await assert.rejects(lstat(path.join(f.options.destination, 'complete.json')), { code: 'ENOENT' });
    await rename(f.directory, `${f.directory}-closed`);
  });
}

test('Windows external snapshot refuses aliases and outside hardlinks before copying', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  await assert.rejects(createSnapshot({ ...f.options, externalFiles: [
    { path: f.file, optional: false }, { path: f.file.toUpperCase(), optional: false },
  ] }), /external|duplicate|canonical|alias/i);
  await assert.rejects(lstat(f.options.destination), { code: 'ENOENT' });
  await link(f.file, path.join(f.root, 'outside-alias'));
  await assert.rejects(createSnapshot({ ...f.options, externalFiles: [{ path: f.file, optional: false }] }), /link|file|source/i);
  await assert.rejects(lstat(f.options.destination), { code: 'ENOENT' });
});
