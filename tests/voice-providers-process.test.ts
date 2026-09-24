import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseVoiceConfiguration, voiceConfiguration } from '../lib/voice/configuration';
import { transcribeVoice } from '../lib/voice/transcriber';
import { encodeVoiceWav, VoiceError } from '../lib/voice/audio';

const audio = encodeVoiceWav(new Float32Array(16000).fill(0.2));
const temporaryRequests = async () => (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();

test('native adapters preserve output, failure, policy and cleanup contracts', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-provider-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'engine');
  const model = path.join(root, 'model');
  await copyFile('tests/fixtures/voice-provider.py', binary);
  await chmod(binary, 0o755);
  const before = await temporaryRequests();
  for (const modelId of ['sensevoice-small-q8', 'whisper-base-q5_1']) {
    const env = { VOICE_ENABLED: '1', VOICE_MODEL: modelId, VOICE_BINARY_PATH: binary, VOICE_MODEL_PATH: model };
    const config = parseVoiceConfiguration(env)!;
    for (const mode of ['valid', 'stderr', 'memory']) {
      await writeFile(model, mode);
      assert.equal(await transcribeVoice(audio, config, AbortSignal.timeout(5000)), '\u4f60\u597d\uff0cvoice PoC.');
      assert.deepEqual(await temporaryRequests(), before);
    }
    for (const [mode, error] of [
      ['empty', 'voice_no_speech'], ['oversized', 'voice_invalid_result'],
      ['invalid', 'voice_invalid_result'], ['nul', 'voice_invalid_result'], ['fail', 'voice_inference_failed'],
      ...(modelId === 'whisper-base-q5_1' ? [['missing', 'voice_invalid_result']] : []),
    ]) {
      await writeFile(model, mode);
      await assert.rejects(transcribeVoice(audio, config, AbortSignal.timeout(5000)), { message: error });
      assert.deepEqual(await temporaryRequests(), before);
    }
    await writeFile(model, 'valid');
    assert.ok(await voiceConfiguration(env));
    await assert.rejects(voiceConfiguration({ ...env, VOICE_MODEL_PATH: root }), /voice_not_configured/);
    await assert.rejects(voiceConfiguration({ ...env, VOICE_MODEL_PATH: path.join(root, 'absent') }), /voice_not_configured/);
  }
  await chmod(binary, 0o644);
  await assert.rejects(voiceConfiguration({
    VOICE_ENABLED: '1', VOICE_WHISPER_PATH: binary, VOICE_MODEL_PATH: model,
  }), /voice_not_configured/);
});

test('cancellation terminates the native process group and cleans request files', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-provider-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'engine');
  const model = path.join(root, 'model');
  await copyFile('tests/fixtures/voice-provider.py', binary);
  await chmod(binary, 0o755);
  await writeFile(model, 'wait');
  const config = parseVoiceConfiguration({
    VOICE_ENABLED: '1', VOICE_MODEL: 'sensevoice-small-q8', VOICE_BINARY_PATH: binary, VOICE_MODEL_PATH: model,
  })!;
  const before = await temporaryRequests();
  const controller = new AbortController();
  const pending = transcribeVoice(audio, config, controller.signal);
  const rejected = assert.rejects(pending, /voice_cancelled/);
  let descendant = 0;
  try {
    for (let attempt = 0; attempt < 100 && !descendant; attempt++) {
      for (const name of await temporaryRequests()) {
        if (before.includes(name)) continue;
        try { descendant = Number(await readFile(path.join(tmpdir(), name, 'descendant.pid'), 'utf8')); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      if (!descendant) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(descendant > 0, 'fixture must start a real descendant before cancellation');
  } finally {
    controller.abort(new VoiceError('voice_cancelled', 499));
    await rejected;
  }
  let status: string | null = null;
  try { status = await readFile(`/proc/${descendant}/status`, 'utf8'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  assert.ok(status === null || /^State:\s+[XZ]/m.test(status), 'descendant must not remain running');
  assert.deepEqual(await temporaryRequests(), before);
  await assert.rejects(transcribeVoice(audio, config, controller.signal), /voice_cancelled/);
  assert.deepEqual(await temporaryRequests(), before);
});
