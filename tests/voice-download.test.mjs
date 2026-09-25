import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { catalogue, selectDownload, validateArtifact } from '../scripts/voice/download-catalog.mjs';
import { validateEntry } from '../scripts/voice/download-archive.mjs';

const now = Date.parse('2026-09-25T12:00:00Z');
function metadata(entry) {
  return { id: entry.artifact, name: entry.name, expired: false,
    expires_at: '2026-10-24T00:00:00Z', size_in_bytes: entry.bytes, digest: `sha256:${entry.archiveSha256}`,
    workflow_run: { id: entry.run, head_sha: entry.commit, repository_id: 1260147964, head_repository_id: 1260147964 } };
}
test('only pinned Sense x64 candidates can be acquired', () => {
  for (const host of ['linux', 'win32']) {
    const entry = selectDownload('sensevoice-small-q8', host, 'x64');
    assert.equal(entry, catalogue[host]);
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(validateArtifact(metadata(entry), entry, now).id, entry.artifact);
  }
  for (const args of [
    ['whisper-base-q5_1', 'linux', 'x64'], ['sensevoice-small-q8', 'darwin', 'x64'],
    ['sensevoice-small-q8', 'win32', 'arm64'], ['sensevoice-small-q8', 'toString', 'x64'],
  ]) assert.throws(() => selectDownload(...args), /experimental/i);
});
test('metadata rejects each changed identity, expiry, size and digest', () => {
  for (const entry of Object.values(catalogue)) {
    for (const fields of [
      { id: 1 }, { name: 'other' }, { expired: true }, { expired: undefined },
      { expires_at: 'invalid' }, { expires_at: new Date(now).toISOString() },
      { digest: 'sha256:' + '0'.repeat(64) }, { size_in_bytes: 0 },
      { size_in_bytes: entry.bytes + 1 }, { size_in_bytes: 600 * 1024 ** 2 },
    ]) assert.throws(() => validateArtifact({ ...metadata(entry), ...fields }, entry, now), /artifact/i);
    for (const fields of [
      { id: 1 }, { head_sha: '0'.repeat(40) }, { repository_id: 1 }, { head_repository_id: 1 },
    ]) {
      const candidate = metadata(entry);
      Object.assign(candidate.workflow_run, fields);
      assert.throws(() => validateArtifact(candidate, entry, now), /artifact/i);
    }
    for (const value of [null, {}, { workflow_run: null }]) {
      assert.throws(() => validateArtifact(value, entry, now), /artifact/i);
    }
  }
});
test('ZIP entries reject unsafe portable paths, modes and collisions', () => {
  const entry = fileName => ({ fileName, uncompressedSize: 1, generalPurposeBitFlag: 0,
    externalFileAttributes: 0, versionMadeBy: 20 });
  for (const name of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'a/../b',
    'a\0b', 'CON', 'aux.txt', 'a/foo.', 'a/foo ', 'a:b', '']) {
    assert.throws(() => validateEntry(entry(name), new Set()), /archive/i, name);
  }
  const seen = new Set();
  validateEntry(entry('Bin/engine'), seen);
  for (const name of ['bin/ENGINE', 'bin/engine/child', 'bin']) {
    assert.throws(() => validateEntry(entry(name), seen), /archive/i);
  }
  assert.throws(() => validateEntry({ ...entry('link'), externalFileAttributes: 0o120777 * 65536,
    versionMadeBy: 3 * 256 }, new Set()), /archive/i);
  assert.throws(() => validateEntry({ ...entry('encrypted'), generalPurposeBitFlag: 1 }, new Set()), /archive/i);
  assert.throws(() => validateEntry({ ...entry('large'), uncompressedSize: 600 * 1024 ** 2 }, new Set()), /archive/i);
});
test('opt-in does not acquire on keep, disable or rollback; local arguments conflict on enabling', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-download-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.env.local');
  const original = 'OTHER=preserve\nVOICE_ENABLED=1\n';
  await writeFile(file, original);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith('VOICE_') && !/^(GH_|GITHUB_)/i.test(key)));
  env.GH_CONFIG_DIR = path.join(root, 'not-authenticated');
  const invoke = (...args) => spawnSync(process.execPath, ['scripts/configure-voice.mjs',
    '--project-dir', root, '--non-interactive', '--experimental-download', ...args], { env, encoding: 'utf8' });
  assert.equal(invoke().status, 0);
  assert.equal(await readFile(file, 'utf8'), original);
  for (const args of [['--package-dir', root], ['--manifest-sha256', '0'.repeat(64)]]) {
    const result = invoke('--model', 'sensevoice-small-q8', ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot combine/i);
    assert.equal(await readFile(file, 'utf8'), original);
  }
  const receipt = path.join(root, 'receipt.json');
  const disabled = invoke('--model', 'disabled', '--receipt', receipt);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(await readFile(file, 'utf8'), 'OTHER=preserve\nVOICE_ENABLED=0\n');
  const restored = invoke('--rollback-receipt', receipt);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(await readFile(file, 'utf8'), original);
});
test('all deployment entrypoints forward the opt-in without changing defaults', async () => {
  const shell = await readFile('scripts/deploy.sh', 'utf8');
  assert.match(shell, /--voice-experimental-download\) voice_args\+=\(--experimental-download\)/);
  for (const file of ['scripts/setup.ps1', 'scripts/deploy.ps1']) {
    const content = await readFile(file, 'utf8');
    assert.match(content, /\[switch\]\$VoiceExperimentalDownload/);
    assert.match(content, /-ExperimentalDownload:\$VoiceExperimentalDownload/);
  }
  const helper = await readFile('scripts/voice/windows/configure.ps1', 'utf8');
  assert.match(helper, /if \(\$ExperimentalDownload\).*--experimental-download/);
});
