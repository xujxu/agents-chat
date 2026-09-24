import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atomicWrite, decodeEnvironment, optionalRead, previousReceiptBytes } from '../scripts/voice/configuration-files.mjs';
import { updateVoiceEnvironment, voiceValues } from '../scripts/voice/setup-config.mjs';

const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'home', 'systemroot', 'windir', 'temp', 'tmp'].includes(key.toLowerCase())));
const invoke = (root, ...args) => spawnSync(process.execPath, [
  'scripts/configure-voice.mjs', '--project-dir', root, ...args,
], { encoding: 'utf8', env: childEnv });

test('strict environment decoding accepts UTF8/BOM/UTF16LE and refuses malformed bytes', () => {
  const text = 'OTHER=\u4e2d\u6587\r\nVOICE_ENABLED=1\r\n';
  for (const bytes of [
    Buffer.from(text), Buffer.from('\ufeff' + text),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
  ]) assert.equal(decodeEnvironment(bytes), text);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xff, 0xfe, 0x61]), Buffer.from('NUL=\0')]) {
    assert.throws(() => decodeEnvironment(bytes), /encoding/);
  }
  assert.throws(() => previousReceiptBytes({ version: 2, previous: 'not!base64' }), /encoding/);
  assert.throws(() => previousReceiptBytes({ version: 3, previous: null }), /version/);
});

test('launcher keys and Windows paths round trip without escaped backslashes', () => {
  const next = updateVoiceEnvironment('VOICE_LAUNCHER_PATH=old\nOTHER=unchanged\n', 'sensevoice-small-q8', {
    binary: 'C:\\voice folder\\engine.exe', launcher: 'C:\\voice folder\\voice-job.exe',
    model: 'C:\\voice folder\\model.gguf', threads: 2,
  });
  assert.match(next, /VOICE_LAUNCHER_PATH="C:\/voice folder\/voice-job.exe"/);
  assert.equal(voiceValues(next).VOICE_MODEL_PATH, 'C:/voice folder/model.gguf');
  assert.doesNotMatch(updateVoiceEnvironment(next, 'disabled'), /LAUNCHER_PATH/);
  assert.match(updateVoiceEnvironment(next, 'disabled'), /OTHER=unchanged/);
});

test('keep and rollback preserve exact bytes; receipts refuse later edits and accept legacy format', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice config \u8bed\u97f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.env.local');
  const receipt = path.join(root, 'receipt.json');
  const text = 'OTHER="\u4e2d\u6587-secret"\r\nVOICE_ENABLED=1\r\nVOICE_LAUNCHER_PATH=old\r\n';
  for (const original of [
    Buffer.from(text), Buffer.from('\ufeff' + text),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
  ]) {
    await writeFile(file, original);
    let result = invoke(root, '--non-interactive');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(file), original);
    result = invoke(root, '--model', 'disabled', '--receipt', receipt);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /secret/);
    assert.equal(decodeEnvironment(await readFile(file)), 'OTHER="\u4e2d\u6587-secret"\nVOICE_ENABLED=0\n');
    result = invoke(root, '--rollback-receipt', receipt);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(file), original);
  }
  assert.equal(invoke(root, '--model', 'disabled', '--receipt', receipt).status, 0);
  await writeFile(file, 'VOICE_ENABLED=0\nEDIT=admin\n');
  assert.notEqual(invoke(root, '--rollback-receipt', receipt).status, 0);
  assert.match(await readFile(file, 'utf8'), /EDIT=admin/);
  const installedSha = createHash('sha256').update(await readFile(file)).digest('hex');
  await writeFile(receipt, JSON.stringify({ changed: true, file, installedSha, previous: text }));
  assert.equal(invoke(root, '--rollback-receipt', receipt).status, 0);
  assert.deepEqual(await readFile(file), Buffer.from(text));
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.voice-private-')));
});

test('private writes clean failed replacements and reject linked configuration reads', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  await mkdir(target);
  await assert.rejects(atomicWrite(target, Buffer.from('secret')));
  assert.deepEqual(await readdir(root), ['target']);
  const original = path.join(root, 'original');
  await writeFile(original, 'unchanged');
  await assert.rejects(atomicWrite(original, Buffer.from('replace'), Buffer.from('stale')), /changed during setup/);
  assert.equal(await readFile(original, 'utf8'), 'unchanged');
  const linked = path.join(root, 'linked');
  await symlink(original, linked);
  await assert.rejects(optionalRead(linked), /regular single-link/);
  await assert.rejects(atomicWrite(linked, Buffer.from('replace')), /regular single-link/);
  assert.equal(await readFile(original, 'utf8'), 'unchanged');
  const file = path.join(root, '.env.local');
  await writeFile(file, 'VOICE_ENABLED=1\n');
  assert.notEqual(invoke(root, '--model', 'keep', '--receipt', file).status, 0);
  assert.equal(await readFile(file, 'utf8'), 'VOICE_ENABLED=1\n');
});

test('Windows installed environment and recovery receipts have only private ACL grants', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice acl \u8bed\u97f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.env.local');
  const receipt = path.join(root, 'receipt.json');
  await writeFile(file, 'OTHER=private\nVOICE_ENABLED=1\n');
  const result = invoke(root, '--model', 'disabled', '--receipt', receipt);
  assert.equal(result.status, 0, result.stderr);
  for (const target of [file, receipt]) {
    const probe = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $acl=[System.IO.File]::GetAccessControl($env:ACL_TARGET); ' +
      '[Console]::WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value); ' +
      'foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { ' +
      '[Console]::WriteLine(("{0}|{1}|{2}" -f $rule.IdentityReference.Value,$rule.AccessControlType,[int]$rule.FileSystemRights)) }',
    ], { encoding: 'utf8', timeout: 10000, env: { ...childEnv, ACL_TARGET: target } });
    assert.equal(probe.status, 0, probe.stderr);
    const [current, ...rules] = probe.stdout.trim().split(/\r?\n/);
    const expected = new Set([current, 'S-1-5-18', 'S-1-5-32-544']);
    assert.deepEqual(new Set(rules.map(rule => rule.split('|')[0])), expected);
    assert.ok(rules.every(rule => rule.endsWith('|Allow|2032127')));
  }
});
