import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import path from 'node:path';
import { voiceConfiguration } from '../lib/voice/configuration';
import { transcribeVoice } from '../lib/voice/transcriber';

test('installed package transcribes using the real persisted provider configuration', {
  skip: !process.env.VOICE_INSTALLED_PROJECT, timeout: 130_000,
}, async () => {
  const text = await readFile(path.join(process.env.VOICE_INSTALLED_PROJECT!, '.env.local'), 'utf8');
  const env: Record<string, string> = {};
  for (const line of text.trim().split('\n')) {
    const separator = line.indexOf('=');
    const value = line.slice(separator + 1);
    env[line.slice(0, separator)] = value.startsWith('"') ? JSON.parse(value) : value;
  }
  const config = await voiceConfiguration(env);
  assert.ok(config);
  assert.equal(config.resourcePolicy, 'standard');
  const transcript = await transcribeVoice(await readFile(process.env.VOICE_INSTALL_AUDIO!), config, AbortSignal.timeout(120_000));
  assert.match(transcript, /country/i);
});
