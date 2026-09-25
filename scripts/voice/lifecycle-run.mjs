import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { decodeEnvironment } from './configuration-files.mjs';
import { voiceValues } from './setup-config.mjs';
import { manifestHashes, phases, validateHost } from './lifecycle-contract.ts';
import { catalogue } from './download-catalog.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Lifecycle execution requires Actions');
assert.ok(process.platform === 'linux' || process.platform === 'win32');
const output = 'lifecycle-evidence';
await mkdir(output, { recursive: true });
const experimental = process.env.VOICE_LIFECYCLE_DOWNLOAD === 'true';
const credentialKey = key => /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key);
const credentials = Object.fromEntries(Object.entries(process.env).filter(([key]) => credentialKey(key)));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.toUpperCase().startsWith('VOICE_') && !credentialKey(key)));
const host = { platform: process.platform, run: process.env.GITHUB_RUN_ID, commit: process.env.GITHUB_SHA,
  status: 'failed', phases: phases.map(name => ({ name, status: 'blocked', error: null })),
  records: [], identity: null, temporaryDirectoriesRestored: false,
  environment: { release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memory: totalmem() },
  acquisition: { mode: experimental ? 'experimental-download' : 'offline', verified: false },
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const persist = () => writeFile(path.join(output, 'host.json'), JSON.stringify(host, null, 2));
async function run(args, env = environment) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  assert.equal(code, 0, 'Lifecycle subprocess failed');
}
async function phase(name, action) {
  const state = host.phases.find(value => value.name === name);
  state.status = 'running';
  await persist();
  try { await action(); state.status = 'passed'; }
  catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : String(error);
  }
  await persist();
  return state.status === 'passed';
}
async function browserPhase(name) {
  assert.ok(!Object.keys(environment).some(credentialKey), 'Credentials must not enter app/browser environment');
  const log = await open('lifecycle-private-server.log', 'w');
  const server = spawn(process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3011'],
    { env: environment, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
  const done = new Promise((resolve, reject) => {
    server.once('error', reject); server.once('close', resolve);
  });
  void done.catch(() => {});
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
    assert.ok(ready, 'Lifecycle server not ready');
    await run(['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright.voice-lifecycle.config.ts',
      '--workers=1', '--reporter=line', '--trace=off', '--global-timeout=1200000',
      '--output=lifecycle-private-test-output'], { ...environment, LIFECYCLE_PHASE: name });
  } finally {
    if (server.exitCode === null) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        const code = await new Promise((resolve, reject) => {
          killer.once('error', reject); killer.once('close', resolve);
        });
        assert.equal(code, 0, 'Could not stop owned Windows server tree');
      } else server.kill('SIGKILL');
    }
    await done;
    await log.close();
  }
}
async function verifyInstalled() {
  const raw = await readFile(path.join('.data/voice/packages', manifestHashes[process.platform], 'voice-package.json'));
  assert.equal(digest(raw), manifestHashes[process.platform], 'Untrusted package manifest');
  const manifest = JSON.parse(raw);
  const values = voiceValues(decodeEnvironment(await readFile('.env.local')));
  for (const [key, value] of Object.entries({ VOICE_ENABLED: '1', VOICE_MODEL: 'sensevoice-small-q8',
    VOICE_RESOURCE_POLICY: 'standard', VOICE_THREADS: '2' })) assert.equal(values[key], value);
  const identity = { manifest: digest(raw), verifiedRoles: false, roles: {} };
  for (const [role, key] of [['binary', 'VOICE_BINARY_PATH'], ['model', 'VOICE_MODEL_PATH'], ['helper', 'VOICE_LAUNCHER_PATH']]) {
    const expected = manifest.files.filter(file => file.role === role);
    assert.equal(expected.length, role === 'helper' && process.platform === 'linux' ? 0 : 1);
    if (!expected.length) { assert.equal(values[key], undefined); continue; }
    assert.equal(typeof values[key], 'string');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(values[key])) hash.update(bytes);
    const actual = hash.digest('hex');
    assert.equal(actual, expected[0].sha256);
    identity.roles[role] = actual;
  }
  identity.verifiedRoles = true;
  host.identity = identity;
}
async function collectRecords(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await collectRecords(file));
    else if (entry.name === 'record.json') rows.push(JSON.parse(await readFile(file, 'utf8')));
  }
  return rows;
}
const temporary = async () => (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();
const before = await temporary();
try {
  assert.ok(!(await readdir('.')).includes('.env.local'), 'Expected fresh project configuration');
  const initial = await phase('initial', () => browserPhase('initial'));
  if (initial) {
    const installed = await phase('install', async () => {
      if (experimental) {
        assert.ok(!(await readdir('lifecycle-inputs')).includes('package'), 'Experimental package must be acquired by the CLI');
        await run(['scripts/configure-voice.mjs', '--project-dir', process.cwd(), '--model', 'sensevoice-small-q8',
          '--experimental-download', '--non-interactive'], { ...environment, ...credentials });
      } else {
      const packagePath = path.resolve('lifecycle-inputs/package');
      const raw = await readFile(path.join(packagePath, 'voice-package.json'));
      assert.equal(digest(raw), manifestHashes[process.platform]);
      if (process.platform === 'linux') {
        for (const file of JSON.parse(raw).files.filter(file => file.role === 'binary')) {
          await chmod(path.join(packagePath, file.path), 0o755);
        }
      }
      await run(['scripts/configure-voice.mjs', '--project-dir', process.cwd(), '--model', 'sensevoice-small-q8',
        '--package-dir', packagePath, '--manifest-sha256', manifestHashes[process.platform], '--non-interactive']);
      }
      await verifyInstalled();
      host.acquisition = { mode: experimental ? 'experimental-download' : 'offline', verified: true,
        ...(experimental ? { catalogue: catalogue[process.platform] } : {}) };
    });
    if (installed) {
      await phase('enabled', () => browserPhase('enabled'));
      const disabled = await phase('disable', async () => {
        await run(['scripts/configure-voice.mjs', '--project-dir', process.cwd(), '--model', 'disabled', '--non-interactive']);
        const values = voiceValues(decodeEnvironment(await readFile('.env.local')));
        assert.equal(values.VOICE_ENABLED, '0');
      });
      if (disabled) await phase('disabled', () => browserPhase('disabled'));
    }
  }
  host.records = await collectRecords(path.join(output, 'records'));
  assert.deepEqual(await temporary(), before, 'Native request temporary directories leaked');
  host.temporaryDirectoriesRestored = true;
  host.status = 'passed';
  validateHost(host, process.env.GITHUB_RUN_ID, process.env.GITHUB_SHA);
} catch (error) {
  host.status = 'failed';
  host.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await persist();
  if (host.status !== 'passed') process.exitCode = 1;
}
