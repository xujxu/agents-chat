import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem, freemem, tmpdir } from 'node:os';
import path from 'node:path';

const [packageDirectory, model] = process.argv.slice(2);
assert.ok(['sensevoice-small-q8', 'whisper-base-q5_1'].includes(model));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('VOICE_')));
function closed(child) {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
}
async function run(args, env = environment) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
  assert.equal(await closed(child), 0, 'Acceptance subprocess failed');
}
await mkdir('installed-evidence', { recursive: true });
const raw = await readFile(path.join(packageDirectory, 'voice-package.json'));
const digest = createHash('sha256').update(raw).digest('hex');
const manifest = JSON.parse(raw);
if (process.platform === 'linux') {
  for (const file of manifest.files.filter(file => file.role === 'binary')) await chmod(path.join(packageDirectory, file.path), 0o755);
}
await run(['scripts/configure-voice.mjs', '--project-dir', process.cwd(), '--model', model,
  '--package-dir', path.resolve(packageDirectory), '--manifest-sha256', digest, '--non-interactive']);
await writeFile('installed-evidence/package-manifest.json', raw);
await writeFile('installed-evidence/environment.json', JSON.stringify({
  commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, platform: process.platform,
  release: release(), architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
  totalPhysicalBytes: totalmem(), availablePhysicalBytes: freemem(), model,
  threads: model === 'sensevoice-small-q8' ? 2 : 1, manifestSha256: digest,
  physicalCores: null, effectiveCpuQuota: null, effectiveMemoryQuota: null, nativePeakRss: null,
  scope: 'Hosted Actions runner; external limits unknown. No application hard quota. Fresh native process per request, potentially warm file cache.',
}, null, 2));
const before = (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();
const log = await open('installed-evidence/server.log', 'w');
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
  await run(['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.config.ts',
    'tests/voice-installed-corpus.spec.ts', '--project=desktop-chromium', '--workers=1', '--reporter=line',
    '--global-timeout=1900000', '--trace=off', '--output=installed-test-output'],
  { ...environment, INSTALLED_VOICE_ACCEPTANCE: '1', INSTALLED_MODEL: model });
} finally {
  if (server.exitCode === null) server.kill('SIGKILL');
  await serverDone;
  await log.close();
}
assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort(), before,
  'Installed requests leaked temporary directories');
