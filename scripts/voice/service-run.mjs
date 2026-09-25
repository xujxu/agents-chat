import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { milestones, browserPhase, validateServiceHost } from './service-contract.mjs';
import { manifestHashes } from './lifecycle-contract.ts';
import { voiceValues } from './setup-config.mjs';
import { decodeEnvironment } from './configuration-files.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scenario = process.argv[2];
const cleanupOnly = process.argv[3] === '--cleanup';
milestones(scenario);
const area = path.join(process.env.RUNNER_TEMP, `voice-service-${scenario}`);
const project = path.join(area, 'app');
const output = path.join(repo, 'service-evidence');
const remote = path.join(area, 'remote.git');
const publisher = path.join(area, 'publisher');
const tokenKey = key => /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key);
const tokens = Object.fromEntries(Object.entries(process.env).filter(([key]) => tokenKey(key)));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !tokenKey(key) && !key.startsWith('VOICE_')));
env.NEXT_TELEMETRY_DISABLED = '1';
if (process.platform === 'linux') {
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'safe.directory';
  env.GIT_CONFIG_VALUE_0 = repo;
}
const windows = process.platform === 'win32';
const baseURL = `http://localhost:${windows ? 3000 : 3010}`;
const powershell = windows ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : null;
const host = { run: process.env.GITHUB_RUN_ID, commit: process.env.GITHUB_SHA,
  platform: process.platform, scenario, project, status: 'failed', syntheticUpgrade: true,
  milestones: [], cleanup: null };
