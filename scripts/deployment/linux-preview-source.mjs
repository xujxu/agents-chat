import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectGitMetadata } from './git-metadata.mjs';

const execute = promisify(execFile);

export async function inspectLinuxPreviewSource({ project, options, signal }) {
  const source = await inspectGitMetadata({ project, signal });
  const git = async (args, optional = false) => {
    try {
      return (await execute('/usr/bin/git', [
        '--no-pager', '--no-replace-objects', '-c', `safe.directory=${project}`,
        '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', project, ...args,
      ], {
        signal, timeout: 30000, maxBuffer: 16384,
        env: {
          PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C', LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
      })).stdout.trim();
    } catch (cause) {
      signal?.throwIfAborted();
      if (optional && cause.code === 1) return null;
      throw Object.assign(new Error('Read-only local Git inspection failed; inspect the source checkout.', { cause }),
        { code: 'DEPLOYMENT_PREVIEW_SOURCE_UNAVAILABLE' });
    }
  };
  const localTarget = async () => {
    if (options.noPull) return { commit: source.record.commit, mode: 'unchanged', freshness: 'local-only' };
    let ref = options.revision;
    if (!ref) {
      if (!source.record.ref) return null;
      ref = await git(['for-each-ref', '--format=%(upstream)', '--', source.record.ref]);
      if (!ref) return null;
      if (!ref.startsWith('refs/') || /[\0\r\n\s]/.test(ref)) throw new Error('Invalid local upstream reference.');
    }
    const commit = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], true);
    if (commit === null) return null;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Invalid local preview target identity.');
    if (!options.revision && await git(['merge-base', '--is-ancestor', source.record.commit, commit], true) === null) {
      throw new Error('Local source and upstream diverged; preserve history before updating.');
    }
    return { commit, mode: options.revision ? 'explicit' : 'fast-forward', freshness: 'local-only' };
  };
  const target = await localTarget();
  await source.check({ signal });
  return { source, target };
}
