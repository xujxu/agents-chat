import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableMemoryKiB, checkVoiceMemory, VOICE_START_MEMORY_KIB, VOICE_MIN_FREE_KIB, VOICE_MAX_RSS_KIB } from '../lib/voice/memory';

test('unknown host memory cannot silently admit transcription', () => {
  assert.equal(availableMemoryKiB('MemTotal: 4000000 kB\nMemAvailable: 900000 kB\n'), 900000);
  assert.throws(() => availableMemoryKiB('MemTotal: 4000000 kB\n'), /voice_memory_unknown/);
});

test('admission requires 768 MiB, and active guards enforce RSS and host headroom independently', () => {
  checkVoiceMemory(VOICE_START_MEMORY_KIB);
  assert.throws(() => checkVoiceMemory(VOICE_START_MEMORY_KIB - 1), /voice_low_memory/);
  checkVoiceMemory(VOICE_MIN_FREE_KIB, VOICE_MAX_RSS_KIB);
  assert.throws(() => checkVoiceMemory(VOICE_MIN_FREE_KIB - 1, 1024), /voice_low_memory/);
  assert.throws(() => checkVoiceMemory(VOICE_START_MEMORY_KIB, VOICE_MAX_RSS_KIB + 1), /voice_memory_limit/);
});
