import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_DIAGNOSTIC_BYTES, type ViewportDiagnosticLog } from './viewportDiagnostics.ts';
import type { MinimalViewportLog } from './viewportReproduction/schema.ts';

type StoredViewportDiagnostic = ViewportDiagnosticLog | MinimalViewportLog;

export class DiagnosticError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readDiagnosticBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new DiagnosticError(400, 'invalid_json', 'A JSON diagnostic log is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_DIAGNOSTIC_BYTES) {
        await reader.cancel();
        throw new DiagnosticError(413, 'too_large', 'Diagnostic log exceeds 256 KiB.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new DiagnosticError(400, 'invalid_json', 'Diagnostic log must be valid UTF-8 JSON.');
  }
}

const LOG_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
let pending: Promise<unknown> = Promise.resolve();

async function privateDirectory(root: string): Promise<string> {
  let directory = root;
  for (const segment of ['.data', 'tmp', 'viewport-diagnostics']) {
    directory = path.join(directory, segment);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe diagnostic directory.');
    if (segment === 'viewport-diagnostics' && (info.mode & 0o077) !== 0) {
      throw new Error('Diagnostic directory is not private.');
    }
  }
  return directory;
}

async function store(log: StoredViewportDiagnostic, root: string): Promise<string> {
  const directory = await privateDirectory(root);
  const now = Date.now();
  let count = 0;
  for (const name of await readdir(directory)) {
    if (!LOG_NAME.test(name)) continue;
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (info.isFile() && now - info.mtimeMs > 7 * 86400_000) await unlink(file);
    else count++;
  }
  if (count >= 100) throw new DiagnosticError(507, 'storage_full', 'Diagnostic storage is full. Ask the administrator to remove old logs.');
  const serverBuildId = (await readFile(path.join(root, '.next', 'BUILD_ID'), 'utf8')).trim();
  const id = randomUUID();
  const file = path.join(directory, `${id}.json`);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify({ receivedAt: new Date(now).toISOString(), serverBuildId, log }));
    } finally {
      await handle.close();
    }
  } catch (error) {
    await unlink(file);
    throw error;
  }
  return id;
}

export function storeViewportDiagnostic(log: StoredViewportDiagnostic, root = process.cwd()): Promise<string> {
  const result = pending.then(() => store(log, root));
  // Recover the queue, not the caller's result: rejected writes still reach the route.
  pending = result.then(() => undefined, () => undefined);
  return result;
}
