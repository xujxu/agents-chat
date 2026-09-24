import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { updateVoiceEnvironment, selectVoiceAction } from '../scripts/voice/setup-config.mjs';
import { validateManifest } from '../scripts/voice/install-package.mjs';
import { models } from '../scripts/voice/setup-config.mjs';

test('interactive upgrades always ask; blank/closed input keeps current settings', () => {
  for (const configured of [false, true]) {
    assert.equal(selectVoiceAction({ interactive: true, configured }).prompt, true);
    assert.equal(selectVoiceAction({ interactive: true, configured, answer: '' }).model, 'keep');
    assert.equal(selectVoiceAction({ interactive: true, configured, answer: null }).model, 'keep');
    assert.equal(selectVoiceAction({ interactive: false, configured }).model, 'keep');
  }
  assert.equal(selectVoiceAction({ interactive: true, answer: '4' }).model, 'disabled');
  assert.throws(() => selectVoiceAction({ interactive: true, answer: 'unknown' }), /Invalid selection/);
});

test('environment updates preserve unrelated configuration and remove all old voice keys', () => {
  const original = '# local config\nADMIN_PASSWORD="unchanged"\nVOICE_ENABLED=1\nVOICE_MODEL=old\nVOICE_THREADS=1\nVOICE_ENABLED=1\n';
  assert.equal(updateVoiceEnvironment(original, 'keep'), original);
  assert.equal(updateVoiceEnvironment(original, 'disabled'),
    '# local config\nADMIN_PASSWORD="unchanged"\nVOICE_ENABLED=0\n');
  assert.throws(() => updateVoiceEnvironment(original, 'qwen-int8'), /Unsupported/);
});

test('setup command supports fresh opt-out, unattended keep, explicit disable and rollback', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const invoke = (...args) => spawnSync(process.execPath, [
    'scripts/configure-voice.mjs', '--project-dir', root, ...args,
  ], { encoding: 'utf8', env });
  const original = 'ADMIN_PASSWORD="not-for-output"\nVOICE_ENABLED=1\nVOICE_WHISPER_PATH=/old/whisper\nVOICE_MODEL_PATH=/old/model\n';
  const file = path.join(root, '.env.local');
  let result = invoke('--non-interactive');
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await writeFile(file, original);
  result = invoke('--non-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(file, 'utf8'), original);
  const receipt = path.join(root, 'receipt.json');
  result = invoke('--model', 'disabled', '--receipt', receipt);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /not-for-output/);
  assert.equal(await readFile(file, 'utf8'), 'ADMIN_PASSWORD="not-for-output"\nVOICE_ENABLED=0\n');
  result = invoke('--rollback-receipt', receipt);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(file, 'utf8'), original);
  result = invoke('--model', 'disabled', '--receipt', receipt);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(file, 'VOICE_ENABLED=0\nCHANGED=by-admin\n');
  assert.notEqual(invoke('--rollback-receipt', receipt).status, 0);
  assert.match(await readFile(file, 'utf8'), /CHANGED=by-admin/);
});

test('failed installation, higher-priority overrides and concurrent setup preserve configuration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.env.local');
  const original = 'VOICE_ENABLED=0\nOTHER=preserve\n';
  await writeFile(file, original);
  const invoke = (...args) => spawnSync(process.execPath, [
    'scripts/configure-voice.mjs', '--project-dir', root, ...args,
  ], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  for (const args of [
    ['--model', 'qwen-int8'],
    ['--model', 'sensevoice-small-q8'],
    ['--model', 'sensevoice-small-q8', '--package-dir', root, '--manifest-sha256', '0'.repeat(64)],
    ['--threads', '8', '--model', 'disabled'],
  ]) {
    const result = invoke(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(await readFile(file, 'utf8'), original);
  }
  await writeFile(path.join(root, '.env.production.local'), 'VOICE_ENABLED=1\n');
  assert.notEqual(invoke('--model', 'disabled').status, 0);
  assert.equal(await readFile(file, 'utf8'), original);
  await rm(path.join(root, '.env.production.local'));
  await mkdir(path.join(root, '.data/voice/setup.lock'), { recursive: true });
  assert.notEqual(invoke('--model', 'disabled').status, 0);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('package manifests reject traversal, wrong weights, duplicates and missing license scope', () => {
  const model = 'sensevoice-small-q8';
  const valid = {
    version: 1, modelId: model, platform: 'linux-x64', minGlibc: '2.35',
    cpuFlags: ['avx2', 'fma', 'f16c', 'bmi2'],
    files: [
      { path: 'bin/engine', role: 'binary', sha256: 'a'.repeat(64), bytes: 10 },
      { path: 'models/model', role: 'model', sha256: models[model].modelSha256, bytes: 100 },
      { path: 'licenses/MIT.txt', role: 'license', sha256: 'b'.repeat(64), bytes: 10 },
    ],
  };
  assert.equal(validateManifest(valid, model).size, 120);
  for (const relative of ['../escape', '/absolute', 'bin/../../escape', 'bin//engine', 'bin/./engine']) {
    const candidate = structuredClone(valid);
    candidate.files[0].path = relative;
    assert.throws(() => validateManifest(candidate, model));
  }
  const wrong = structuredClone(valid);
  wrong.files[1].sha256 = '0'.repeat(64);
  assert.throws(() => validateManifest(wrong, model));
  assert.throws(() => validateManifest({ ...valid, files: [...valid.files, valid.files[0]] }, model));
  assert.throws(() => validateManifest({ ...valid, files: valid.files.slice(0, 2) }, model));
  assert.throws(() => validateManifest(valid, 'whisper-base-q5_1'));
});

test('standalone release includes dependency-free voice reconfiguration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  for (const file of ['package-release.mjs', 'configure-voice.mjs', 'voice']) {
    await cp(path.join('scripts', file), path.join(root, 'scripts', file), { recursive: true });
  }
  const packaged = spawnSync(process.execPath, [path.join(root, 'scripts/package-release.mjs')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, RELEASE_TARGET: 'linux-x64' },
  });
  assert.equal(packaged.status, 0, packaged.stderr);
  const bundle = path.join(root, 'dist/release/agents-chat-linux-x64');
  const result = spawnSync(process.execPath, [path.join(bundle, 'scripts/configure-voice.mjs'), '--model', 'disabled'], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(bundle, '.env.local'), 'utf8'), 'VOICE_ENABLED=0\n');
});
