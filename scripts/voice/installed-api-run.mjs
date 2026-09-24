import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem, freemem, tmpdir } from 'node:os';
import path from 'node:path';
import { decodeEnvironment } from './configuration-files.mjs';
import { voiceValues } from './setup-config.mjs';

const [packageDirectory, model, mode = 'direct'] = process.argv.slice(2);
assert.ok(['sensevoice-small-q8', 'whisper-base-q5_1'].includes(model));
assert.ok(['direct', 'browser'].includes(mode));
assert.ok(mode !== 'browser' || model === 'sensevoice-small-q8');
const browser = mode === 'browser';
const evidence = browser ? 'installed-browser-evidence' : 'installed-evidence';
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('VOICE_')));
function closed(child) {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
}
async function run(args, env = environment) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
  assert.equal(await closed(child), 0, 'Acceptance subprocess failed');
}
await mkdir(evidence, { recursive: true });
const raw = await readFile(path.join(packageDirectory, 'voice-package.json'));
const digest = createHash('sha256').update(raw).digest('hex');
const manifest = JSON.parse(raw);
if (process.platform === 'linux') {
  for (const file of manifest.files.filter(file => file.role === 'binary')) await chmod(path.join(packageDirectory, file.path), 0o755);
}
await run(['scripts/configure-voice.mjs', '--project-dir', process.cwd(), '--model', model,
  '--package-dir', path.resolve(packageDirectory), '--manifest-sha256', digest, '--non-interactive']);
await writeFile(path.join(evidence, 'package-manifest.json'), raw);
let identity;
if (browser) {
  const values = voiceValues(decodeEnvironment(await readFile('.env.local')));
  assert.equal(values.VOICE_ENABLED, '1');
  assert.equal(values.VOICE_MODEL, model);
  assert.equal(values.VOICE_THREADS, '2');
  assert.equal(values.VOICE_RESOURCE_POLICY, 'standard');
  identity = { manifest: digest };
  for (const [role, key] of [['binary', 'VOICE_BINARY_PATH'], ['model', 'VOICE_MODEL_PATH'], ['helper', 'VOICE_LAUNCHER_PATH']]) {
    const expected = manifest.files.filter(file => file.role === role);
    assert.equal(expected.length, role === 'helper' && process.platform === 'linux' ? 0 : 1);
    if (!expected.length) { assert.equal(values[key], undefined); identity[role] = null; continue; }
    assert.equal(typeof values[key], 'string');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(values[key])) hash.update(chunk);
    identity[role] = hash.digest('hex');
    assert.equal(identity[role], expected[0].sha256, 'Installed role bytes differ');
  }
  for (const name of ['samples.json', 'ASCEND-ATTRIBUTION.txt', 'AISHELL-4-ATTRIBUTION.txt']) {
    await copyFile(path.join('corpus', name), path.join(evidence, name));
  }
  const implementation = {};
  for (const name of ['app/features/composer/voice/voiceRecorder.ts', 'app/features/composer/voice/useVoiceInput.ts',
    'public/voice/recorder-worklet.js', 'lib/voice/audio.ts', 'lib/voice/process.ts',
    'tests/helpers/voiceBrowserCapture.ts', 'tests/voice-installed-browser.spec.ts']) {
    implementation[name] = createHash('sha256').update(await readFile(name)).digest('hex');
  }
  await writeFile(path.join(evidence, 'implementation.json'), JSON.stringify(implementation, null, 2));
}
await writeFile(path.join(evidence, 'environment.json'), JSON.stringify({
  commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, platform: process.platform,
  release: release(), architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
  totalPhysicalBytes: totalmem(), availablePhysicalBytes: freemem(), model,
  threads: model === 'sensevoice-small-q8' ? 2 : 1, manifestSha256: digest,
  ...(identity ? { identity } : {}),
  physicalCores: null, effectiveCpuQuota: null, effectiveMemoryQuota: null, nativePeakRss: null,
  scope: 'Hosted Actions runner; external limits unknown. No application hard quota. Fresh native process per request, potentially warm file cache.',
}, null, 2));
const before = (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();
const log = await open(browser ? 'browser-private-server.log' : 'installed-evidence/server.log', 'w');
const server = spawn(process.execPath, [
  'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3011',
], { env: environment, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
const serverDone = closed(server);
void serverDone.catch(() => {});
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (server.exitCode !== null) throw new Error('App exited before readiness');
    try {
      const response = await fetch('http://localhost:3011/api/auth/providers', { signal: AbortSignal.timeout(2000) });
      if (response.ok) { ready = true; break; }
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Installed app did not become ready');
  if (browser) {
    await run(['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.config.ts',
      'tests/voice-browser-capture.spec.ts', 'tests/voice-input.spec.ts',
      '--project=desktop-chromium', '--workers=1', '--reporter=line', '--trace=off',
      '--output=browser-private-fixture-output']);
  }
  await run(['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.config.ts',
    browser ? 'tests/voice-installed-browser.spec.ts' : 'tests/voice-installed-corpus.spec.ts',
    '--project=desktop-chromium', '--workers=1', '--reporter=line',
    browser ? '--global-timeout=4600000' : '--global-timeout=1900000', '--trace=off', '--output=installed-test-output'],
  { ...environment, [browser ? 'INSTALLED_BROWSER_ACCEPTANCE' : 'INSTALLED_VOICE_ACCEPTANCE']: '1', INSTALLED_MODEL: model });
} finally {
  if (server.exitCode === null) server.kill('SIGKILL');
  await serverDone;
  await log.close();
}
assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort(), before,
  'Installed requests leaked temporary directories');
