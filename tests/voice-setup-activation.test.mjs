import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { assertWindowsOverrides, windowsSetupContext } from '../scripts/voice/windows/setup-context.mjs';
import { atomicWrite, decodeEnvironment } from '../scripts/voice/configuration-files.mjs';

test('Windows overrides are case insensitive and never print their values', () => {
  assert.throws(() => assertWindowsOverrides({
    machine: { voice_enabled: 'secret-value' }, user: {}, volatile: {},
  }, 'disabled'), error => /machine/.test(error.message) && !/secret-value/.test(error.message));
  assert.doesNotThrow(() => assertWindowsOverrides({
    machine: {}, user: { VOICE_ENABLED: '0' }, volatile: {},
  }, 'disabled'));
  assert.throws(() => assertWindowsOverrides({
    machine: {}, user: { VOICE_MODEL_PATH: 'old' }, volatile: {},
  }, 'sensevoice-small-q8'), /user/);
});

test('Windows deploy preserves identity, re-enters updates and recovers activation without touching real tasks', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-deploy \u8bed\u97f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const scenario of ['keep', 'disable', 'recover', 'tamper', 'no-wait', 'reentry', 'menu']) {
    const project = path.join(root, scenario);
    await mkdir(path.join(project, 'scripts'), { recursive: true });
    for (const file of ['voice', 'configure-voice.mjs', 'deploy.ps1']) {
      await cp(path.join('scripts', file), path.join(project, 'scripts', file), { recursive: true });
    }
    await writeFile(path.join(project, '.env.local'), 'OTHER="\u4e2d\u6587"\r\nVOICE_ENABLED=1\r\n');
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve('tests/voice-setup-deploy.ps1'), '-ProjectDir', project, '-Scenario', scenario,
    ], { encoding: 'utf8', timeout: 45000 });
    assert.equal(result.status, 0, `${scenario}: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Windows deployment scenario passed/);
  }
});

test('startup URL writes preserve Unicode voice configuration and no-op bytes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice url \u8bed\u97f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.env.local');
  const text = 'OTHER="\u4e2d\u6587"\r\nVOICE_MODEL_PATH="C:/\u8bed\u97f3/model.gguf"\r\nNEXTAUTH_URL=http://old\r\n';
  for (const bytes of [
    Buffer.from(text), Buffer.from('\ufeff' + text),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
  ]) {
    await writeFile(file, bytes);
    const invoke = url => spawnSync(process.execPath, [
      'scripts/voice/windows/environment-url.mjs', file, url,
    ], { encoding: 'utf8' });
    assert.equal(invoke('http://old').status, 0);
    assert.deepEqual(await readFile(file), bytes);
    assert.notEqual(invoke('http://bad\nVOICE_ENABLED=1').status, 0);
    assert.deepEqual(await readFile(file), bytes);
    const result = invoke('https://new.example');
    assert.equal(result.status, 0, result.stderr);
    const updated = decodeEnvironment(await readFile(file));
    assert.match(updated, /VOICE_MODEL_PATH="C:\/\u8bed\u97f3\/model.gguf"/);
    assert.match(updated, /NEXTAUTH_URL=https:\/\/new.example/);
    assert.match(updated, /OTHER="\u4e2d\u6587"/);
  }
});

test('Windows setup resolves identity; keep never probes an unavailable service user', {
  skip: process.platform !== 'win32',
}, async t => {
  const context = await windowsSetupContext();
  assert.equal(context.currentSid, context.serviceSid);
  assert.match(context.serviceSid, /^S-1-/);
  const root = await mkdtemp(path.join(tmpdir(), 'voice context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = Buffer.from('VOICE_ENABLED=0\nOTHER=preserved\n');
  const file = path.join(root, '.env.local');
  await writeFile(file, original);
  const result = spawnSync(process.execPath, [
    'scripts/configure-voice.mjs', '--project-dir', root, '--model', 'keep',
    '--service-user', 'no-such-voice-account',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(file), original);
  await assert.rejects(windowsSetupContext('no-such-voice-account'));
});

test('Windows grants target service read access without granting it receipt access', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice service acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.env.local');
  const receipt = path.join(root, 'receipt.json');
  await atomicWrite(file, Buffer.from('VOICE_ENABLED=0\n'), null, 'S-1-5-19');
  await atomicWrite(receipt, Buffer.from('{}'));
  const system = process.env.SystemRoot;
  const result = spawnSync(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; foreach ($file in @($env:ACL_FILE,$env:ACL_RECEIPT)) { ' +
    '$acl=[IO.File]::GetAccessControl($file); $rights=0; ' +
    'foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { ' +
    'if ($rule.IdentityReference.Value -eq "S-1-5-19") { $rights=$rights -bor [int]$rule.FileSystemRights } }; ' +
    '[Console]::WriteLine($rights) }',
  ], { encoding: 'utf8', timeout: 10000, env: { SystemRoot: system, WINDIR: system, ACL_FILE: file, ACL_RECEIPT: receipt } });
  assert.equal(result.status, 0, result.stderr);
  const [fileRights, receiptRights] = result.stdout.trim().split(/\r?\n/).map(Number);
  assert.equal(fileRights & 131241, 131241);
  assert.equal(fileRights & (2 | 4 | 65536 | 262144), 0);
  assert.equal(receiptRights, 0);
});
