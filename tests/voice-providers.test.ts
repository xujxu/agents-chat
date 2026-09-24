import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVoiceConfiguration, voiceCapabilities } from '../lib/voice/configuration';
import { voiceCommand, decodeVoiceText } from '../lib/voice/providers';

const paths = { VOICE_ENABLED: '1', VOICE_BINARY_PATH: '/opt/voice/engine', VOICE_MODEL_PATH: '/opt/voice/model' };

test('disabled configuration does not require a model or native runtime', () => {
  assert.equal(parseVoiceConfiguration({}), null);
  assert.equal(parseVoiceConfiguration({ VOICE_ENABLED: '0', VOICE_MODEL: 'invalid' }), null);
  assert.deepEqual(voiceCapabilities(null), { enabled: false, model: null, provider: null, threads: null, resourcePolicy: null });
});

test('unmodified legacy environment keeps Whisper identity and historical guards', () => {
  const config = parseVoiceConfiguration({
    VOICE_ENABLED: '1', VOICE_WHISPER_PATH: '/opt/voice/whisper', VOICE_MODEL_PATH: '/opt/voice/base',
  })!;
  assert.equal(config.modelId, 'whisper-base-q5_1');
  assert.equal(config.resourcePolicy, 'legacy-low-memory');
  assert.equal(config.threads, 1);
  assert.equal(voiceCapabilities(config).model, 'base-q5_1');
  assert.ok(voiceCommand(config, '/tmp/input.wav', '/tmp/result').args.includes('--as=1073741824'));
});

test('explicit models use standard native execution without inherited experiment quotas', () => {
  for (const model of ['sensevoice-small-q8', 'whisper-base-q5_1']) {
    const config = parseVoiceConfiguration({ ...paths, VOICE_MODEL: model })!;
    const command = voiceCommand(config, '/tmp/input.wav', '/tmp/result');
    assert.equal(config.resourcePolicy, 'standard');
    assert.equal(command.command, '/usr/bin/nice');
    assert.ok(command.args.includes('--core=0'));
    assert.ok(!command.args.some(arg => /^--(as|cpu|memory|cpus)=/.test(arg)));
    assert.ok(!command.args.includes('systemd-run'));
    assert.ok(!command.args.includes('docker'));
  }
});

test('Sense uses the qualified CPU CLI and stdout; capability never leaks paths', () => {
  const config = parseVoiceConfiguration({ ...paths, VOICE_MODEL: 'sensevoice-small-q8', VOICE_THREADS: '4' })!;
  assert.deepEqual(voiceCapabilities(config), {
    enabled: true, model: 'sensevoice-small-q8', provider: 'sensevoice-gguf', threads: 4, resourcePolicy: 'standard',
  });
  assert.deepEqual(voiceCommand(config, '/tmp/input.wav', '/tmp/result').args.slice(5), [
    '/opt/voice/engine', '-m', '/opt/voice/model', '-a', '/tmp/input.wav', '--threads', '4', '--backend', 'cpu',
  ]);
  assert.equal(config.threads, 4);
  assert.equal(parseVoiceConfiguration({ ...paths, VOICE_MODEL: 'sensevoice-small-q8' })!.threads, 2);
});

test('explicit legacy policy is supported only for the original one-thread Whisper profile', () => {
  const env = { ...paths, VOICE_MODEL: 'whisper-base-q5_1', VOICE_RESOURCE_POLICY: 'legacy-low-memory' };
  assert.equal(parseVoiceConfiguration(env)!.resourcePolicy, 'legacy-low-memory');
  assert.throws(() => parseVoiceConfiguration({ ...env, VOICE_THREADS: '2' }), /voice_not_configured/);
  assert.throws(() => parseVoiceConfiguration({ ...env, VOICE_MODEL: 'sensevoice-small-q8' }), /voice_not_configured/);
});

test('invalid enabled configurations fail explicitly instead of falling back to another model', () => {
  for (const override of [
    { VOICE_ENABLED: 'true' }, { VOICE_MODEL: 'qwen-int8' }, { VOICE_MODEL: 'disabled' },
    { VOICE_THREADS: '0' }, { VOICE_THREADS: '2junk' }, { VOICE_THREADS: '8' },
    { VOICE_RESOURCE_POLICY: 'unlimited' }, { VOICE_BINARY_PATH: 'relative' }, { VOICE_MODEL_PATH: '' },
  ]) {
    assert.throws(() => parseVoiceConfiguration({ ...paths, VOICE_MODEL: 'sensevoice-small-q8', ...override }), /voice_not_configured/);
  }
  assert.throws(() => parseVoiceConfiguration({ ...paths, VOICE_MODEL: 'sensevoice-small-q8' }, 'win32'), /voice_not_configured/);
  assert.throws(() => parseVoiceConfiguration({ ...paths, VOICE_MODEL: 'sensevoice-small-q8' }, 'linux', 'arm64'), /voice_not_configured/);
  assert.throws(() => parseVoiceConfiguration({ ...paths, VOICE_MODEL: '' }), /voice_not_configured/);
});

test('bounded UTF-8 output is mandatory for both adapters', () => {
  assert.equal(decodeVoiceText(Buffer.from(' hello world \n')), 'hello world');
  assert.throws(() => decodeVoiceText(Buffer.from(' \n')), /voice_no_speech/);
  assert.throws(() => decodeVoiceText(Buffer.alloc(32769, 65)), /voice_invalid_result/);
  assert.throws(() => decodeVoiceText(Buffer.from([0xff])), /voice_invalid_result/);
  assert.throws(() => decodeVoiceText(Buffer.from('hello\0world')), /voice_invalid_result/);
});

test('Windows requires an explicit model, native launcher and standard policy', () => {
  const windows = {
    VOICE_ENABLED: '1', VOICE_MODEL: 'sensevoice-small-q8',
    VOICE_BINARY_PATH: 'C:\\voice engine\\engine.exe',
    VOICE_LAUNCHER_PATH: 'C:\\voice engine\\voice-job.exe',
    VOICE_MODEL_PATH: 'C:\\voice engine\\model.gguf',
  };
  const config = parseVoiceConfiguration(windows, 'win32', 'x64')!;
  assert.equal(voiceCommand(config, 'C:\\temp\\audio.wav', 'C:\\temp\\result').command,
    windows.VOICE_LAUNCHER_PATH);
  assert.deepEqual(voiceCommand(config, 'C:\\temp\\audio.wav', 'C:\\temp\\result').args, [
    '120000', windows.VOICE_BINARY_PATH, '-m', windows.VOICE_MODEL_PATH,
    '-a', 'C:\\temp\\audio.wav', '--threads', '2', '--backend', 'cpu',
  ]);
  assert.equal(config.resourcePolicy, 'standard');
  for (const change of [
    { VOICE_LAUNCHER_PATH: undefined },
    { VOICE_BINARY_PATH: 'C:relative.exe' },
    { VOICE_BINARY_PATH: '\\\\server\\share\\engine.exe' },
    { VOICE_BINARY_PATH: 'C:\\engine.cmd' },
    { VOICE_MODEL_PATH: 'C:\\model:stream' },
    { VOICE_MODEL_PATH: 'C:\\bad\0model' },
    { VOICE_RESOURCE_POLICY: 'legacy-low-memory' },
    { VOICE_MODEL: undefined },
  ]) {
    assert.throws(() => parseVoiceConfiguration({ ...windows, ...change }, 'win32', 'x64'),
      /voice_not_configured/);
  }
  assert.throws(() => parseVoiceConfiguration(windows, 'win32', 'arm64'), /voice_not_configured/);
});
