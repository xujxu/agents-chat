import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function decodeEnvironment(bytes) {
  if (bytes === null) return '';
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  try {
    const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('NUL');
    return text;
  } catch { throw new Error('Unsupported environment encoding; expected UTF-8 or BOM-marked UTF-16LE.'); }
}

export function encodeEnvironment(text) {
  return Buffer.from((process.platform === 'win32' ? '\ufeff' : '') + text, 'utf8');
}

async function checkFile(file) {
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error('Configuration must be a regular single-link file.');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function optionalRead(file) {
  return await checkFile(file) ? readFile(file) : null;
}

export async function atomicWrite(file, bytes) {
  await checkFile(file);
  let directory;
  let temp;
  try {
    if (process.platform === 'win32') {
      const root = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
      if (!root || !/^[a-z]:[\\/]/i.test(root)) throw new Error('Windows SystemRoot is unavailable.');
      directory = path.join(path.dirname(file), `.voice-private-${randomUUID()}`);
      const script = fileURLToPath(new URL('./windows/private-directory.ps1', import.meta.url));
      await execute(path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      ], {
        windowsHide: true, timeout: 10000, maxBuffer: 16384,
        env: { SystemRoot: root, WINDIR: root, PATH: path.join(root, 'System32'), VOICE_PRIVATE_DIRECTORY: directory },
      });
      temp = path.join(directory, 'configuration.tmp');
    } else temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await checkFile(file);
    await rename(temp, file);
  } finally {
    if (temp) await rm(temp, { force: true });
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function previousReceiptBytes(receipt) {
  if (receipt.version !== undefined && receipt.version !== 2) throw new Error('Unsupported recovery receipt version.');
  if (receipt.previous === null) return null;
  if (typeof receipt.previous !== 'string') throw new Error('Invalid recovery receipt.');
  if (receipt.version === undefined) return Buffer.from(receipt.previous, 'utf8');
  const bytes = Buffer.from(receipt.previous, 'base64');
  if (bytes.toString('base64') !== receipt.previous) throw new Error('Invalid recovery receipt encoding.');
  return bytes;
}
