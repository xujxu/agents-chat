#!/usr/bin/env node
// Release-based deployment for agents-chat. See README "Deployment".
// Usage: node scripts/deploy/core.mjs <deploy|update|restore> [options]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DeployError, backupName, beginSwitch, checkSkipInstall, chooseRestoreTarget, completeSwitch,
  emptyState, evaluatePreflight, failSwitch, planPrune, recoveryPlan, releaseId, updatePending,
} from './state.mjs';
import {
  SHARED_DIRS, SHARED_FILES, acquireLock, copyDir, dirBytes, ensureShared, exists, freeBytes, git,
  hasCommand, inspectLock, isWin, linkShared, listDirs, log, npm, readJson, readLink, removeLink,
  replaceContents, replaceLink, run, sha256File, waitHealthy, waitPortFree, writeJson,
} from './fsops.mjs';
import { createLinuxService } from './service-linux.mjs';
import { createWindowsService } from './service-windows.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'project-dir': { type: 'string' },
    'import-from': { type: 'string' },
    repo: { type: 'string' },
    revision: { type: 'string' },
    'skip-git-pull': { type: 'boolean', default: false },
    'no-pull': { type: 'boolean', default: false },
    'no-install': { type: 'boolean', default: false },
    wait: { type: 'string', default: '120' },
    port: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'accept-data-loss': { type: 'boolean', default: false },
    'remove-task': { type: 'boolean', default: false },
    'service-name': { type: 'string' },
    user: { type: 'string' },
    'logon-type': { type: 'string', default: 'Interactive' },
    'trigger-type': { type: 'string', default: 'AtLogOn' },
    tunnel: { type: 'string', default: 'DevTunnel' },
  },
});

const command = positionals[0];
const rootArg = o['project-dir'] ?? process.env.AGENTS_CHAT_PROJECT_DIR;
const waitSeconds = Number(o.wait);
const P = rootArg && paths(path.resolve(rootArg));
let state = P ? readJson(P.state, emptyState()) : emptyState();
let svc;

function paths(root) {
  return {
    root,
    repo: path.join(root, 'repo'),
    releases: path.join(root, 'releases'),
    current: path.join(root, 'current'),
    shared: path.join(root, 'shared'),
    data: path.join(root, 'shared', '.data'),
    backups: path.join(root, 'backups'),
    state: path.join(root, 'state.json'),
  };
}

function save() {
  writeJson(P.state, state);
}

function serviceFor() {
  const name = o['service-name'] ?? state.service.name;
  return isWin ? createWindowsService({ name, root: P.root }) : createLinuxService({ name, root: P.root });
}

function port() {
  return Number(o.port ?? state.service.port ?? (isWin ? 3000 : 3010));
}

function resolveOp() {
  if (!['deploy', 'update', 'restore'].includes(command) || !P || !Number.isInteger(waitSeconds) || waitSeconds < 0) {
    throw new DeployError('Usage: core.mjs <deploy|update|restore> --project-dir <dir> [options]', 2, 'usage');
  }
  if (command === 'restore') return 'restore';
  if (command === 'update') return o.status ? 'status' : 'update';
  if (o['remove-task']) return 'remove-task';
  if (state.current) {
    if (o['import-from']) throw new DeployError('Already installed here; -ImportFrom is only for the first deploy.', 2, 'usage');
    return o['skip-git-pull'] || o['no-pull'] ? 'rebuild' : 'update';
  }
  return o['import-from'] ? 'import' : 'install';
}

// ---------- preflight ----------

function isElevated() {
  if (!isWin) return process.getuid() === 0;
  return run('net', ['session'], { capture: true, allowFail: true }).status === 0;
}

function preflight(op) {
  const importFrom = o['import-from'] && path.resolve(o['import-from']);
  const dataDir = importFrom ? path.join(importFrom, '.data') : P.data;
  const serviceExists = svc.exists();
  const errors = evaluatePreflight({
    op,
    isElevated: isElevated(),
    nodeMajor: Number(process.versions.node.split('.')[0]),
    hasGit: hasCommand('git'),
    lockHeld: inspectLock(P.root) === 'held',
    freeBytes: freeBytes(P.root),
    dataBytes: dirBytes(dataDir),
    hasEnvLocal: exists(path.join(importFrom ?? P.shared, '.env.local')),
    installed: Boolean(state.current),
    serviceExists,
  });
  if (op === 'import' && serviceExists && !svc.pointsInto(importFrom)) {
    errors.push(`The existing service/task does not run from ${importFrom}.`);
  }
  if (op === 'restore' && !o['accept-data-loss'] && !o['dry-run']) {
    errors.push('Restore replaces chat data with the backup taken when that version was replaced; '
      + 'chats created since then are removed. Re-run with -AcceptDataLoss / --accept-data-loss.');
  }
  return errors;
}

