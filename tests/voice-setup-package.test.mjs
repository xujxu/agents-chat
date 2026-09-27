import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, rm, mkdtemp, symlink, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('real package checksums, interrupted files and tampering never replace prior configuration', {
  skip: !process.env.VOICE_PACKAGE_DIR, timeout: 120000,
}, async t => {
  const source = path.resolve(process.env.VOICE_PACKAGE_DIR);
  const raw = await readFile(path.join(source, 'voice-package.json'));
  const sha = createHash('sha256').update(raw).digest('hex');
  const manifest = JSON.parse(raw);
  const binary = path.join(source, manifest.files.find(file => file.role === 'binary').path);
  const root = await mkdtemp(path.join(tmpdir(), 'voice-package-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envFile = path.join(root, '.env.local');
  const original = 'OTHER=preserved\nVOICE_ENABLED=0\n';
  await writeFile(envFile, original);
  const invoke = (hash = sha) => spawnSync(process.execPath, [
    'scripts/configure-voice.mjs', '--project-dir', root, '--model', manifest.modelId,
    '--package-dir', source, '--manifest-sha256', hash,
  ], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000 });
  const unchanged = async () => {
    assert.equal(await readFile(envFile, 'utf8'), original);
    assert.ok(!(await readdir(path.join(root, '.data/voice'))).some(name => name.startsWith('package-stage-') || name === 'setup.lock'));
  };
  assert.notEqual(invoke('0'.repeat(64)).status, 0);
  await unchanged();
  const backup = binary + '.test-backup';
  await rename(binary, backup);
  try {
    await writeFile(binary, 'truncated native download');
    assert.notEqual(invoke().status, 0);
    await unchanged();
    await rm(binary);
    await symlink(backup, binary);
    assert.notEqual(invoke().status, 0);
    await unchanged();
  } finally {
    await rm(binary, { force: true });
    await rename(backup, binary);
  }
  let result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const installed = await readFile(envFile, 'utf8');
  assert.match(installed, /VOICE_ENABLED=1/);
  assert.match(installed, /VOICE_RESOURCE_POLICY=standard/);
  assert.equal((await lstat(path.join(root, '.data/voice/last-setup.json'))).mode & 0o777, 0o600);
  const target = path.join(root, '.data/voice/packages', sha, manifest.files.find(file => file.role === 'binary').path);
  await writeFile(target, 'changed installed runtime');
  result = invoke();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(envFile, 'utf8'), installed);
});
