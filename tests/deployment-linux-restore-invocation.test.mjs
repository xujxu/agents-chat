import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { projectSnapshotExclusions } from '../scripts/deployment/snapshot-scope.mjs';
import { prepareLinuxRestoreInvocation } from '../scripts/deployment/linux-restore-invocation.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { foreign = false, projectScope = true, platform = 'linux', versioned = false } = {}) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'installed app');
  const control = path.join(root, '.installed app.deployment');
  const engine = path.join(control, 'recovery-engine');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  await mkdir(engine, { mode: 0o700 });
  const files = [];
  for (const name of ['linux-restore-entry.mjs', 'saved-recovery-engine.mjs', 'legacy-helper.mjs']) {
    const bytes = Buffer.from('throw new Error("Admission must not import saved code");\n');
    await writeFile(path.join(engine, name), bytes, { mode: 0o600 });
    files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = { version: 1, files };
  const manifestFile = path.join(engine, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  const recoveryEngine = versioned ? hash(await readFile(manifestFile)) : undefined;
  const source = foreign ? path.join(root, 'different app') : project;
  if (foreign) await mkdir(source);
  await writeFile(path.join(source, 'fixture.db'), 'retained data');
  const backup = path.join(control, 'backup');
  const executables = [
    { file: '/usr/bin/npm', target: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
    { file: process.execPath, target: process.execPath },
  ];
  await createSnapshot({
    project: source, destination: backup, id: 'historical-engine', files: ['fixture.db'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform, state: 'stopped', unit: 'agents-chat.service', executables },
    projectScope, excludedPaths: projectScope ? projectSnapshotExclusions : [], recoveryEngine,
  });
  return { project, control, engine, backup, manifest, manifestFile, executables, recoveryEngine };
}

test('public restore requires the exact engine digest bound into a version-two backup', async t => {
  const f = await fixture(t, { versioned: true });
  const snapshot = await verifySnapshot(f.backup);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.recoveryEngine, f.recoveryEngine);
  assert.equal((await prepareLinuxRestoreInvocation({ project: f.project })).args[2], f.recoveryEngine);
  f.manifest.files.reverse();
  await writeFile(f.manifestFile, JSON.stringify(f.manifest));
  await assert.rejects(prepareLinuxRestoreInvocation({ project: f.project }), /engine.*digest|engine.*backup/i);
});

test('public restore admission uses the saved inventory rather than importing or imposing the current engine', async t => {
  const f = await fixture(t);
  const before = (await readdir(f.control)).sort();
  const invocation = await prepareLinuxRestoreInvocation({ project: f.project, timeoutSeconds: 60 });
  assert.equal(invocation.file, process.execPath);
  assert.deepEqual(invocation.args, [
    path.join(f.engine, 'linux-restore-entry.mjs'), f.control,
    hash(await readFile(f.manifestFile)), '--accept-data-loss',
  ]);
  assert.deepEqual(invocation.input, {
    project: f.project, unit: 'agents-chat.service', npm: f.executables[0].file,
    node: process.execPath, backup: f.backup, port: 3010, waitSeconds: 120, timeoutSeconds: 60,
  });
  assert.equal(invocation.backupId, 'historical-engine');
  assert.deepEqual((await readdir(f.control)).sort(), before);
});

for (const kind of ['checksum', 'extra-file', 'link', 'permissions', 'traversal']) {
  test(`public restore admission refuses saved engine ${kind} without creating operation evidence`, async t => {
    const f = await fixture(t);
    const helper = path.join(f.engine, 'legacy-helper.mjs');
    if (kind === 'checksum') await writeFile(helper, 'corrupt');
    if (kind === 'extra-file') await writeFile(path.join(f.engine, 'extra.mjs'), '', { mode: 0o600 });
    if (kind === 'link') {
      await unlink(helper);
      await symlink('linux-restore-entry.mjs', helper);
    }
    if (kind === 'permissions') await chmod(helper, 0o644);
    if (kind === 'traversal') {
      f.manifest.files[2].name = '../legacy-helper.mjs';
      await writeFile(f.manifestFile, JSON.stringify(f.manifest));
    }
    const before = (await readdir(f.control)).sort();
    await assert.rejects(prepareLinuxRestoreInvocation({ project: f.project, timeoutSeconds: 60 }),
      /integrity|inventory|file|ownership|descriptor/i);
    assert.deepEqual((await readdir(f.control)).sort(), before);
  });
}

for (const [kind, options] of [
  ['foreign project', { foreign: true }], ['partial scope', { projectScope: false }],
  ['Windows runtime', { platform: 'win32' }],
]) {
  test(`public restore admission refuses backup ${kind} without creating operation evidence`, async t => {
    const f = await fixture(t, options);
    const before = (await readdir(f.control)).sort();
    await assert.rejects(prepareLinuxRestoreInvocation({ project: f.project, timeoutSeconds: 60 }),
      /this project and an external Linux runtime/i);
    assert.deepEqual((await readdir(f.control)).sort(), before);
  });
}
