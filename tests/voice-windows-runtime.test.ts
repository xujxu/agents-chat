import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { voiceConfiguration } from '../lib/voice/configuration';
import { transcribeVoice } from '../lib/voice/transcriber';
import { encodeVoiceWav, VoiceError } from '../lib/voice/audio';

const exec = promisify(execFile);
const audio = encodeVoiceWav(new Float32Array(16000).fill(0.2));
const requests = async () => (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();

test('Windows runtime preserves provider, privacy and cleanup contracts', { timeout: 90000 }, async t => {
  assert.equal(process.platform, 'win32');
  const root = await mkdtemp(path.join(tmpdir(), 'voice runtime \u8bed\u97f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'engine space.exe');
  const launcher = path.resolve('.data/voice-windows-build/voice-job.exe');
  const model = path.join(root, 'model');
  await copyFile('.data/voice-windows-build/voice-provider.exe', binary);
  const before = await requests();
  for (const modelId of ['sensevoice-small-q8', 'whisper-base-q5_1']) {
    const env = { VOICE_ENABLED: '1', VOICE_MODEL: modelId, VOICE_BINARY_PATH: binary,
      VOICE_LAUNCHER_PATH: launcher, VOICE_MODEL_PATH: model };
    await writeFile(model, 'valid');
    const config = await voiceConfiguration(env);
    assert.ok(config);
    process.env.VOICE_TEST_SECRET = 'must-not-reach-the-engine';
    try {
      for (const mode of ['valid', 'stderr', 'memory', 'environment']) {
        await writeFile(model, mode);
        assert.equal(await transcribeVoice(audio, config, AbortSignal.timeout(10000)), '\u4f60\u597d\uff0cvoice PoC.');
        assert.deepEqual(await requests(), before);
      }
    } finally {
      delete process.env.VOICE_TEST_SECRET;
    }
    for (const [mode, error] of [
      ['empty', 'voice_no_speech'], ['oversized', 'voice_invalid_result'],
      ['invalid', 'voice_invalid_result'], ['nul', 'voice_invalid_result'], ['fail', 'voice_inference_failed'],
      ['fail124', 'voice_inference_failed'],
      ...(modelId === 'whisper-base-q5_1' ? [
        ['missing', 'voice_invalid_result'], ['directory', 'voice_invalid_result'],
        ['reparse', 'voice_invalid_result'], ['hardlink', 'voice_invalid_result'],
      ] : []),
    ]) {
      await writeFile(model, mode);
      await assert.rejects(transcribeVoice(audio, config, AbortSignal.timeout(10000)), { message: error });
      assert.deepEqual(await requests(), before);
    }
    await assert.rejects(voiceConfiguration({ ...env, VOICE_LAUNCHER_PATH: model }), /voice_not_configured/);
    await assert.rejects(voiceConfiguration({ ...env, VOICE_MODEL_PATH: root }), /voice_not_configured/);

    await writeFile(model, 'wait');
    const controller = new AbortController();
    const pending = transcribeVoice(audio, config, controller.signal);
    const rejected = assert.rejects(pending, /voice_cancelled/);
    let directory = '';
    let descendant = 0;
    try {
      for (let attempt = 0; attempt < 200 && !descendant; attempt++) {
        for (const name of await requests()) {
          if (before.includes(name)) continue;
          try {
            descendant = Number(await readFile(path.join(tmpdir(), name, 'descendant.pid'), 'utf8'));
            directory = path.join(tmpdir(), name);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          }
        }
        if (!descendant) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(descendant > 0);
      const { stdout, stderr } = await exec('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; $acl = Get-Acl -LiteralPath $env:VOICE_TEST_DIRECTORY; ' +
        '@{ protected = $acl.AreAccessRulesProtected; ' +
        'current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' +
        'sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) ' +
        '} | ConvertTo-Json -Compress',
      ], { env: { ...process.env, VOICE_TEST_DIRECTORY: directory }, windowsHide: true, timeout: 10000 });
      assert.equal(stderr.trim(), '', 'ACL inspection must not hide PowerShell errors');
      const acl = JSON.parse(stdout) as { protected: boolean; current: string; sids: string[] };
      assert.equal(acl.protected, true);
      assert.deepEqual([...new Set(acl.sids)].sort(), ['S-1-5-18', 'S-1-5-32-544', acl.current].sort());
    } finally {
      controller.abort(new VoiceError('voice_cancelled', 499));
      await rejected;
    }
    assert.throws(() => process.kill(descendant, 0));
    assert.deepEqual(await requests(), before);
    await assert.rejects(transcribeVoice(audio, config, controller.signal), /voice_cancelled/);
    assert.deepEqual(await requests(), before);
  }
});
