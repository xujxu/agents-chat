import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { VoiceError } from './audio';

const execute = promisify(execFile);

export function windowsVoiceEnvironment(directory: string): NodeJS.ProcessEnv {
  const root = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  if (!root || !path.win32.isAbsolute(root)) throw new VoiceError('voice_not_configured', 503);
  return {
    SystemRoot: root, WINDIR: root, PATH: `${path.win32.join(root, 'System32')};${root}`,
    TEMP: directory, TMP: directory, NODE_ENV: 'production',
  };
}

export async function createWindowsVoiceDirectory(launcher: string): Promise<string> {
  const directory = path.join(tmpdir(), `agents-chat-voice-${randomUUID()}`);
  try {
    await execute(launcher, ['--create-directory', directory], {
      windowsHide: true, encoding: 'buffer', timeout: 10000, maxBuffer: 32768,
      env: windowsVoiceEnvironment(tmpdir()),
    });
    return directory;
  } catch {
    throw new VoiceError('voice_process_failed', 503);
  }
}

export async function readWindowsVoiceOutput(
  launcher: string, file: string, signal: AbortSignal,
): Promise<Buffer> {
  try {
    signal.throwIfAborted();
    const { stdout } = await execute(launcher, ['--read-output', file], {
      windowsHide: true, encoding: 'buffer', timeout: 10000, maxBuffer: 32768, signal,
      env: windowsVoiceEnvironment(path.dirname(file)),
    });
    signal.throwIfAborted();
    return stdout;
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new VoiceError('voice_invalid_result', 502);
  }
}
