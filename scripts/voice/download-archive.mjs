import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const maxBytes = 512 * 1024 ** 2;
export function validateEntry(entry, seen) {
  const name = entry.fileName;
  const directory = typeof name === 'string' && name.endsWith('/');
  const relative = directory ? name.slice(0, -1) : name;
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f]/.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..'
      || /[. ]$/.test(part) || /[<>"|?*]/.test(part)
      || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))
    || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
    || entry.uncompressedSize > maxBytes || (directory && entry.uncompressedSize !== 0)
    || (entry.generalPurposeBitFlag & 1)) throw new Error('Unsafe voice archive entry.');
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (mode && mode !== (directory ? 0o040000 : 0o100000)) throw new Error('Unsafe voice archive file type.');
  const key = relative.toLowerCase();
  if (seen.has(key) || seen.has(key + '/')
    || (!directory && [...seen].some(value => value.startsWith(key + '/')))) {
    throw new Error('Conflicting voice archive entry.');
  }
  const parts = key.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (seen.has(parts.slice(0, i).join('/'))) throw new Error('Conflicting voice archive parent.');
  }
  seen.add(key + (directory ? '/' : ''));
  return { relative, directory };
}

export async function extractArchive(archive, destination) {
  if (!(await lstat(destination)).isDirectory() || (await readdir(destination)).length) {
    throw new Error('Voice archive requires an empty ordinary staging directory.');
  }
  const zip = await new Promise((resolve, reject) => yauzl.open(archive,
    { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
    (error, value) => error ? reject(error) : resolve(value)));
  let fatal, active;
  zip.on('error', error => { fatal = error; active?.destroy(error); });
  const next = () => new Promise((resolve, reject) => {
    const clean = () => { zip.off('entry', entry); zip.off('end', end); zip.off('error', error); };
    const entry = value => { clean(); resolve(value); };
    const end = () => { clean(); resolve(null); };
    const error = value => { clean(); reject(value); };
    zip.once('entry', entry); zip.once('end', end); zip.once('error', error);
    zip.readEntry();
  });
  let count = 0, total = 0;
  const seen = new Set();
  try {
    if (zip.entryCount > 4096) throw new Error('Voice archive has too many entries.');
    for (;;) {
      if (fatal) throw fatal;
      const entry = await next();
      if (!entry) break;
      if (++count > 4096) throw new Error('Voice archive has too many entries.');
      const { relative, directory } = validateEntry(entry, seen);
      total += entry.uncompressedSize;
      if (total > maxBytes) throw new Error('Voice archive exceeds extraction size limit.');
      const target = path.join(destination, relative);
      await mkdir(directory ? target : path.dirname(target), { recursive: true, mode: 0o700 });
      if (directory) continue;
      active = await new Promise((resolve, reject) => zip.openReadStream(entry,
        (error, stream) => error ? reject(error) : resolve(stream)));
      let bytes = 0;
      const bound = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(bytes > entry.uncompressedSize ? new Error('Voice archive byte count exceeded.') : null, chunk);
        },
      });
      await pipeline(active, bound, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      active = undefined;
      if (bytes !== entry.uncompressedSize) throw new Error('Voice archive byte count differs.');
    }
    if (fatal) throw fatal;
    if (count !== zip.entryCount) throw new Error('Voice archive entry count differs.');
  } finally { active?.destroy(); zip.close(); }
}
