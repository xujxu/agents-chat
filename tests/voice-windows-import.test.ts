import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { importWindowsVoicePackage } from '../scripts/voice/windows/import-package.mjs';
import { voiceConfiguration } from '../lib/voice/configuration';
import { transcribeVoice } from '../lib/voice/transcriber';
import { decodeEnvironment } from '../scripts/voice/configuration-files.mjs';
import { voiceValues } from '../scripts/voice/setup-config.mjs';

test('Windows verified import preserves config and rejects corruption before using the real model', {
  timeout: 240000,
}, async t => {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.VOICE_CANDIDATE_DIRECTORY);
  assert.ok(process.env.VOICE_INSTALL_AUDIO);
  const source = path.resolve(process.env.VOICE_CANDIDATE_DIRECTORY);
  const raw = await readFile(path.join(source, 'voice-package.json'));
  const sha = createHash('sha256').update(raw).digest('hex');
  const manifest = JSON.parse(raw.toString('utf8'));
  assert.equal(manifest.version, 2);
  const root = await mkdtemp(path.join(tmpdir(), 'voice import \u8bed\u97f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = path.join(root, '.env.local');
  const sentinel = Buffer.from('OTHER=unchanged\r\nVOICE_ENABLED=0\r\n');
  await writeFile(environment, sentinel);
  const logs: string[] = [];
  const threads = manifest.modelId === 'sensevoice-small-q8' ? 2 : 1;
  const invoke = (hash = sha) => importWindowsVoicePackage({
    packageDir: source, manifestSha256: hash, model: manifest.modelId,
    destination: root, threads, log: (message: string) => logs.push(message),
  });
  const unchanged = async () => {
    assert.deepEqual(await readFile(environment), sentinel);
    assert.ok(!(await readdir(root)).some(name => name.startsWith('package-stage-')));
  };
  await assert.rejects(invoke('0'.repeat(64)), /checksum mismatch/);
  await unchanged();
  const helperEntry = manifest.files.find((file: { role: string }) => file.role === 'helper');
  const helper = path.join(source, helperEntry.path);
  const backup = helper + '.test-backup';
  await rename(helper, backup);
  try {
    await writeFile(helper, 'truncated executable');
    await assert.rejects(invoke(), /checksum mismatch/);
    await unchanged();
    const corrupted = await readFile(backup);
    corrupted[0] ^= 0xff;
    await writeFile(helper, corrupted);
    await assert.rejects(invoke(), /checksum mismatch/);
    await unchanged();
    await rm(helper);
    await symlink(backup, helper);
    await assert.rejects(invoke(), /ordinary unlinked/);
    await unchanged();
  } finally {
    await rm(helper, { force: true });
    await rename(backup, helper);
  }
  const result = await invoke();
  assert.ok((await lstat(result.launcher)).isFile());
  assert.match(logs.join('\n'), /Available physical memory/);
  assert.match(logs.join('\n'), /No new CPU\/RAM hard quota/);
  assert.match(logs.join('\n'), /limits are not known/);
  await unchanged();
  const config = await voiceConfiguration({
    VOICE_ENABLED: '1', VOICE_MODEL: manifest.modelId, VOICE_RESOURCE_POLICY: 'standard',
    VOICE_BINARY_PATH: result.binary, VOICE_LAUNCHER_PATH: result.launcher,
    VOICE_MODEL_PATH: result.model, VOICE_THREADS: String(result.threads),
  });
  assert.ok(config);
  const text = await transcribeVoice(await readFile(process.env.VOICE_INSTALL_AUDIO), config, AbortSignal.timeout(120000));
  assert.match(text, /country/i);
  assert.deepEqual(await invoke(), result);
  await unchanged();
  const receipt = path.join(root, 'activation.json');
  const configure = (...args: string[]) => spawnSync(process.execPath, [
    'scripts/configure-voice.mjs', '--project-dir', root, ...args,
  ], { encoding: 'utf8', timeout: 60000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('VOICE_'))) });
  let activated = configure('--model', manifest.modelId, '--package-dir', source,
    '--manifest-sha256', sha, '--receipt', receipt);
  assert.equal(activated.status, 0, activated.stderr);
  const persisted = await voiceConfiguration(voiceValues(decodeEnvironment(await readFile(environment))));
  assert.ok(persisted);
  assert.equal(persisted.resourcePolicy, 'standard');
  const installedText = await transcribeVoice(await readFile(process.env.VOICE_INSTALL_AUDIO), persisted, AbortSignal.timeout(120000));
  assert.match(installedText, /country/i);
  activated = configure('--model', 'keep', '--non-interactive');
  assert.equal(activated.status, 0, activated.stderr);
  activated = configure('--rollback-receipt', receipt);
  assert.equal(activated.status, 0, activated.stderr);
  await unchanged();
  activated = configure('--model', 'disabled', '--receipt', receipt);
  assert.equal(activated.status, 0, activated.stderr);
  assert.deepEqual(voiceValues(decodeEnvironment(await readFile(environment))), { VOICE_ENABLED: '0' });
  activated = configure('--rollback-receipt', receipt);
  assert.equal(activated.status, 0, activated.stderr);
  await unchanged();
  await writeFile(result.binary, 'modified installed executable');
  await assert.rejects(invoke(), /checksum mismatch/);
  await unchanged();
});
