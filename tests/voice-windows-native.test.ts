import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { voiceConfiguration } from '../lib/voice/configuration';
import { transcribeVoice } from '../lib/voice/transcriber';

async function sha256(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

test('real Windows candidate transcribes through the application from Unicode paths', {
  timeout: 420000,
}, async () => {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.VOICE_CANDIDATE_DIRECTORY);
  assert.ok(process.env.VOICE_INSTALL_AUDIO);
  const source = path.resolve(process.env.VOICE_CANDIDATE_DIRECTORY);
  const raw = await readFile(path.join(source, 'candidate.json'));
  const inventory = JSON.parse(raw.toString('utf8'));
  assert.equal(inventory.kind, 'windows-native-build-candidate');
  assert.equal(inventory.platform, 'windows-x64');
  assert.equal(inventory.qualification, 'smoke-only-not-release-approved');
  assert.equal((await readFile(path.join(source, 'candidate.sha256'), 'utf8')).split(' ')[0],
    createHash('sha256').update(raw).digest('hex'));
  const files: { path: string; role: string; bytes: number; sha256: string }[] = inventory.files;
  for (const file of files) {
    assert.ok(/^[a-zA-Z0-9_./-]+$/.test(file.path));
    assert.ok(!file.path.split('/').some(part => !part || part === '..' || part === '.'));
    assert.equal((await stat(path.join(source, file.path))).size, file.bytes);
    assert.equal(await sha256(path.join(source, file.path)), file.sha256);
  }
  const identity = (role: string) => {
    const selected = files.filter(file => file.role === role);
    assert.equal(selected.length, 1, role);
    return selected[0];
  };
  const binary = identity('engine');
  const helper = identity('helper');
  const model = identity('model');
  assert.equal(model.sha256, inventory.modelId === 'sensevoice-small-q8'
    ? '4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5'
    : '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898');
  assert.ok(['sensevoice-small-q8', 'whisper-base-q5_1'].includes(inventory.modelId));
  const root = await mkdtemp(path.join(tmpdir(), 'voice real \u8bed\u97f3-'));
  const requests = async () => (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();
  const before = await requests();
  try {
    await cp(source, root, { recursive: true });
    const audio = await readFile(process.env.VOICE_INSTALL_AUDIO);
    for (const threads of ['1', '2', '4']) {
      const config = await voiceConfiguration({
        VOICE_ENABLED: '1', VOICE_MODEL: inventory.modelId, VOICE_THREADS: threads,
        VOICE_RESOURCE_POLICY: 'standard',
        VOICE_BINARY_PATH: path.join(root, binary.path),
        VOICE_LAUNCHER_PATH: path.join(root, helper.path),
        VOICE_MODEL_PATH: path.join(root, model.path),
      });
      assert.ok(config);
      const text = await transcribeVoice(audio, config, AbortSignal.timeout(120000));
      assert.match(text, /country/i);
      assert.deepEqual(await requests(), before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
