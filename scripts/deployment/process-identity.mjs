import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) {
    throw new Error('Invalid deployment process ID.');
  }
  if (process.platform === 'linux') {
    let record;
    try { record = await readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const closing = record.lastIndexOf(')');
    const fields = record.slice(closing + 2).trim().split(/\s+/);
    if (closing < 0 || !/^[0-9]+$/.test(fields[19] ?? '')) {
      throw new Error('Cannot read deployment process start identity.');
    }
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!/^[a-f0-9-]{36}$/.test(boot)) throw new Error('Cannot read system boot identity.');
    return `${boot}:${pid}:${fields[19]}`;
  }
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot;
    if (typeof root !== 'string' || !path.isAbsolute(root) || /[\0\r\n]/.test(root)) {
      throw new Error('Windows process identity requires an explicit absolute SystemRoot.');
    }
    const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execute(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); ` +
      `[Console]::Write($p.StartTime.ToUniversalTime().Ticks.ToString()) } ` +
      `catch [System.ArgumentException] { [Console]::Write('missing') }`,
    ], { windowsHide: true, timeout: 30000, maxBuffer: 4096 });
    const identity = stdout.trim();
    if (identity === 'missing') return null;
    if (!/^[0-9]+$/.test(identity)) throw new Error('Cannot read Windows process start identity.');
    return `${pid}:${identity}`;
  }
  throw new Error('Unsupported deployment process identity platform.');
}
