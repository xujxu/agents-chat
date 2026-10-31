// Filesystem and process helpers used by core.mjs.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DeployError, lockStatus } from './state.mjs';

export const isWin = process.platform === 'win32';

export function log(message) {
  process.stderr.write(`[deploy] ${message}\n`);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// Remove a symlink/junction without following it.
export function removeLink(p) {
  if (!exists(p)) return;
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

export function replaceLink(linkPath, target) {
  target = path.resolve(target);
  if (isWin) {
    removeLink(linkPath);
    fs.symlinkSync(target, linkPath, 'junction');
    return;
  }
  const tmp = `${linkPath}.new`;
  removeLink(tmp);
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, linkPath);
}

export function readLink(linkPath) {
  try {
    return path.basename(fs.readlinkSync(linkPath).replace(/[\\/]+$/, ''));
  } catch {
    return null;
  }
}

export const SHARED_DIRS = ['.data', 'logs'];
export const SHARED_FILES = ['.env.local', 'agents.json', 'nodes.json'];

export function ensureShared(sharedDir) {
  for (const d of SHARED_DIRS) fs.mkdirSync(path.join(sharedDir, d), { recursive: true });
}

export function linkShared(dir, sharedDir) {
  for (const name of [...SHARED_DIRS, ...SHARED_FILES]) {
    const link = path.join(dir, name);
    fs.rmSync(link, { recursive: true, force: true });
    const target = path.join(sharedDir, name);
    if (SHARED_DIRS.includes(name)) {
      fs.symlinkSync(target, link, isWin ? 'junction' : 'dir');
    } else if (exists(target)) {
      fs.symlinkSync(target, link, 'file');
    }
  }
}

export function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

// Replace the contents of dataDir (keeping the directory itself, which may be in use as a link target).
export function replaceContents(src, dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const entry of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
  fs.cpSync(src, dataDir, { recursive: true });
}

export function dirBytes(dir) {
  let total = 0;
  for (const entry of safeReaddir(dir)) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function freeBytes(dir) {
  let p = path.resolve(dir);
  while (!fs.existsSync(p)) p = path.dirname(p);
  const s = fs.statfsSync(p);
  return s.bavail * s.bsize;
}

export function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function inspectLock(root) {
  return lockStatus(readJson(path.join(root, 'deploy.lock'), null), isAlive);
}

export function acquireLock(root) {
  const file = path.join(root, 'deploy.lock');
  const status = inspectLock(root);
  if (status === 'held') throw new DeployError('Another deployment is running (deploy.lock is held).', 2, 'preflight');
  if (status === 'stale') log('Taking over a stale deploy.lock.');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return () => {
    if (readJson(file, null)?.pid === process.pid) fs.rmSync(file, { force: true });
  };
}

const childEnv = () => ({
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
});

// Run a command, streaming its output to stderr. Throws on failure.
export function run(cmd, args, { cwd, step, capture = false, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env: childEnv(),
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 2, 2],
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    if (allowFail) return res;
    throw new DeployError(`${cmd} failed to start: ${res.error.message}`, 1, step);
  }
  if (res.status !== 0 && !allowFail) {
    const detail = capture ? `: ${(res.stderr || res.stdout || '').trim().slice(-2000)}` : '';
    throw new DeployError(`${cmd} ${args.join(' ')} exited with ${res.status}${detail}`, 1, step);
  }
  return res;
}

export function npm(args, opts) {
  const dir = path.dirname(process.execPath);
  const cli = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((p) => fs.existsSync(p));
  if (!cli) throw new DeployError('npm was not found next to node.', 2, 'preflight');
  return run(process.execPath, [cli, ...args], opts);
}

export function git(args, opts = {}) {
  return (run('git', args, { capture: true, ...opts }).stdout ?? '').trim();
}

export function hasCommand(cmd) {
  return !spawnSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true }).error;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitHealthy(port, seconds) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + seconds * 1000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.cause?.code ?? err.message;
    }
    await sleep(2000);
  }
  throw new DeployError(`Health check ${url} did not pass within ${seconds}s (${last}).`, 1, 'health');
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

export async function waitPortFree(port, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  while (await portOpen(port)) {
    if (Date.now() > deadline) throw new DeployError(`Port ${port} is still in use after stopping the service.`, 1, 'stop');
    await sleep(1000);
  }
}
