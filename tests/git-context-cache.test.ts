import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearGitContextCache, getGitContextOptions } from '../lib/gitContext';

function makeRepo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'git-ctx-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${dir.replace(/\\/g, '/')}`, ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return { dir, git };
}

test('git context reads do not block the event loop', async () => {
  const { dir } = makeRepo();
  try {
    clearGitContextCache();
    let ticked = false;
    setImmediate(() => { ticked = true; });
    const pending = getGitContextOptions(null, dir);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ticked, true);
    const options = await pending;
    assert.equal(options.available, true);
    assert.deepEqual(options.branches, ['main']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads are cached briefly while fresh reads see new branches', async () => {
  const { dir, git } = makeRepo();
  try {
    clearGitContextCache();
    const first = await getGitContextOptions(null, dir);
    first.branches.push('mutated');
    git('branch', 'feature');
    assert.deepEqual((await getGitContextOptions(null, dir)).branches, ['main']);
    assert.deepEqual((await getGitContextOptions(null, dir, { fresh: true })).branches, ['feature', 'main']);
    // A fresh read also refreshes what later cached reads return.
    assert.deepEqual((await getGitContextOptions(null, dir)).branches, ['feature', 'main']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('folders outside a repo report git as unavailable', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'no-git-'));
  try {
    clearGitContextCache();
    const options = await getGitContextOptions(null, dir);
    assert.equal(options.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