// ---------- build and stage ----------

function cloneRepo(url) {
  if (exists(path.join(P.repo, '.git'))) {
    git(['-C', P.repo, 'remote', 'set-url', 'origin', url]);
  } else {
    log(`Cloning ${url}`);
    run('git', ['clone', '--quiet', url, P.repo], { step: 'build' });
  }
  const head = git(['-C', P.repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  state.branch = head ? head.replace(/^origin\//, '') : git(['-C', P.repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
}

function resolveTarget({ skipPull, fallback }) {
  const g = (...a) => git(['-C', P.repo, ...a], { step: 'build' });
  if (skipPull) return g('rev-parse', 'HEAD');
  run('git', ['-C', P.repo, 'fetch', '--quiet', '--tags', '--force', 'origin'], { step: 'build' });
  if (o.revision) {
    for (const ref of [o.revision, `origin/${o.revision}`]) {
      const sha = git(['-C', P.repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
      if (sha) return sha;
    }
    throw new DeployError(`Revision ${o.revision} was not found in the repository.`, 2, 'build');
  }
  return fallback ?? g('rev-parse', `origin/${state.branch}`);
}

function build({ skipPull = false, fallback } = {}) {
  const sha = resolveTarget({ skipPull, fallback });
  log(`Building ${sha}`);
  run('git', ['-C', P.repo, 'checkout', '--quiet', '--detach', '--force', sha], { step: 'build' });
  const envLink = path.join(P.repo, '.env.local');
  removeLink(envLink);
  fs.symlinkSync(path.join(P.shared, '.env.local'), envLink, 'file');
  const lockHash = sha256File(path.join(P.repo, 'package-lock.json'));
  if (o['no-install']) {
    checkSkipInstall(state, lockHash);
  } else {
    npm(['ci', '--no-audit', '--no-fund'], { cwd: P.repo, step: 'build' });
    state.lockHash = lockHash;
    save();
  }
  npm(['run', 'build'], { cwd: P.repo, step: 'build' });
  return stage(sha);
}

function stage(sha) {
  const id = releaseId(sha, Date.now());
  const dir = path.join(P.releases, `${id}.tmp`);
  const from = (p) => path.join(P.repo, p);
  removeRelease(dir);
  fs.cpSync(from('.next/standalone'), dir, { recursive: true, verbatimSymlinks: true });
  for (const p of ['.next/static', 'public', 'scripts', 'setup-files']) {
    if (exists(from(p))) fs.cpSync(from(p), path.join(dir, p), { recursive: true });
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.env') || SHARED_DIRS.includes(name) || SHARED_FILES.includes(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(dir, 'REVISION'), `${sha}\n`);
  fs.writeFileSync(path.join(dir, 'node-path.txt'), process.execPath);
  linkShared(dir, P.shared);
  fixOwner(dir);
  fs.renameSync(dir, path.join(P.releases, id));
  log(`Staged release ${id}`);
  return id;
}

function removeRelease(dir) {
  for (const name of [...SHARED_DIRS, ...SHARED_FILES]) removeLink(path.join(dir, name));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- switching ----------

function fixOwner(...dirs) {
  if (isWin) return;
  const user = state.service.user;
  if (user && user !== 'root') run('chown', ['-R', `${user}:`, P.shared, ...dirs], { step: 'data' });
}

async function startAndCheck(id) {
  svc.start();
  state = updatePending(state, { step: 'health' });
  save();
  if (waitSeconds === 0) return false;
  const health = await waitHealthy(port(), waitSeconds);
  const expected = fs.readFileSync(path.join(P.releases, id, 'REVISION'), 'utf8').trim();
  if (health.version !== expected) {
    throw new DeployError(`Health reported version ${health.version}, expected ${expected}.`, 1, 'health');
  }
  return true;
}

async function stopService() {
  svc.stop();
  await waitPortFree(port());
}

async function switchTo(op, to, { restoreData } = {}) {
  const from = state.current;
  state = beginSwitch(state, { op, from, to, now: Date.now() });
  save();
  try {
    await stopService();
    const backup = backupName(from, Date.now());
    copyDir(P.data, path.join(P.backups, backup));
    state = updatePending(state, { step: 'start', backup });
    save();
    if (restoreData) {
      replaceContents(path.join(P.backups, restoreData), P.data);
      fixOwner();
    }
    replaceLink(P.current, path.join(P.releases, to));
    const verified = await startAndCheck(to);
    finish(verified);
    return result('succeeded', verified ? `Now running ${to}.` : `Now running ${to} (not verified: -NoWait).`);
  } catch (err) {
    return rollBack(err);
  }
}

function finish(verified) {
  state = completeSwitch(state, { verified, now: Date.now() });
  const plan = planPrune(state, listDirs(P.releases), listDirs(P.backups));
  for (const id of plan.releases) removeRelease(path.join(P.releases, id));
  for (const b of plan.backups) fs.rmSync(path.join(P.backups, b), { recursive: true, force: true });
  state = plan.state;
  save();
}

// Undo whatever `pending` describes; used for failures and interrupted runs.
async function undo(outcome, err) {
  const p = state.pending;
  const plan = recoveryPlan(state);
  const notes = [err.message];
  log(`Undoing ${p.op} (${p.step}): ${err.message}`);
  try {
    try {
      svc.stop();
    } catch (e) {
      log(`stop during undo: ${e.message}`);
    }
    await waitPortFree(port());
    if (plan.relinkTo) replaceLink(P.current, path.join(P.releases, plan.relinkTo));
    if (plan.restoreData) {
      replaceContents(path.join(P.backups, plan.restoreData), P.data);
      fixOwner();
    }
    if (plan.removeService) svc.remove();
    if (plan.restoreService) svc.restore(path.join(P.backups, plan.restoreService));
    if (plan.start) {
      svc.start();
      if (plan.relinkTo) {
        await waitHealthy(port(), Math.max(waitSeconds, 120));
        notes.push(`Restored ${plan.relinkTo}.`);
      } else {
        notes.push('Restored the previous service definition and started it.');
      }
    }
  } catch (undoErr) {
    outcome = 'failed';
    notes.push(`Rollback also failed: ${undoErr.message}`);
  }
  state = failSwitch(state, { outcome, step: err.step ?? p.step, message: notes.join(' '), now: Date.now() });
  save();
  return outcome;
}

async function rollBack(err) {
  const outcome = await undo(state.pending.from ? 'rolled-back' : 'failed', err);
  return result(outcome, state.lastResult.message, 1);
}

async function recoverInterrupted() {
  if (!state.pending) return;
  const p = state.pending;
  await undo('failed', new DeployError(`Recovered from an interrupted ${p.op} (step ${p.step}).`, 1, p.step));
  log(state.lastResult.message);
}

// ---------- operations ----------

async function install() {
  const url = o.repo ?? git(['-C', SOURCE_ROOT, 'remote', 'get-url', 'origin']);
  ensureShared(P.shared);
  state.service = {
    name: svc.name, port: port(), user: o.user ?? 'root',
    userId: o.user ?? null, logonType: o['logon-type'], triggerType: o['trigger-type'], tunnel: o.tunnel,
  };
  cloneRepo(url);
  save();
  const id = buildOrFail();
  if (typeof id !== 'string') return id;
  state = beginSwitch(state, { op: 'install', from: null, to: id, now: Date.now() });
  save();
  try {
    fixOwner();
    replaceLink(P.current, path.join(P.releases, id));
    svc.install(state.service);
    const verified = await startAndCheck(id);
    finish(verified);
    return result('succeeded', `Installed ${id}.`);
  } catch (err) {
    return rollBack(err);
  }
}

async function importFrom() {
  const old = path.resolve(o['import-from']);
  const settings = svc.settings();
  ensureShared(P.shared);
  state.service = {
    name: svc.name,
    port: Number(o.port ?? settings.port ?? (isWin ? 3000 : 3010)),
    user: settings.user ?? 'root',
    userId: settings.userId ?? null,
    logonType: settings.logonType,
    triggerType: settings.triggerType,
    tunnel: settings.tunnel,
  };
  cloneRepo(git(['-C', old, 'remote', 'get-url', 'origin']));
  run('git', ['-C', P.repo, 'fetch', '--quiet', old, 'HEAD'], { step: 'build' });
  const oldHead = git(['-C', P.repo, 'rev-parse', 'FETCH_HEAD']);
  for (const f of SHARED_FILES) {
    if (exists(path.join(old, f))) fs.copyFileSync(path.join(old, f), path.join(P.shared, f));
  }
  save();
  const id = buildOrFail({ fallback: oldHead });
  if (typeof id !== 'string') return id;

  state = beginSwitch(state, { op: 'import', from: null, to: id, now: Date.now() });
  const serviceBackup = `migration-${backupName('service', Date.now()).split('--')[1]}`;
  svc.backup(path.join(P.backups, serviceBackup));
  state = updatePending(state, { serviceBackup });
  save();
  try {
    await stopService();
    if (exists(path.join(old, '.data'))) replaceContents(path.join(old, '.data'), P.data);
    if (exists(path.join(old, 'logs'))) {
      try {
        fs.cpSync(path.join(old, 'logs'), path.join(P.shared, 'logs'), { recursive: true });
      } catch (err) {
        log(`Some logs were not copied: ${err.message}`);
      }
    }
    fixOwner();
    replaceLink(P.current, path.join(P.releases, id));
    svc.adopt({ ...state.service, oldDir: old });
    const verified = await startAndCheck(id);
    finish(verified);
    return result('succeeded', `Migrated ${old} to ${P.root}; running ${id}. The old checkout was not changed.`);
  } catch (err) {
    return rollBack(err);
  }
}

function buildOrFail(opts) {
  try {
    return build(opts);
  } catch (err) {
    if (err.exitCode === 2) throw err;
    state = failSwitch(state, {
      op: command, from: state.current, to: o.revision ?? null, outcome: 'failed', step: 'build',
      message: `${err.message} The running version was not changed.`, now: Date.now(),
    });
    save();
    return result('failed', state.lastResult.message, 1);
  }
}

async function update({ skipPull }) {
  const id = buildOrFail({ skipPull });
  if (typeof id !== 'string') return id;
  return switchTo(skipPull ? 'rebuild' : 'update', id);
}

async function restore() {
  const target = chooseRestoreTarget(state, o.revision, listDirs(P.releases));
  return switchTo('restore', target, { restoreData: state.backups[target] });
}

function removeTask() {
  if (!svc.exists()) return result('succeeded', 'No task/service to remove.');
  svc.remove();
  return result('succeeded', `Removed ${svc.name}. Releases, data and backups were kept.`);
}

function status() {
  return {
    ok: true,
    projectDir: P.root,
    installed: Boolean(state.current),
    current: state.current,
    linked: readLink(P.current),
    previous: state.previous,
    verified: state.verified,
    pending: state.pending,
    lastResult: state.lastResult,
    releases: listDirs(P.releases),
    backups: listDirs(P.backups),
    service: { ...state.service, exists: svc.exists() },
  };
}

function dryRun(op, errors) {
  let to = null;
  try {
    if (op === 'restore') to = chooseRestoreTarget(state, o.revision, listDirs(P.releases));
    else if (op === 'update') to = o.revision ?? git(['-C', P.repo, 'ls-remote', 'origin', state.branch]).split(/\s/)[0];
  } catch (err) {
    errors.push(err.message);
  }
  return {
    ok: errors.length === 0,
    op,
    dryRun: true,
    from: state.current,
    to,
    errors,
    steps: op === 'restore'
      ? ['stop', 'snapshot data', 'switch current', 'restore data backup', 'start', 'health check']
      : ['build in repo/', 'stage release', 'stop', 'snapshot data', 'switch current', 'start', 'health check', 'prune'],
  };
}

function result(outcome, message, exitCode = 0) {
  return { ok: outcome === 'succeeded', outcome, message, current: state.current, verified: state.verified, exitCode };
}

async function main() {
  const op = resolveOp();
  svc = serviceFor();
  if (op === 'status') return status();
  const errors = preflight(op);
  if (o['dry-run']) return { ...dryRun(op, errors), exitCode: errors.length ? 2 : 0 };
  if (errors.length) throw new DeployError(`Preflight failed:\n  - ${errors.join('\n  - ')}`, 2, 'preflight');
  fs.mkdirSync(P.root, { recursive: true });
  const release = acquireLock(P.root);
  try {
    if (op !== 'remove-task') await recoverInterrupted();
    switch (op) {
      case 'install': return await install();
      case 'import': return await importFrom();
      case 'update': return await update({ skipPull: false });
      case 'rebuild': return await update({ skipPull: true });
      case 'restore': return await restore();
      case 'remove-task': return removeTask();
    }
  } finally {
    release();
  }
}

let out;
try {
  out = await main();
} catch (err) {
  if (!(err instanceof DeployError)) throw err;
  out = { ok: false, outcome: 'failed', message: err.message, step: err.step, exitCode: err.exitCode };
}
const { exitCode = 0, ...body } = out;
const text = o.json || !body.message ? JSON.stringify(body, null, o.json ? 0 : 2) : body.message;
process.stdout.write(`${text}\n`, () => process.exit(exitCode));
