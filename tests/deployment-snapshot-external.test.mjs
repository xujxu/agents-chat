import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const directory = path.join(root, 'system');
  await mkdir(project);
  await mkdir(directory);
  await writeFile(path.join(project, 'package.json'), '{}');
  const file = path.join(directory, 'service.env');
  await writeFile(file, 'SECRET=private-value\n');
  await chmod(file, 0o640);
  return { root, project, directory, file, options: {
    project, destination: path.join(root, 'staging'), id: 'external', files: ['package.json'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  } };
}

test('Linux snapshot captures external service/config bytes, permissions and absence', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t);
  const missing = path.join(f.directory, 'absent.env');
  const manifest = await createSnapshot({ ...f.options, externalFiles: [
    { path: f.file, optional: false }, { path: missing, optional: true },
  ] });
  assert.equal(manifest.externalFiles.length, 2);
  assert.equal(manifest.externalFiles[0].path, f.file);
  assert.equal(manifest.externalFiles[0].mode, 0o640);
  assert.equal(manifest.externalFiles[1].kind, 'absent');
  assert.doesNotMatch(JSON.stringify(manifest), /private-value/);
  assert.equal(await readFile(path.join(f.options.destination, 'external', '0'), 'utf8'), 'SECRET=private-value\n');
  await writeFile(f.file, 'updated');
  await writeFile(missing, 'now present');
  assert.equal((await verifySnapshot(f.options.destination)).id, 'external');
  assert.deepEqual(await readdir(path.join(f.options.destination, 'external')), ['0']);
  await writeFile(path.join(f.options.destination, 'external', '0'), 'corrupt');
  await assert.rejects(verifySnapshot(f.options.destination), /external|checksum|integrity/i);
});

test('external source ownership and presence errors refuse before creating a snapshot', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t);
  for (const externalFiles of [
    [{ path: path.join(f.directory, 'missing'), optional: false }],
    [{ path: f.directory, optional: false }],
    [{ path: f.file, optional: false }, { path: f.file, optional: true }],
    [{ path: path.join(f.project, 'package.json'), optional: false }],
    [{ path: f.options.destination, optional: true }],
  ]) {
    await assert.rejects(createSnapshot({ ...f.options, externalFiles }));
    assert.equal((await readdir(f.root)).includes('staging'), false);
  }
});

test('linked external resources cannot substitute unreviewed configuration', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'linked');
  await symlink('service.env', file);
  await assert.rejects(createSnapshot({ ...f.options, externalFiles: [{ path: file, optional: false }] }));
});

test('external resource tampering and extra payloads invalidate a complete snapshot', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t);
  await createSnapshot({ ...f.options, externalFiles: [{ path: f.file, optional: false }] });
  await writeFile(path.join(f.options.destination, 'external', 'foreign'), 'not owned by this snapshot');
  await assert.rejects(verifySnapshot(f.options.destination), /external|inventory/i);
});

test('Windows external resources require native ACL capture rather than POSIX metadata', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  await assert.rejects(createSnapshot({ ...f.options, externalFiles: [{ path: f.file, optional: false }] }),
    /Windows|ACL|external/i);
  assert.equal((await readdir(f.root)).includes('staging'), false);
});

test('failed final source authority check leaves an incomplete snapshot without completion marker', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(createSnapshot({ ...f.options, checkSource: async () => {
    if (++calls === 2) throw new Error('source authority lost');
  } }), /source authority lost/);
  assert.equal(calls, 2);
  await assert.rejects(readFile(path.join(f.options.destination, 'complete.json')), { code: 'ENOENT' });
});