await mkdir(output, { recursive: true });
const persist = () => writeFile(path.join(output, 'host.json'), JSON.stringify(host, null, 2));
let operation = 0;
async function execute(command, args, { cwd = project, environment = env, capture = false } = {}) {
  const log = capture ? null : await open(path.join(area, `private-${++operation}.log`), 'w', 0o600);
  const child = spawn(command, args, { cwd, env: environment, windowsHide: true,
    stdio: ['ignore', capture ? 'pipe' : log.fd, log ? log.fd : 'pipe'] });
  const chunks = [];
  let bytes = 0;
  if (capture) {
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.stderr.resume();
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) {
      if (log) {
        const text = await readFile(path.join(area, `private-${operation}.log`), 'utf8');
        const knownSecrets = Object.values(tokens).filter(Boolean);
        const errors = text.split(/\r?\n/).filter(line =>
          /Error:|ERROR:|Voice setup failed:|throw |Exception:|fatal:|npm error/i.test(line)).slice(-8)
          .map(line => knownSecrets.reduce((value, secret) => value.split(secret).join('[redacted]'), line).slice(0, 500));
        if (errors.length) host.diagnostics = errors;
      }
      throw new Error(`Service operation failed: ${path.basename(command)} ${args[0]}; private operation ${operation}`);
    }
    assert.ok(bytes <= 1024 * 1024, 'Unexpected subprocess output size');
    return Buffer.concat(chunks).toString('utf8').trim();
  } finally { clearTimeout(timer); await log?.close(); }
}
async function driver(action) {
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(repo, 'scripts/voice/windows/service-driver.ps1'), '-Action', action, '-Project', project]
    : [path.join(repo, 'scripts/voice/service-linux.mjs'), action, project];
  return JSON.parse(await execute(windows ? powershell : process.execPath, args, { cwd: repo, capture: true }));
}
async function cleanup() {
  try {
    await readFile(path.join(project, '.service-e2e-owner.json'));
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  host.cleanup = await driver('cleanup');
}
if (cleanupOnly) {
  await cleanup();
  console.log('Owned service fallback cleanup completed.');
} else {
  let owned = false;
  try {
    await mkdir(area);
    await driver('preflight');
    await execute('git', ['clone', '--no-hardlinks', repo, publisher], { cwd: repo });
    await execute('git', ['checkout', '--detach', host.commit], { cwd: publisher });
    await execute('git', ['clone', '--bare', publisher, remote], { cwd: repo });
    await execute('git', ['clone', remote, project], { cwd: repo });
    await execute('git', ['checkout', '-b', 'service-fixture']);
    await execute('git', ['push', '--set-upstream', 'origin', 'service-fixture']);
    await execute('git', ['remote', 'set-url', 'origin', remote], { cwd: publisher });
    await execute('git', ['checkout', '-b', 'service-fixture'], { cwd: publisher });
    await cp(path.join(repo, 'lifecycle-inputs'), path.join(project, 'lifecycle-inputs'), { recursive: true });
    await writeFile(path.join(project, '.env.local'),
      `ADMIN_USERNAME=admin\nADMIN_PASSWORD=admin123\nNEXTAUTH_SECRET=isolated-service-e2e-secret\nNEXTAUTH_URL=${baseURL}\nSERVICE_FIXTURE=preserve\n`,
      { mode: 0o600 });
    await writeFile(path.join(project, '.service-e2e-owner.json'), JSON.stringify({ project, run: host.run }), { mode: 0o600 });
    owned = true;
    let previousVoice;
    for (const name of milestones(scenario)) {
      const row = { name, status: 'failed', records: [], expectedCheckout: null };
      host.milestones.push(row);
      await persist();
      console.log(`Service ${process.platform}/${scenario}: ${name}`);
      const upgrade = name === 'enabled' || name === 'keep';
      if (upgrade) {
        await writeFile(path.join(publisher, 'service-upgrade-marker.txt'), name + '\n');
        await execute('git', ['add', 'service-upgrade-marker.txt'], { cwd: publisher });
        await execute('git', ['-c', 'user.name=Service E2E fixture', '-c', 'user.email=fixture@example.invalid',
          'commit', '-m', `Synthetic ${name} upgrade marker`], { cwd: publisher });
        await execute('git', ['push', 'origin', 'service-fixture'], { cwd: publisher });
        row.expectedCheckout = await execute('git', ['rev-parse', 'HEAD'], { cwd: publisher, capture: true });
      }
      const enabling = name === 'selected' || name === 'enabled';
      const deployEnv = enabling ? { ...env, ...tokens } : env;
      if (windows) {
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(project, 'scripts/deploy.ps1'), '-NonInteractive', '-TaskLogonType', 'S4U',
          '-TaskTriggerType', 'AtStartup', '-WaitSeconds', '300'];
        if (!upgrade) args.push('-SkipGitPull');
        if (host.milestones.length === 1) args.push('-NoTunnel');
        if (enabling) args.push('-VoiceModel', 'sensevoice-small-q8', '-VoiceExperimentalDownload');
        if (name === 'disabled') args.push('-VoiceModel', 'disabled');
        await execute(powershell, args, { environment: deployEnv });
      } else {
        const args = [upgrade ? 'scripts/upgrade.sh' : 'scripts/deploy.sh', '--non-interactive', '--wait', '300'];
        if (!upgrade) args.push('--no-pull');
        if (enabling) args.push('--voice', 'sensevoice-small-q8', '--voice-experimental-download');
        if (name === 'disabled') args.push('--voice', 'disabled');
        await execute('bash', args, { environment: deployEnv });
      }
      row.checkout = await execute('git', ['rev-parse', 'HEAD'], { capture: true });
      row.service = await driver('probe');
      const config = decodeEnvironment(await readFile(path.join(project, '.env.local')));
      assert.match(config, /^SERVICE_FIXTURE=preserve$/m);
      assert.doesNotMatch(config, /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)=/mi);
      const voice = voiceValues(config);
      row.voiceHash = createHash('sha256').update(JSON.stringify(voice)).digest('hex');
      if (name === 'keep') assert.equal(row.voiceHash, previousVoice);
      if (browserPhase(name) === 'enabled') {
        const manifestHash = manifestHashes[process.platform];
        const raw = await readFile(path.join(project, '.data/voice/packages', manifestHash, 'voice-package.json'));
        assert.equal(createHash('sha256').update(raw).digest('hex'), manifestHash);
        row.identity = { manifest: manifestHash, roles: {}, verifiedRoles: false };
        for (const [role, key] of [['binary', 'VOICE_BINARY_PATH'], ['model', 'VOICE_MODEL_PATH'], ['helper', 'VOICE_LAUNCHER_PATH']]) {
          const item = JSON.parse(raw).files.find(file => file.role === role);
          if (!item) { assert.ok(role === 'helper' && !windows); continue; }
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(voice[key])) hash.update(chunk);
          row.identity.roles[role] = hash.digest('hex');
          assert.equal(row.identity.roles[role], item.sha256);
        }
        row.identity.verifiedRoles = true;
        previousVoice = row.voiceHash;
      }
      const recordsRoot = path.join(output, name, 'records');
      await execute(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config',
        'tests/playwright.voice-lifecycle.config.ts', '--workers=1', '--retries=0', '--reporter=line',
        '--trace=off', '--output=service-private-tests'], {
        environment: { ...env, PLAYWRIGHT_BASE_URL: baseURL, LIFECYCLE_PHASE: browserPhase(name),
          LIFECYCLE_RECORD_ROOT: recordsRoot },
      });
      row.records = await collect(recordsRoot);
      const after = await driver('probe');
      assert.equal(after.activation, row.service.activation, 'Service restarted during recording');
      assert.deepEqual(after.temporaryDirectories, row.service.temporaryDirectories, 'Native service temporary directories leaked');
      row.temporaryRestored = true;
      row.status = 'passed';
      await persist();
    }
  } catch (error) {
    host.error = error instanceof Error ? error.message : String(error);
    console.error(host.error);
  } finally {
    if (owned) {
      try { await cleanup(); }
      catch (error) { host.cleanup = { removed: false, portClosed: false, error: error.message }; }
    }
    host.status = host.error ? 'failed' : 'passed';
    try { validateServiceHost(host, host.run, host.commit); }
    catch (error) { host.status = 'failed'; host.error ??= error.message; }
    await persist();
    if (host.status !== 'passed') process.exitCode = 1;
  }
}
async function collect(directory) {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await collect(file));
    else if (entry.name === 'record.json') rows.push(JSON.parse(await readFile(file, 'utf8')));
  }
  return rows;
}
