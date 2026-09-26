import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

assert.equal(process.platform, 'win32');
const artifacts = path.resolve('.data/voice-windows-build');
await mkdir(artifacts, { recursive: true });
const model = path.join(artifacts, 'fixture-model');
await writeFile(model, 'valid');
const initialDirectories = (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();
const environment = {
  ...process.env,
  VOICE_LAUNCHER_PATH: path.join(artifacts, 'voice-job.exe'),
  VOICE_BINARY_PATH: path.join(artifacts, 'voice-provider.exe'),
  VOICE_MODEL_PATH: model, VOICE_RESOURCE_POLICY: 'standard',
  VOICE_EXPECT_POLICY: 'standard', VOICE_API_FIXTURE: '1',
  VOICE_CLEANUP_DIAGNOSTICS: '1',
};

function closed(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

for (const mode of ['sense', 'whisper', 'invalid', 'disabled']) {
  const env = {
    ...environment,
    VOICE_ENABLED: mode === 'disabled' ? '0' : '1',
    VOICE_MODEL: mode === 'whisper' ? 'whisper-base-q5_1' : mode === 'invalid' ? 'invalid' : 'sensevoice-small-q8',
    VOICE_EXPECT_MODEL: mode === 'whisper' ? 'base-q5_1' : 'sensevoice-small-q8',
    VOICE_EXPECT_INVALID: mode === 'invalid' ? '1' : '0',
    VOICE_EXPECT_DISABLED: mode === 'disabled' ? '1' : '0',
  };
  const log = await open(path.join(artifacts, `${mode}-server.log`), 'w');
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3011'], {
    env, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  });
  const serverDone = closed(server);
  void serverDone.catch(() => {});
  try {
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (server.exitCode !== null) throw new Error(`Server exited during ${mode} startup`);
      try {
        const response = await fetch('http://localhost:3011/api/auth/providers', { signal: AbortSignal.timeout(2000) });
        if (response.ok) { ready = true; break; }
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(ready, `${mode} app readiness failed`);
    const specs = mode === 'invalid' ? ['tests/voice-providers-api.spec.ts']
      : mode === 'disabled' ? ['tests/voice-disabled.spec.ts']
        : ['tests/voice-api.spec.ts', 'tests/voice-input.spec.ts'];
    const tests = spawn(process.execPath, [
      'node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.config.ts',
      ...specs, '--project=desktop-chromium', '--workers=1', '--max-failures=2', '--reporter=line',
      '--timeout=45000', '--global-timeout=300000', '--trace=retain-on-failure',
      `--output=${path.join(artifacts, `${mode}-tests`)}`,
    ], { env, windowsHide: true, stdio: 'inherit' });
    assert.equal(await closed(tests), 0, `${mode} API/browser regressions failed`);
  } finally {
    if (server.exitCode === null) server.kill('SIGKILL');
    await serverDone;
    await log.close();
  }
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort(),
    initialDirectories, `${mode} leaked request directories`);
}
