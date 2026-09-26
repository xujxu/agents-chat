import { spawn } from 'node:child_process';
import path from 'node:path';
import { createLogger } from '../logger';
import { VoiceError } from './audio';
import type { VoiceConfiguration } from './configuration';
import { monitorVoiceMemory } from './memory';
import { MAX_VOICE_TEXT_BYTES, voiceCommand } from './providers';
import { windowsVoiceEnvironment } from './windowsNative';

const logger = createLogger('voice.transcriber');

export function runVoiceProcess(
  config: VoiceConfiguration, input: string, output: string, signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const started = performance.now();
  return new Promise<Buffer>((resolve, reject) => {
    const command = voiceCommand(config, input, output);
    const windows = config.platform === 'win32';
    const child = spawn(command.command, command.args, {
      detached: !windows, windowsHide: true,
      stdio: [windows ? 'pipe' : 'ignore', config.provider === 'sensevoice-gguf' ? 'pipe' : 'ignore', windows ? 'pipe' : 'ignore'],
      env: windows ? windowsVoiceEnvironment(path.dirname(input))
        : { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production' },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnostic = '';
    let failure: VoiceError | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (!child.pid) return;
      if (windows) {
        if (fallback) return;
        child.stdin?.end();
        fallback = setTimeout(() => {
          failure ??= new VoiceError('voice_process_failed', 503);
          logger.warn({ code: 'voice_process_failed' }, 'Voice Job teardown exceeded its deadline');
          child.kill('SIGKILL');
        }, 6000);
        return;
      }
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
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') fail(new VoiceError('voice_process_failed', 503));
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failure || signal.aborted) return;
      bytes += chunk.length;
      if (bytes > MAX_VOICE_TEXT_BYTES) fail(new VoiceError('voice_invalid_result', 502));
      else chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (diagnostic.length + chunk.length > 256) fail(new VoiceError('voice_process_failed', 503));
      else diagnostic += chunk.toString('ascii');
    });
    child.stderr?.once('error', () => fail(new VoiceError('voice_process_failed', 503)));
    child.stdout?.once('error', () => fail(new VoiceError('voice_process_failed', 503)));
    if (!windows) child.once('exit', terminate);
    child.once('error', () => fail(new VoiceError('voice_process_failed', 503)));
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(fallback);
      const sampledPeakRssKiB = stopMonitoring();
      signal.removeEventListener('abort', terminate);
      logger.info({ elapsedMs: Math.round(performance.now() - started), exitCode: code, signal: exitSignal, sampledPeakRssKiB }, 'Voice inference finished');
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (windows && code === 124 && /^voice_job_timeout\r?\n$/.test(diagnostic)) reject(new VoiceError('voice_timeout', 504));
      else if (windows && diagnostic) reject(new VoiceError('voice_process_failed', 503));
      else if (code !== 0) reject(new VoiceError('voice_inference_failed', 502));
      else resolve(Buffer.concat(chunks));
    });
  });
}
