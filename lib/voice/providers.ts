import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { VoiceError } from './audio';
import type { VoiceConfiguration } from './configuration';

export const MAX_VOICE_TEXT_BYTES = 32_768;

export function voiceCommand(config: VoiceConfiguration, input: string, output: string) {
  const limits = config.resourcePolicy === 'legacy-low-memory' ? ['--as=1073741824', '--cpu=120'] : [];
  const modelArgs = config.provider === 'sensevoice-gguf'
    ? ['-m', config.model, '-a', input, '--threads', String(config.threads), '--backend', 'cpu']
    : ['-m', config.model, '-f', input, '-of', output, '-otxt', '-l', 'auto',
      '-t', String(config.threads), '-p', '1', '-bs', '1', '-bo', '1', '-nt', '-np', '-ng'];
  return {
    command: '/usr/bin/nice',
    args: ['-n', '10', '/usr/bin/prlimit', ...limits, '--core=0', '--', config.binary, ...modelArgs],
  };
}

export function decodeVoiceText(bytes: Uint8Array): string {
  if (bytes.length > MAX_VOICE_TEXT_BYTES) throw new VoiceError('voice_invalid_result', 502);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); }
  catch { throw new VoiceError('voice_invalid_result', 502); }
  if (text.includes('\0')) throw new VoiceError('voice_invalid_result', 502);
  if (!text) throw new VoiceError('voice_no_speech', 422);
  return text;
}

export async function readWhisperOutput(file: string, signal: AbortSignal): Promise<string> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_VOICE_TEXT_BYTES) throw new VoiceError('voice_invalid_result', 502);
      const bytes = Buffer.alloc(MAX_VOICE_TEXT_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      signal.throwIfAborted();
      return decodeVoiceText(bytes.subarray(0, offset));
    } finally { await handle.close(); }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof VoiceError) throw error;
    throw new VoiceError('voice_invalid_result', 502);
  }
}
