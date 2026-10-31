import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { captureLinuxServiceSources } from '../scripts/deployment/linux-service-sources.mjs';

const native = { skip: process.platform !== 'linux' || process.getuid() !== 0 };

async function fixture(t) {
  const root = path.join('/run', `agents-chat-sources-${randomUUID()}`);
  await mkdir(root, { mode: 0o755 });
  const owner = await lstat(root);
  t.after(async () => {
    const current = await lstat(root);
    assert.equal(current.dev, owner.dev);
    assert.equal(current.ino, owner.ino);
    await rm(root, { recursive: true });
  });
  const file = path.join(root, 'fixture.service');
  const bytes = Buffer.from('[Service]\nRestart=no\n');
  await writeFile(file, bytes, { mode: 0o644 });
  return { root, file, bytes };
}

test('retained service sources expose original identity and reject checks after idempotent close', native, async t => {
  const f = await fixture(t);
  const captured = await captureLinuxServiceSources([f.file]);
  try {
    const info = await lstat(f.file);
    assert.deepEqual(captured.identity, [{
      path: f.file, dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
      uid: info.uid, gid: info.gid, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
    }]);
    assert.equal(Object.isFrozen(captured.identity), true);
    assert.equal(Object.isFrozen(captured.identity[0]), true);
    await captured.check();
  } finally { await captured.close(); }
  await captured.close();
  await assert.rejects(captured.check(), /closed/i);
});

for (const change of ['content', 'replacement', 'parent']) {
  test(`retained service sources refuse ${change} changes`, native, async t => {
    const f = await fixture(t);
    const captured = await captureLinuxServiceSources([f.file]);
    try {
      if (change === 'content') {
        const before = await lstat(f.file);
        await writeFile(f.file, '[Service]\nRestart=on\n');
        assert.equal((await lstat(f.file)).ino, before.ino);
      } else if (change === 'replacement') {
        await rename(f.file, `${f.file}.retained`);
        await writeFile(f.file, f.bytes);
      } else await chmod(f.root, 0o777);
      await assert.rejects(captured.check(), /changed|replaced|writable/i);
    } finally { await captured.close(); }
  });
}

for (const kind of ['symlink', 'hardlink', 'writable-parent']) {
  test(`service source capture refuses ${kind} without adopting it`, native, async t => {
    const f = await fixture(t);
    let file = f.file;
    if (kind === 'symlink') {
      file = `${f.file}.linked`;
      await symlink(f.file, file);
    } else if (kind === 'hardlink') await link(f.file, `${f.file}.linked`);
    else await chmod(f.root, 0o777);
    await assert.rejects(captureLinuxServiceSources([file]), /source (file|directory)/i);
  });
}
