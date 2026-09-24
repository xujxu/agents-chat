import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceError } from './audio';
import { legacyVoiceConfiguration, type VoiceConfiguration } from './configuration';
import { decodeVoiceText, readWhisperOutput } from './providers';
import { runVoiceProcess } from './process';
import { createWindowsVoiceDirectory, readWindowsVoiceOutput } from './windowsNative';

export { voiceConfiguration } from './configuration';

export async function transcribeVoice(
  audio: Uint8Array, configuration: VoiceConfiguration | { binary: string; model: string }, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const config = 'modelId' in configuration ? configuration : legacyVoiceConfiguration(configuration);
  if (config.platform === 'win32' && !config.launcher) throw new VoiceError('voice_not_configured', 503);
  const directory = config.platform === 'win32' && config.launcher
    ? await createWindowsVoiceDirectory(config.launcher)
    : await mkdtemp(path.join(tmpdir(), 'agents-chat-voice-'));
  try {
    signal.throwIfAborted();
    const input = path.join(directory, 'audio.wav');
    const output = path.join(directory, 'transcript');
    await writeFile(input, audio, { mode: 0o600, signal });
    const stdout = await runVoiceProcess(config, input, output, signal);
    signal.throwIfAborted();
    if (config.provider === 'sensevoice-gguf') return decodeVoiceText(stdout);
    if (config.platform === 'win32' && config.launcher) {
      return decodeVoiceText(await readWindowsVoiceOutput(config.launcher, `${output}.txt`, signal));
    }
    return await readWhisperOutput(`${output}.txt`, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
