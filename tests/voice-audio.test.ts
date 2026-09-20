import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeVoiceWav, validateVoiceWav, MAX_VOICE_BYTES, MAX_VOICE_SECONDS } from '../lib/voice/audio';
import { appendVoiceTranscript } from '../app/features/composer/voice/voiceHelpers';

test('voice WAV is canonical mono 16-bit PCM at 16kHz', () => {
  const bytes = encodeVoiceWav(new Float32Array(16_000).fill(0.25));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(bytes.length, 32_044);
  assert.equal(validateVoiceWav(bytes).durationSeconds, 1);
});

test('exact 30 second limit fits nginx; max plus one sample is rejected', () => {
  assert.equal(MAX_VOICE_SECONDS, 30);
  const samples = new Float32Array(16_000 * MAX_VOICE_SECONDS).fill(0.5);
  const bytes = encodeVoiceWav(samples);
  assert.equal(bytes.length, MAX_VOICE_BYTES);
  assert.ok(MAX_VOICE_BYTES < 1024 * 1024);
  assert.equal(validateVoiceWav(bytes).durationSeconds, 30);
  assert.throws(() => encodeVoiceWav(new Float32Array(samples.length + 1)), /too_long/);
  assert.throws(() => validateVoiceWav(new Uint8Array(MAX_VOICE_BYTES + 1)), /too_large/);
});

test('rejects malformed, truncated, non-PCM, stereo, wrong-rate and non-finite audio', () => {
  const valid = encodeVoiceWav(new Float32Array(16_000).fill(0.2));
  for (const [offset, value] of [[0, 0], [4, 0], [8, 0], [12, 0], [16, 18], [20, 3], [22, 2], [24, 48_000], [28, 0], [32, 4], [34, 32], [36, 0], [40, 0]]) {
    const corrupt = valid.slice();
    new DataView(corrupt.buffer).setUint32(offset, value, true);
    assert.throws(() => validateVoiceWav(corrupt), /invalid_audio/);
  }
  assert.throws(() => validateVoiceWav(valid.slice(0, -1)), /invalid_audio/);
  assert.throws(() => validateVoiceWav(new Uint8Array(10)), /invalid_audio/);
  assert.throws(() => encodeVoiceWav(new Float32Array([NaN])), /invalid_audio/);
  assert.throws(() => encodeVoiceWav(new Float32Array([Infinity])), /invalid_audio/);
});

test('silence and empty input are explicit errors, not hallucinated transcripts', () => {
  assert.throws(() => encodeVoiceWav(new Float32Array()), /no_audio/);
  assert.throws(() => validateVoiceWav(encodeVoiceWav(new Float32Array(16_000))), /no_speech/);
});

test('transcript append preserves all existing text and normalizes only the new transcript', () => {
  assert.equal(appendVoiceTranscript('Draft typed while waiting', '  新的语音输入  '), 'Draft typed while waiting\n新的语音输入');
  assert.equal(appendVoiceTranscript('draft\n', 'more'), 'draft\nmore');
  assert.equal(appendVoiceTranscript('', ' hello '), 'hello');
  assert.equal(appendVoiceTranscript('keep me', ' \n '), 'keep me');
});
