import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectLinuxAccount } from './linux-runtime.mjs';
import { linuxSystemdProperties } from './linux-systemd.mjs';
import { inspectLinuxServiceExecutable } from './linux-service-inspection.mjs';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { inspectConfigurationFiles } from './configuration-files.mjs';

const unitFields = ['LoadState', 'ActiveState', 'MainPID', 'ControlGroup', 'FragmentPath'];
const directoryIdentity = info => ({ dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode });

export async function inspectLinuxFirstInstall({ project, unit = 'agents-chat.service', signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'linux' || process.getuid() !== 0
    || Number(process.versions.node.split('.')[0]) !== 24
    || typeof project !== 'string' || !path.isAbsolute(project) || /[\0\r\n]/.test(project)) {
    throw new Error('Fresh Linux installation inspection requires root, Node 24 and an absolute project.');
  }
  const root = await canonicalWorkerDirectory(project);
  if (root.root === '/' || root.info.uid === 0 || root.info.gid === 0 || root.info.mode & 0o7022) {
    throw new Error('Fresh installation requires a non-root-owned project without shared write or special permissions.');
  }
  const control = path.join(path.dirname(root.root), `.${path.basename(root.root)}.deployment`);
  const absent = async ({ unitAbsent = true, runtimePaths = true, controlEvidence = true } = {}) => {
    signal?.throwIfAborted();
    if (unitAbsent) {
      const state = await linuxSystemdProperties(unit, unitFields, { allowMissing: true });
      if (state.LoadState !== 'not-found' || state.ActiveState !== 'inactive' || state.MainPID !== '0'
        || state.ControlGroup || state.FragmentPath) throw new Error('Fresh installation requires an absent systemd service.');
    }
    for (const name of runtimePaths ? ['.data', '.next', 'node_modules'] : []) {
      try { await lstat(path.join(root.root, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`Existing ${name} requires existing-installation inspection, not a fresh deployment.`);
    }
    if (!controlEvidence) return;
    try { await lstat(control); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await canonicalWorkerDirectory(control, { privateMode: true });
    if ((await readdir(control)).length) throw new Error('Existing control evidence requires recovery, not a fresh deployment.');
  };
  await absent();
  const account = await inspectLinuxAccount({ user: String(root.info.uid), group: String(root.info.gid) });
  const node = process.execPath;
  const npm = path.join(path.dirname(node), 'npm');
  const executables = await Promise.all([inspectLinuxServiceExecutable(npm), inspectLinuxServiceExecutable(node)]);
  if (path.basename(executables[0].target) !== 'npm-cli.js'
    || executables.some(entry => [entry.file, entry.target].some(file =>
      file === root.root || file.startsWith(`${root.root}${path.sep}`)))) {
    throw new Error('Fresh installation requires the external controller Node/npm toolchain.');
  }
  const configuration = await inspectConfigurationFiles({
    project: root.root, profile: 'agents-chat-auth-638c553', environment: { NODE_ENV: 'production' }, signal,
  });
  configuration.buildEnvironment({});
  const identity = Object.freeze({
    project: root.root, unit, runtime: 'absent', account,
    executables: Object.freeze(executables.map(entry => Object.freeze(entry))),
  });
  const recheck = async options => {
    signal?.throwIfAborted();
    const current = await canonicalWorkerDirectory(root.root);
    if (!same(directoryIdentity(current.info), directoryIdentity(root.info))
      || !same(await inspectLinuxAccount({ user: String(root.info.uid), group: String(root.info.gid) }), account)) {
      throw new Error('Fresh project ownership or runtime account changed.');
    }
    if (!same(await Promise.all([inspectLinuxServiceExecutable(npm), inspectLinuxServiceExecutable(node)]), executables)) {
      throw new Error('Fresh installation toolchain changed.');
    }
    await configuration.check({ signal });
    await absent(options);
  };
  const check = () => recheck();
  await check();
  return Object.freeze({
    identity, configuration, check,
    checkFreshRuntime: () => recheck({ controlEvidence: false }),
    checkUninstalled: () => recheck({ runtimePaths: false, controlEvidence: false }),
    checkIdentity: () => recheck({ unitAbsent: false, runtimePaths: false, controlEvidence: false }),
  });
}
