import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileDigest, realDirectory, relativeSnapshotPath } from './snapshot-files.mjs';

export async function copySnapshotFiles({ project, destination, entries, signal, onProgress }) {
  signal?.throwIfAborted();
  let completed = 0;
  const interval = Math.max(1, Math.ceil(entries.length / 4));
  onProgress?.({ phase: 'snapshot-copy-files', completed, total: entries.length });
  const copy = async entry => {
    signal?.throwIfAborted();
    relativeSnapshotPath(entry.path);
    const from = path.join(project, entry.path);
    const to = path.join(destination, entry.path);
    await realDirectory(path.dirname(from));
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) {
      throw new Error('Snapshot source changed during copying.');
    }
    signal?.throwIfAborted();
    await pipeline(
      createReadStream(from, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }),
      createWriteStream(to, { flags: 'wx', mode: 0o600, flush: true }), { signal },
    );
    entry.sha256 = await fileDigest(to, { signal });
    if (entry.sha256 !== await fileDigest(from, { signal })) throw new Error('Snapshot source checksum changed during copying.');
    completed++;
    if (completed === entries.length || completed % interval === 0) {
      onProgress?.({ phase: 'snapshot-copy-files', completed, total: entries.length });
    }
  };
  for (let offset = 0; offset < entries.length; offset += 4) {
    // Keep all writers inside the retained source scope, including after a peer fails.
    const results = await Promise.allSettled(entries.slice(offset, offset + 4).map(copy));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Snapshot file copies failed or were aborted.');
    signal?.throwIfAborted();
  }
}
