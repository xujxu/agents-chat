import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceError } from '../../lib/voice/audio';
import { voiceConfiguration, type VoiceConfiguration } from '../../lib/voice/configuration';
import { runVoiceProcess } from '../../lib/voice/process';
import { decodeVoiceText } from '../../lib/voice/providers';
import { transcribeVoice } from '../../lib/voice/transcriber';
import { createWindowsVoiceDirectory } from '../../lib/voice/windowsNative';
import { decodeEnvironment } from '../../scripts/voice/configuration-files.mjs';
import { voiceValues } from '../../scripts/voice/setup-config.mjs';

export type ConsistencySample = {
  id: string; dataset: string; reference: string; category: string;
  duration: number; split: string; audio_sha256: string;
};
export type ConsistencyIdentity = {
  manifest: string; binary: string; model: string; helper: string | null;
};
export type ConsistencyOutcome = {
  text: string | null; failure: string | null; seconds: number;
  status: number | null; apiElapsedMs: number | null;
  stdoutBase64: string | null; stdoutSha256: string | null;
};

async function fileHash(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function installedConsistencyConfiguration(threads: number) {
  const config = await voiceConfiguration(voiceValues(decodeEnvironment(await readFile('.env.local'))));
  assert.ok(config);
  assert.equal(config.modelId, 'sensevoice-small-q8');
  assert.equal(config.resourcePolicy, 'standard');
  assert.equal(config.threads, threads);
  assert.equal(config.platform, process.platform);
  const identity: ConsistencyIdentity = {
    manifest: await fileHash('diagnostics/package-manifest.json'),
    binary: await fileHash(config.binary), model: await fileHash(config.model),
    helper: config.launcher ? await fileHash(config.launcher) : null,
  };
  const host: { identity: ConsistencyIdentity } = JSON.parse(await readFile('diagnostics/environment.json', 'utf8'));
  assert.deepEqual(identity, host.identity, 'Installed bytes differ from verified package identity');
  return { config, identity };
}

async function nativeBytes(audio: Uint8Array, config: VoiceConfiguration, signal: AbortSignal) {
  const directory = config.platform === 'win32'
    ? await createWindowsVoiceDirectory(config.launcher!)
    : await mkdtemp(path.join(tmpdir(), 'agents-chat-voice-'));
  try {
    const input = path.join(directory, 'audio.wav');
    await writeFile(input, audio, { mode: 0o600, signal });
    return await runVoiceProcess(config, input, path.join(directory, 'unused'), signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function collectLocalConsistency(
  surface: 'native' | 'transcriber', audio: Uint8Array, config: VoiceConfiguration,
): Promise<ConsistencyOutcome> {
  const result: ConsistencyOutcome = {
    text: null, failure: null, seconds: 0, status: null, apiElapsedMs: null,
    stdoutBase64: null, stdoutSha256: null,
  };
  const started = performance.now();
  try {
    const signal = AbortSignal.timeout(120000);
    if (surface === 'native') {
      const raw = await nativeBytes(audio, config, signal);
      result.text = decodeVoiceText(raw);
      result.stdoutBase64 = raw.toString('base64');
      result.stdoutSha256 = createHash('sha256').update(raw).digest('hex');
    } else {
      result.text = await transcribeVoice(audio, config, signal);
    }
  } catch (error) {
    if (error instanceof VoiceError && error.code !== 'voice_not_configured') result.failure = error.code;
    else if (error instanceof Error && error.name === 'TimeoutError') result.failure = 'voice_timeout';
    else throw error;
  }
  result.seconds = (performance.now() - started) / 1000;
  return result;
}
