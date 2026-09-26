import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, freemem, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';

const [packageDirectory] = process.argv.slice(2);
assert.ok(packageDirectory);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('VOICE_')));
function closed(child) {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
}
async function run(args, env = environment) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
  assert.equal(await closed(child), 0, 'Diagnostic subprocess failed');
}
const raw = await readFile(path.join(packageDirectory, 'voice-package.json'));
const manifest = JSON.parse(raw);
assert.equal(manifest.modelId, 'sensevoice-small-q8');
const identity = { manifest: createHash('sha256').update(raw).digest('hex') };
for (const role of ['binary', 'model', 'helper']) {
  const entries = manifest.files.filter(file => file.role === role);
  assert.equal(entries.length, role === 'helper' && process.platform === 'linux' ? 0 : 1);
  identity[role] = entries[0]?.sha256 ?? null;
}
if (process.platform === 'linux') {
  for (const file of manifest.files.filter(file => file.role === 'binary')) {
    await chmod(path.join(packageDirectory, file.path), 0o755);
  }
}
await mkdir('diagnostics', { recursive: true });
await mkdir('diagnostic-private-logs', { recursive: true });
for (const name of (await readdir('corpus')).filter(name => name.endsWith('-ATTRIBUTION.txt'))) {
  await copyFile(path.join('corpus', name), path.join('diagnostics', name));
}
await writeFile('diagnostics/package-manifest.json', raw);
await writeFile('diagnostics/environment.json', JSON.stringify({
  commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, identity,
  platform: process.platform, release: release(), architecture: process.arch,
  cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalPhysicalBytes: totalmem(),
  availablePhysicalBytes: freemem(), physicalCores: null, effectiveCpuQuota: null,
  effectiveMemoryQuota: null, nativePeakRss: null,
  scope: 'Same-host sequential diagnostic replay, cold native processes, possibly warm file cache. No qualification.',
}, null, 2));
const before = (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();
for (const threads of [2, 1, 4]) {
  await run(['scripts/configure-voice.mjs', '--project-dir', process.cwd(),
    '--model', 'sensevoice-small-q8', '--package-dir', path.resolve(packageDirectory),
    '--manifest-sha256', identity.manifest, '--threads', String(threads), '--non-interactive']);
  const log = await open(`diagnostic-private-logs/server-${threads}.log`, 'w');
  const server = spawn(process.execPath, [
    'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3011',
  ], { env: environment, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
  const serverDone = closed(server);
  void serverDone.catch(() => {});
  try {
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (server.exitCode !== null) throw new Error('Diagnostic app exited before readiness');
      try {
        const response = await fetch('http://localhost:3011/api/auth/providers', { signal: AbortSignal.timeout(2000) });
        if (response.ok) { ready = true; break; }
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(ready, 'Diagnostic app did not become ready');
    await run(['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.config.ts',
      'tests/voice-consistency.spec.ts', '--project=desktop-chromium', '--workers=1', '--reporter=line',
      '--global-timeout=1900000', '--trace=off', '--output=diagnostic-private-logs/playwright'],
    { ...environment, SENSE_CONSISTENCY: '1', CONSISTENCY_THREADS: String(threads) });
  } finally {
    if (server.exitCode === null) server.kill('SIGKILL');
    await serverDone;
    await log.close();
    assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort(), before,
      'Diagnostic requests leaked private directories');
  }
}
