import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../logger';
import { VoiceError } from './audio';
import { monitorVoiceMemory } from './memory';

const logger = createLogger('voice.transcriber');

export async function voiceConfiguration() {
  if (process.env.VOICE_ENABLED !== '1') return null;
  const binary = process.env.VOICE_WHISPER_PATH;
  const model = process.env.VOICE_MODEL_PATH;
  if (process.platform !== 'linux' || !binary || !model || !path.isAbsolute(binary) || !path.isAbsolute(model)) {
    throw new VoiceError('voice_not_configured', 503);
  }
  try {
    await Promise.all([access(binary, constants.X_OK), access(model, constants.R_OK), access('/usr/bin/prlimit', constants.X_OK), access('/usr/bin/nice', constants.X_OK)]);
  } catch {
    throw new VoiceError('voice_not_configured', 503);
  }
  return { binary, model };
}

export async function transcribeVoice(
  audio: Uint8Array, configuration: { binary: string; model: string }, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), 'agents-chat-voice-'));
  const started = performance.now();
  try {
    const input = path.join(directory, 'audio.wav');
    const output = path.join(directory, 'transcript');
    await writeFile(input, audio, { mode: 0o600, signal });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/nice', [
        '-n', '10', '/usr/bin/prlimit', '--as=1073741824', '--cpu=120', '--core=0', '--',
        configuration.binary, '-m', configuration.model, '-f', input, '-of', output, '-otxt',
        '-l', 'auto', '-t', '1', '-p', '1', '-bs', '1', '-bo', '1', '-nt', '-np', '-ng',
      ], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production' } });
      let memoryFailure: VoiceError | undefined;
      const stopMonitoring = child.pid ? monitorVoiceMemory(child.pid, error => {
        memoryFailure = error;
        child.kill('SIGKILL');
      }) : () => null;
      const abort = () => child.kill('SIGKILL');
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.once('error', () => {
        stopMonitoring();
        signal.removeEventListener('abort', abort);
        reject(new VoiceError('voice_process_failed', 503));
      });
      child.once('close', (code, exitSignal) => {
        const sampledPeakRssKiB = stopMonitoring();
        signal.removeEventListener('abort', abort);
        logger.info({ elapsedMs: Math.round(performance.now() - started), exitCode: code, signal: exitSignal, sampledPeakRssKiB }, 'Voice inference finished');
        if (signal.aborted) reject(signal.reason);
        else if (memoryFailure) reject(memoryFailure);
        else if (code !== 0) reject(new VoiceError('voice_inference_failed', 502));
        else resolve();
      });
    });
    signal.throwIfAborted();
    const file = `${output}.txt`;
    if ((await stat(file)).size > 32_768) throw new VoiceError('voice_invalid_result', 502);
    const text = (await readFile(file, { encoding: 'utf8', signal })).trim();
    if (!text) throw new VoiceError('voice_no_speech', 422);
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
