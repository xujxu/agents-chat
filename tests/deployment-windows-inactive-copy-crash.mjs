import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import streams, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

export function armWindowsInactiveCopyCrash({ project, control, snapshot, scope, actorIdentity }) {
  const files = snapshot.entries.filter(entry => entry.kind === 'file');
  assert.ok(files.length > 1, 'Copy interruption requires an early and a later snapshot file');
  assert.ok(actorIdentity);
  const copied = path.join(project, files[0].path);
  const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const original = streams.createWriteStream;
  streams.createWriteStream = (file, options) => {
    const stream = original(file, options);
    if (file === copied) {
      stream.once('finish', () => {
        writeFileSync(path.join(control, 'inactive-copy-crash-fixture.json'), JSON.stringify({
          version: 1, phase: 'project-file-copy', pid: process.pid, processIdentity: actorIdentity,
          bridge: scope.identity, copiedPath: files[0].path, pendingPath: files.at(-1).path,
          stateSha256: scope.observation.stateSha256,
          snapshotSha256: digest(path.join(control, 'backup', 'manifest.json')),
          releaseSha256: digest(path.join(control, 'inactive-rollback-runtime-released.json')),
        }), { flag: 'wx', mode: 0o600 });
        process.kill(process.pid, 'SIGKILL');
        throw new Error('Co-located project copy crash did not terminate the original actor.');
      });
    }
    return stream;
  };
  syncBuiltinESMExports();
  return Object.freeze({
    close() {
      streams.createWriteStream = original;
      syncBuiltinESMExports();
    },
  });
}
