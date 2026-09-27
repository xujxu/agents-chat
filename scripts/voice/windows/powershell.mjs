import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function runWindowsSetupScript(script, variables = {}) {
  const root = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  if (process.platform !== 'win32' || !root || !/^[a-z]:[\\/]/i.test(root)) {
    throw new Error('Native Windows setup and SystemRoot are required.');
  }
  const invocation = execute(path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL(script, import.meta.url)),
  ], {
    windowsHide: true, timeout: 10000, maxBuffer: 32768, encoding: 'utf8',
    env: { SystemRoot: root, WINDIR: root, PATH: path.join(root, 'System32'), ...variables },
  });
  invocation.child.stdin.end();
  try { return (await invocation).stdout; }
  catch (error) {
    if (error.killed) throw new Error('Windows setup helper exceeded its 10-second deadline.');
    throw error;
  }
}
