import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function assertWindowsRestoredProjectBytes(project, backup) {
  await assert.rejects(lstat(path.join(project, 'deployment-live-target.txt')), { code: 'ENOENT' });
  for (const name of ['.env.local', '.next/BUILD_ID', 'package-lock.json',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node']) {
    assert.deepEqual(await readFile(path.join(project, name)), await readFile(path.join(backup, 'files', name)));
  }
}
