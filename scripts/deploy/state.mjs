// Pure deployment decisions. No filesystem or process access here so the
// rules can be unit-tested directly (tests/deploy/state.test.mjs).

export const KEEP = 3;
export const MIN_FREE_BYTES = 1.5 * 1024 ** 3;

export class DeployError extends Error {
  constructor(message, exitCode = 1, step = null) {
    super(message);
    this.exitCode = exitCode;
    this.step = step;
  }
}

export function emptyState() {
  return {
    current: null,
    previous: [],
    verified: false,
    pending: null,
    lastResult: null,
    lockHash: null,
    branch: null,
    backups: {},
    service: {},
  };
}

export function releaseId(sha, now) {
  return `${sha.slice(0, 12)}-${stamp(now)}`;
}

export function backupName(releaseId, now) {
  return `${releaseId}--${stamp(now)}`;
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function lockStatus(lock, isAlive) {
  if (!lock || !Number.isInteger(lock.pid)) return 'free';
  return isAlive(lock.pid) ? 'held' : 'stale';
}

export function evaluatePreflight(f) {
  const errors = [];
  const builds = ['install', 'import', 'update', 'rebuild'].includes(f.op);
  if (!f.isElevated) errors.push('Run elevated (Administrator) or as root.');
  if (!(f.nodeMajor >= 24)) errors.push(`Node.js 24 or newer is required (found ${f.nodeMajor ?? 'none'}).`);
  if (builds && !f.hasGit) errors.push('git is required.');
  if (f.lockHeld) errors.push('Another deployment is running (deploy.lock is held).');
  const needed = (builds ? MIN_FREE_BYTES : 0) + 2 * (f.dataBytes || 0);
  if (f.op !== 'remove-task' && f.freeBytes < needed) {
    errors.push(`Not enough free disk space: need ${gb(needed)}, have ${gb(f.freeBytes)}.`);
  }
  if (f.op === 'install' || f.op === 'import') {
    if (f.installed) errors.push('Already installed here; use update.');
    if (!f.hasEnvLocal) errors.push('.env.local not found (put it in shared/ or use -ImportFrom).');
  }
  if (f.op === 'install' && f.serviceExists) {
    errors.push('A service/task with this name already exists; use -ImportFrom to migrate it.');
  }
  if (f.op === 'import' && !f.serviceExists) errors.push('No existing service/task found to migrate.');
  if (['update', 'rebuild', 'restore'].includes(f.op)) {
    if (!f.installed) errors.push('Not installed here; run deploy first.');
    else if (!f.serviceExists) errors.push('The service/task is missing; run deploy to reinstall it.');
  }
  return errors;
}

function gb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function checkSkipInstall(state, lockHash) {
  if (!state.lockHash || state.lockHash !== lockHash) {
    throw new DeployError(
      '-NoInstall refused: package-lock.json differs from the last installed dependencies.',
      2,
      'preflight',
    );
  }
}

export function chooseRestoreTarget(state, revision, releases) {
  const candidates = state.previous.filter(
    (id) => id !== state.current && releases.includes(id) && state.backups[id],
  );
  const match = revision
    ? candidates.find((id) => id === revision || id.startsWith(revision) || revision.startsWith(id.slice(0, 12)))
    : candidates[0];
  if (!match) {
    const which = revision ? `revision ${revision}` : 'a previous release';
    throw new DeployError(`Cannot restore: no ${which} with a data backup is available.`, 2, 'preflight');
  }
  return match;
}

export function beginSwitch(state, { op, from, to, now }) {
  return { ...state, pending: { op, from, to, step: 'switch', backup: null, startedAt: iso(now) } };
}

export function updatePending(state, changes) {
  return { ...state, pending: { ...state.pending, ...changes } };
}

export function completeSwitch(state, { verified, lockHash, message = '', now }) {
  const { op, from, to, backup } = state.pending;
  const previous = from
    ? [from, ...state.previous.filter((id) => id !== from && id !== to)]
    : state.previous.filter((id) => id !== to);
  const backups = from && backup ? { ...state.backups, [from]: backup } : state.backups;
  return {
    ...state,
    current: to,
    previous,
    verified,
    pending: null,
    backups,
    lockHash: lockHash ?? state.lockHash,
    lastResult: { op, from, to, outcome: 'succeeded', step: 'done', at: iso(now), message },
  };
}

export function failSwitch(state, { op, from, to, outcome, step, message, now }) {
  const p = state.pending || {};
  return {
    ...state,
    pending: null,
    lastResult: {
      op: op ?? p.op,
      from: from ?? p.from ?? state.current,
      to: to ?? p.to ?? null,
      outcome,
      step: step ?? p.step ?? null,
      at: iso(now),
      message,
    },
  };
}

// What to undo when a previous run left `pending` behind.
export function recoveryPlan(state) {
  const p = state.pending;
  if (!p) return null;
  if (!p.from) {
    return {
      removeService: p.op === 'install',
      restoreService: p.op === 'import' ? p.serviceBackup ?? null : null,
      relinkTo: null,
      restoreData: null,
      start: p.op === 'import' && Boolean(p.serviceBackup),
    };
  }
  return {
    removeService: false,
    restoreService: null,
    relinkTo: p.from,
    restoreData: p.backup ?? null,
    start: true,
  };
}

// Decide which release and backup folders to delete after a success.
export function planPrune(state, releaseDirs, backupDirs, keep = KEEP) {
  const kept = [state.current, ...state.previous]
    .filter((id, i, all) => id && releaseDirs.includes(id) && all.indexOf(id) === i)
    .slice(0, keep);
  const previous = state.previous.filter((id) => kept.includes(id));
  const backups = Object.fromEntries(Object.entries(state.backups).filter(([id]) => kept.includes(id)));
  const keptBackups = new Set(Object.values(backups));
  return {
    state: { ...state, previous, backups },
    releases: releaseDirs.filter((d) => !kept.includes(d)),
    backups: backupDirs.filter((d) => d.includes('--') && !keptBackups.has(d)),
  };
}

function iso(now) {
  return new Date(now ?? Date.now()).toISOString();
}
