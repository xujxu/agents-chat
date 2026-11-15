import { execFile } from 'child_process';
import * as path from 'path';
import { existsSync } from 'fs';
import type { StoredGitContext } from './chatStore';
import { createLogger } from './logger';

const logger = createLogger('gitContext');

export type GitWorktree = {
  worktreePath: string;
  branchName: string;
  isMain: boolean;
};

export type GitContextOptions = {
  available: boolean;
  repoRoot: string;
  branches: string[];
  worktrees: GitWorktree[];
  effective: StoredGitContext | null;
  statusText?: string;
};

export type GitContextValidationResult =
  | { ok: true; gitContext: StoredGitContext }
  | { ok: false; error: string };

function resolveGitBin(): string {
  const configured = process.env.GIT_BIN?.trim();
  if (configured) return configured;
  if (process.platform !== 'win32' && existsSync('/usr/bin/git')) return '/usr/bin/git';
  return 'git';
}

function execGit(gitBin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitBin, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
  });
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  const gitBin = resolveGitBin();
  const normalizedRepoRoot = normalizePath(repoRoot);
  try {
    return (await execGit(gitBin, ['-c', `safe.directory=${normalizedRepoRoot}`, ...args], repoRoot)).trim();
  } catch (error) {
    logger.warn({
      repoRoot,
      normalizedRepoRoot,
      gitBin,
      args,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error && typeof error === 'object' ? {
          status: 'status' in error ? error.status : undefined,
          signal: 'signal' in error ? error.signal : undefined,
          code: 'code' in error ? error.code : undefined,
          stdout: 'stdout' in error ? String(error.stdout ?? '') : undefined,
          stderr: 'stderr' in error ? String(error.stderr ?? '') : undefined,
          spawnargs: 'spawnargs' in error ? error.spawnargs : undefined,
        } : {}),
      } : String(error),
    }, 'Git command failed');
    throw error;
  }
}

function normalizePath(input: string): string {
  return path.resolve(input).replace(/\\/g, '/');
}

export function parseWorktreePorcelain(output: string): GitWorktree[] {
  const blocks = output
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const parsed = blocks
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const wt = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) || '';
      const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) || '';
      const branchName = branchRef.startsWith('refs/heads/')
        ? branchRef.slice('refs/heads/'.length)
        : branchRef;
      const normalized = wt ? normalizePath(wt) : '';
      return {
        worktreePath: normalized,
        branchName,
        isMain: !normalized.includes('/.worktrees/'),
      };
    })
    .filter((entry) => entry.worktreePath.length > 0);

  return parsed;
}

export function selectWorktreeForBranch(branchName: string, worktrees: GitWorktree[]): GitWorktree | null {
  return worktrees.find((worktree) => worktree.branchName === branchName) || null;
}

export function isValidStoredGitContext(value: unknown): value is StoredGitContext {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.repoRoot === 'string'
    && typeof candidate.worktreePath === 'string'
    && typeof candidate.branchName === 'string';
}

type GitRepoSnapshot = { repoRoot: string; branches: string[]; worktrees: GitWorktree[] };

// Branch/worktree listings only feed the picker, so a short cache keeps chat loads from
// spawning git each time. Writes validate against a fresh read (see `fresh`).
const GIT_SNAPSHOT_TTL_MS = 15_000;
const gitSnapshots = new Map<string, { at: number; snapshot: Promise<GitRepoSnapshot> }>();

async function readGitRepo(initialRoot: string): Promise<GitRepoSnapshot> {
  const repoRoot = normalizePath(await runGit(initialRoot, ['rev-parse', '--show-toplevel']));
  const [branchesOutput, worktreesOutput] = await Promise.all([
    runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGit(repoRoot, ['worktree', 'list', '--porcelain']),
  ]);
  const branches = branchesOutput
    .split(/\r?\n/)
    .map((branch) => branch.trim())
    .filter(Boolean);
  return { repoRoot, branches, worktrees: parseWorktreePorcelain(worktreesOutput) };
}

function loadGitRepo(initialRoot: string, fresh: boolean): Promise<GitRepoSnapshot> {
  const cached = gitSnapshots.get(initialRoot);
  if (!fresh && cached && Date.now() - cached.at < GIT_SNAPSHOT_TTL_MS) return cached.snapshot;
  const snapshot = readGitRepo(initialRoot);
  gitSnapshots.set(initialRoot, { at: Date.now(), snapshot });
  return snapshot;
}

export function clearGitContextCache(): void {
  gitSnapshots.clear();
}

export async function getGitContextOptions(
  savedContext?: StoredGitContext | null,
  repoRootHint?: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<GitContextOptions> {
  try {
    const initialRoot = normalizePath(repoRootHint || savedContext?.repoRoot || process.cwd());
    const { repoRoot, branches, worktrees } = await loadGitRepo(initialRoot, fresh);
    const validSaved = savedContext
      && normalizePath(savedContext.repoRoot) === repoRoot
      && worktrees.some((worktree) => worktree.worktreePath === normalizePath(savedContext.worktreePath));

    let effective: StoredGitContext | null = null;
    if (validSaved && savedContext) {
      effective = {
        repoRoot,
        worktreePath: normalizePath(savedContext.worktreePath),
        branchName: savedContext.branchName,
        isFallback: false,
      };
    } else if (worktrees.length > 0) {
      const main = worktrees.find((worktree) => worktree.isMain) || worktrees[0];
      effective = {
        repoRoot,
        worktreePath: main.worktreePath,
        branchName: main.branchName || branches[0] || '',
        isFallback: !!savedContext,
      };
    }

    return { available: true, repoRoot, branches: [...branches], worktrees: worktrees.map((worktree) => ({ ...worktree })), effective };
  } catch (error) {
    logger.warn({
      repoRootHint: repoRootHint || null,
      savedRepoRoot: savedContext?.repoRoot || null,
      savedWorktreePath: savedContext?.worktreePath || null,
      processCwd: process.cwd(),
      gitBin: resolveGitBin(),
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : String(error),
    }, 'Failed to resolve git context');
    return {
      available: false,
      repoRoot: '',
      branches: [],
      worktrees: [],
      effective: null,
      statusText: 'Git context unavailable',
    };
  }
}

export function validateGitContext(input: StoredGitContext, options: GitContextOptions): GitContextValidationResult {
  if (!options.available) return { ok: false, error: 'git_unavailable' };

  const repoRoot = normalizePath(input.repoRoot);
  const worktreePath = normalizePath(input.worktreePath);
  if (repoRoot !== normalizePath(options.repoRoot)) return { ok: false, error: 'repo_mismatch' };

  const selectedWorktree = options.worktrees.find((worktree) => worktree.worktreePath === worktreePath);
  if (!selectedWorktree) return { ok: false, error: 'unknown_worktree' };

  const branchName = selectedWorktree.branchName || input.branchName;
  if (input.branchName && input.branchName !== branchName) {
    const mapped = selectWorktreeForBranch(input.branchName, options.worktrees);
    if (!mapped) return { ok: false, error: 'branch_without_worktree' };
    return {
      ok: true,
      gitContext: {
        repoRoot: options.repoRoot,
        worktreePath: mapped.worktreePath,
        branchName: mapped.branchName,
      },
    };
  }

  return {
    ok: true,
    gitContext: {
      repoRoot: options.repoRoot,
      worktreePath,
      branchName,
    },
  };
}
