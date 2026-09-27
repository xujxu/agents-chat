import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realDirectory } from './snapshot-files.mjs';

const execute = promisify(execFile);
const fullCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const runtimeFiles = new Set(['agents.json']);

async function git(project, args, allowedExitCodes = []) {
  try {
    const { stdout } = await execute('git', ['-C', project, ...args], {
      maxBuffer: 8 * 1024 * 1024, timeout: 120000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { code: 0, output: stdout };
  } catch (error) {
    if (allowedExitCodes.includes(error.code)) return { code: error.code, output: error.stdout ?? '' };
    throw new Error(`Git ${args[0]} failed (exit ${error.code ?? 'unknown'}); inspect the checkout and remote configuration.`);
  }
}

async function commitAt(project, revision) {
  const result = await git(project, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
  const commit = result.output.trim();
  if (!fullCommit.test(commit)) throw new Error('Cannot resolve source commit identity.');
  return commit;
}

export async function inspectSource(project) {
  const root = await realDirectory(project);
  const toplevel = (await git(root, ['rev-parse', '--show-toplevel'])).output.trim();
  if (await realDirectory(toplevel) !== root) throw new Error('Deployment project must be the source checkout root.');
  const commit = await commitAt(root, 'HEAD');
  const branchResult = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [1]);
  const branch = branchResult.code === 1 ? null : branchResult.output.trim();
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const modifiedRuntime = [];
  for (const record of status.output.split('\0').filter(Boolean)) {
    const flags = record.slice(0, 2);
    const name = record.slice(3);
    if (!runtimeFiles.has(name) || !/^[ M]{2}$/.test(flags)) {
      throw new Error(`Dirty or untracked source path: ${JSON.stringify(name)}. Preserve these changes before deployment.`);
    }
    modifiedRuntime.push(name);
  }
  return { project: root, commit, branch, modifiedRuntime: modifiedRuntime.sort() };
}

export async function resolveTarget(project, { revision, noPull = false } = {}) {
  if (revision !== undefined && (!fullCommit.test(revision) || noPull)) {
    throw new Error('Explicit revision requires a full commit ID and cannot be combined with no-pull.');
  }
  const source = await inspectSource(project);
  if (revision) {
    return { commit: await commitAt(source.project, revision), expectedSourceCommit: source.commit, mode: 'explicit' };
  }
  if (noPull) return { commit: source.commit, expectedSourceCommit: source.commit, mode: 'unchanged' };
  if (!source.branch) throw new Error('Normal upgrade requires a tracking branch; use an explicit revision for detached source.');
  const remoteResult = await git(source.project, ['config', '--get', `branch.${source.branch}.remote`], [1]);
  const remote = remoteResult.output.trim();
  if (!remote || !/^(?!-)[A-Za-z0-9_.-]+$/.test(remote)) {
    throw new Error('Normal upgrade requires a configured tracking remote.');
  }
  await git(source.project, ['fetch', '--no-tags', '--', remote]);
  const target = await commitAt(source.project, '@{upstream}');
  const ancestor = await git(source.project, ['merge-base', '--is-ancestor', source.commit, target], [1]);
  if (ancestor.code === 1) throw new Error('Source and upstream diverged; automatic upgrade requires fast-forward history.');
  return { commit: target, expectedSourceCommit: source.commit, branch: source.branch, mode: 'fast-forward' };
}

export async function selectSource(project, target) {
  if (!target || !fullCommit.test(target.commit ?? '') || !fullCommit.test(target.expectedSourceCommit ?? '')
    || (target.mode !== undefined && !['explicit', 'unchanged', 'fast-forward'].includes(target.mode))) {
    throw new Error('Invalid source selection receipt.');
  }
  const source = await inspectSource(project);
  if (source.commit !== target.expectedSourceCommit) throw new Error('Source changed after preflight receipt.');
  if (await commitAt(source.project, target.commit) !== target.commit) throw new Error('Target revision changed.');
  const runtimeChanges = await git(source.project, [
    'diff', '--name-only', source.commit, target.commit, '--', ...runtimeFiles,
  ]);
  if (runtimeChanges.output.trim()) {
    throw new Error('Target changes tracked runtime configuration; resolve configuration explicitly before source selection.');
  }
  if (target.mode === 'fast-forward') {
    if (source.branch !== target.branch) throw new Error('Tracking branch changed after preflight receipt.');
    await git(source.project, ['merge', '--ff-only', '--no-edit', target.commit]);
  } else if (source.commit !== target.commit) {
    await git(source.project, ['switch', '--detach', target.commit]);
  }
  const result = await inspectSource(source.project);
  if (result.commit !== target.commit) throw new Error('Source selection did not activate the target commit.');
  return result;
}
