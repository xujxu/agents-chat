import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { directorySnapshot, saveDiagnosticReport, recordVoiceLifecycle } from './helpers/voiceLifecycleDiagnostics.mjs';

assert.equal(process.platform, 'win32');
const artifacts = path.resolve('.data/voice-windows-build');
await mkdir(artifacts, { recursive: true });
const model = path.join(artifacts, 'fixture-model');
await writeFile(model, 'valid');
const initialDirectories = (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();
const diagnostic = process.env.VOICE_DIAGNOSTIC_ROUNDS !== undefined;
if (diagnostic) assert.equal(process.env.VOICE_DIAGNOSTIC_ROUNDS, '3');
const rounds = diagnostic ? 3 : 1;
const sampling = process.env.VOICE_CLEANUP_DIAGNOSTICS ?? '1';
assert.ok(['0', '1'].includes(sampling));
const environment = {
  ...process.env,
  VOICE_LAUNCHER_PATH: path.join(artifacts, 'voice-job.exe'),
  VOICE_BINARY_PATH: path.join(artifacts, 'voice-provider.exe'),
  VOICE_MODEL_PATH: model, VOICE_RESOURCE_POLICY: 'standard',
  VOICE_EXPECT_POLICY: 'standard', VOICE_API_FIXTURE: '1',
  VOICE_CLEANUP_DIAGNOSTICS: sampling,
};

function closed(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

for (let round = 1; round <= rounds; round++) {
  const output = diagnostic ? path.join(artifacts, `round-${round}`) : artifacts;
  await mkdir(output, { recursive: true });
  let mode = 'starting';
  let phase = 'round-start';
  const observer = diagnostic ? recordVoiceLifecycle(() => ({ round, mode, phase })) : null;
  const report = { productSha: process.env.DIAGNOSTIC_PRODUCT_SHA, harnessSha: process.env.GITHUB_SHA,
    sampling, requestedRounds: rounds, round, completedRounds: round - 1, completedModes: [],
    initialDirectories, status: 'running', postStop: [] };
  try {
  for (mode of ['sense', 'whisper', 'invalid', 'disabled']) {
  phase = 'startup';
  observer?.record('mode-start');
  const env = {
    ...environment,
    VOICE_ENABLED: mode === 'disabled' ? '0' : '1',
    VOICE_MODEL: mode === 'whisper' ? 'whisper-base-q5_1' : mode === 'invalid' ? 'invalid' : 'sensevoice-small-q8',
    VOICE_EXPECT_MODEL: mode === 'whisper' ? 'base-q5_1' : 'sensevoice-small-q8',
    VOICE_EXPECT_INVALID: mode === 'invalid' ? '1' : '0',
    VOICE_EXPECT_DISABLED: mode === 'disabled' ? '1' : '0',
  };
  const log = await open(path.join(output, `${mode}-server.log`), 'w');
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
    phase = 'tests';
    observer?.record('server-ready', { pid: server.pid });
    const specs = mode === 'invalid' ? ['tests/voice-providers-api.spec.ts']
      : mode === 'disabled' ? ['tests/voice-disabled.spec.ts']
        : ['tests/voice-api.spec.ts', 'tests/voice-input.spec.ts'];
    const tests = spawn(process.execPath, [
      'node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.config.ts',
      ...specs, '--project=desktop-chromium', '--workers=1', '--max-failures=2', '--reporter=line',
      '--timeout=45000', '--global-timeout=300000', '--trace=retain-on-failure',
      `--output=${path.join(output, `${mode}-tests`)}`,
    ], { env, windowsHide: true, stdio: 'inherit' });
    assert.equal(await closed(tests), 0, `${mode} API/browser regressions failed`);
  } finally {
    phase = 'stopping';
    observer?.record('server-stop-request', { pid: server.pid });
    if (server.exitCode === null) server.kill('SIGKILL');
    await serverDone;
    observer?.record('server-closed', { pid: server.pid });
    await log.close();
  }
  phase = 'assertion';
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort(),
    initialDirectories, `${mode} leaked request directories`);
  if (diagnostic) report.postStop.push({ mode, observedAt: new Date().toISOString(), ...await directorySnapshot(tmpdir()) });
  report.completedModes.push(mode);
  }
  report.completedRounds = round;
  report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    if (observer) {
      if (report.status === 'failed') {
        try {
          report.postStop.push({ mode, observedAt: new Date().toISOString(), ...await directorySnapshot(tmpdir()) });
        } catch (error) {
          report.snapshotError = { code: error.code ?? error.name };
        }
      }
      const observation = observer.snapshot();
      await saveDiagnosticReport(path.join(output, 'lifecycle.json'), { ...report, observation });
    }
  }
  assert.equal(report.status, 'passed', 'Diagnostic capture incomplete; inspect lifecycle.json');
}
