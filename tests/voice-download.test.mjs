import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { catalogue, selectDownload, validateArtifact } from '../scripts/voice/download-catalog.mjs';
import { extractArchive, validateEntry } from '../scripts/voice/download-archive.mjs';
import { ghToFile, withDownloadedPackage } from '../scripts/voice/download-package.mjs';
import { decodeEnvironment } from '../scripts/voice/configuration-files.mjs';

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
  assert.equal(decodeEnvironment(await readFile(file)), 'OTHER=preserve\nVOICE_ENABLED=0\n');
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

function zipBytes(files) {
  const records = [], central = [];
  let offset = 0;
  for (const { name, text = '', mode = 0 } of files) {
    const filename = Buffer.from(name), data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(3 * 256 + 20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(mode * 65536, 38); directory.writeUInt32LE(offset, 42);
    records.push(local, filename, data); central.push(directory, filename);
    offset += local.length + filename.length + data.length;
  }
  const footer = Buffer.alloc(22), index = Buffer.concat(central);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(files.length, 8); footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(index.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, index, footer]);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('verified acquisition checks gh paths, extracts before consuming and cleans success/failure staging', async () => {
  const raw = '{"fixture":true}';
  const archive = zipBytes([{ name: 'voice-package.json', text: raw }, { name: 'bin/engine', text: 'fixture' }]);
  const entry = { ...catalogue.linux, bytes: archive.length, archiveSha256: sha(archive), manifestSha256: sha(raw) };
  for (const fail of ['none', 'transfer', 'archive', 'manifest', 'consume', 'metadata']) {
    const selected = { ...entry, ...(fail === 'manifest' ? { manifestSha256: '0'.repeat(64) } : {}) };
    let root, calls = 0, consumed = false;
    const operation = withDownloadedPackage(selected, async ({ packageDir, manifestSha256 }) => {
      consumed = true;
      assert.equal(manifestSha256, selected.manifestSha256);
      assert.equal(await readFile(path.join(packageDir, 'bin/engine'), 'utf8'), 'fixture');
      if (fail === 'consume') throw new Error('Importer refused');
      return 'installed';
    }, { now, log: () => {}, transfer: async (args, output, limit, timeout) => {
      root = path.dirname(output); calls++;
      assert.deepEqual(args, ['api', `repos/xujxu/agents-chat/actions/artifacts/${entry.artifact}${calls === 2 ? '/zip' : ''}`]);
      if (calls === 1) {
        assert.equal(limit, 65536); assert.equal(timeout, 60_000);
        await writeFile(output, fail === 'metadata' ? '' : JSON.stringify(metadata(selected)));
      } else {
        assert.equal(limit, archive.length); assert.equal(timeout, 300_000);
        if (fail === 'transfer') throw new Error('Interrupted');
        await writeFile(output, fail === 'archive' ? Buffer.alloc(archive.length) : archive);
      }
    } });
    if (fail === 'none') assert.equal(await operation, 'installed');
    else await assert.rejects(operation);
    assert.equal(consumed, ['none', 'consume'].includes(fail));
    await assert.rejects(readdir(root), { code: 'ENOENT' });
  }
});
test('real ZIP reader rejects traversal, duplicate entries, links, truncation and count limits', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-download-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    zipBytes([{ name: '../escape' }]), zipBytes([{ name: 'a' }, { name: 'A' }]),
    zipBytes([{ name: 'a', text: 'target', mode: 0o120777 }]),
    zipBytes([{ name: 'a' }, { name: 'a/b' }]),
    zipBytes([{ name: 'CON.txt' }]), Buffer.from('truncated archive'),
    zipBytes(Array.from({ length: 4097 }, (_, i) => ({ name: String(i) }))),
  ];
  for (let i = 0; i < cases.length; i++) {
    const archive = path.join(root, `${i}.zip`), target = path.join(root, String(i));
    await mkdir(target); await writeFile(archive, cases[i]);
    await assert.rejects(extractArchive(archive, target));
  }
});
test('gh transfers enforce timeout, overflow, failures and sanitized errors', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-download-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source, limit, timeout, success] of [
    ['ok', 'process.stdout.write("ok")', 2, 10000, true],
    ['overflow', 'process.stdout.write("too long")', 2, 10000, false],
    ['timeout', 'setTimeout(()=>{},30000)', 2, 100, false],
    ['failed', 'process.stderr.write("secret-marker");process.exit(1)', 2, 10000, false],
    ['closed-stdout', 'process.stdout.end();setTimeout(()=>{},30000)', 2, 100, false],
  ]) {
    const invoke = ghToFile(['api', 'fixture'], path.join(root, name), limit, timeout, (command, args, options) => {
      assert.equal(command, 'gh'); assert.deepEqual(args, ['api', 'fixture']);
      return spawn(process.execPath, ['-e', source], options);
    });
    if (success) assert.equal(await invoke, 2);
    else await assert.rejects(invoke, error => !error.message.includes('secret-marker'));
  }
});
test('release bundle includes the downloader dependency closure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-download-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  for (const file of ['package-release.mjs', 'configure-voice.mjs', 'voice']) {
    await cp(path.join('scripts', file), path.join(root, 'scripts', file), { recursive: true });
  }
  await cp('package.json', path.join(root, 'package.json'));
  for (const name of ['yauzl', 'pend']) {
    await cp(path.join('node_modules', name), path.join(root, 'node_modules', name), { recursive: true });
  }
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/package-release.mjs')], {
    encoding: 'utf8', env: { ...process.env, RELEASE_TARGET: 'test' },
  });
  assert.equal(result.status, 0, result.stderr);
  const check = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import("./scripts/voice/download-archive.mjs").then(()=>console.log("ready"))'], {
    cwd: path.join(root, 'dist/release/agents-chat-test'), encoding: 'utf8',
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /ready/);
});
