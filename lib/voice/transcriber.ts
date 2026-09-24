import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../logger';
import { VoiceError } from './audio';
import { monitorVoiceMemory } from './memory';
import { legacyVoiceConfiguration, type VoiceConfiguration } from './configuration';
import { decodeVoiceText, MAX_VOICE_TEXT_BYTES, readWhisperOutput, voiceCommand } from './providers';

const logger = createLogger('voice.transcriber');
export { voiceConfiguration } from './configuration';

export async function transcribeVoice(
  audio: Uint8Array, configuration: VoiceConfiguration | { binary: string; model: string }, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const config = 'modelId' in configuration ? configuration : legacyVoiceConfiguration(configuration);
  const directory = await mkdtemp(path.join(tmpdir(), 'agents-chat-voice-'));
  const started = performance.now();
  try {
    const input = path.join(directory, 'audio.wav');
    const output = path.join(directory, 'transcript');
    await writeFile(input, audio, { mode: 0o600, signal });
    signal.throwIfAborted();
    const stdout = await new Promise<Buffer>((resolve, reject) => {
      const command = voiceCommand(config, input, output);
      const child = spawn(command.command, command.args, {
        detached: true,
        stdio: ['ignore', config.provider === 'sensevoice-gguf' ? 'pipe' : 'ignore', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production' },
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: VoiceError | undefined;
      const terminate = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
          failure ??= new VoiceError('voice_process_failed', 503);
          logger.warn({ code: 'voice_process_failed' }, 'Voice process-group termination failed');
        }
      };
      const fail = (error: VoiceError) => { failure ??= error; terminate(); };
      const stopMonitoring = config.resourcePolicy === 'legacy-low-memory' && child.pid
        ? monitorVoiceMemory(child.pid, fail) : () => null;
      const timer = setTimeout(() => fail(new VoiceError('voice_timeout', 504)), 120_000);
      const abort = terminate;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout?.on('data', (chunk: Buffer) => {
        if (failure || signal.aborted) return;
        bytes += chunk.length;
        if (bytes > MAX_VOICE_TEXT_BYTES) fail(new VoiceError('voice_invalid_result', 502));
        else chunks.push(chunk);
      });
      child.stdout?.once('error', () => fail(new VoiceError('voice_process_failed', 503)));
      child.once('exit', terminate);
      child.once('error', () => {
        fail(new VoiceError('voice_process_failed', 503));
      });
      child.once('close', (code, exitSignal) => {
        clearTimeout(timer);
        const sampledPeakRssKiB = stopMonitoring();
        signal.removeEventListener('abort', abort);
        logger.info({ elapsedMs: Math.round(performance.now() - started), exitCode: code, signal: exitSignal, sampledPeakRssKiB }, 'Voice inference finished');
        if (signal.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0) reject(new VoiceError('voice_inference_failed', 502));
        else resolve(Buffer.concat(chunks));
      });
    });
    signal.throwIfAborted();
    return config.provider === 'sensevoice-gguf'
      ? decodeVoiceText(stdout) : await readWhisperOutput(`${output}.txt`, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
