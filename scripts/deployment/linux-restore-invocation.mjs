import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { runStage } from './stage-runner.mjs';
import { inspectRecoveryEngineFiles, locateRecoveryEngine } from './recovery-engine-files.mjs';

const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

export async function prepareLinuxRestoreInvocation({ project, timeoutSeconds = 1800, signal }) {
  if (process.platform !== 'linux' || process.getuid() !== 0
    || typeof project !== 'string' || !path.isAbsolute(project)
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Public restore requires Linux root and a positive stage deadline.');
  }
  return runStage('restore-command-admission', async stageSignal => {
    const { root } = await canonicalWorkerDirectory(project);
    if (root === '/') throw new Error('The filesystem root cannot be a deployment restore project.');
    const control = path.join(path.dirname(root), `.${path.basename(root)}.deployment`);
    await canonicalWorkerDirectory(control, { privateMode: true });
    const backup = path.join(control, 'backup');
    try { await lstat(backup); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      throw Object.assign(new Error('No retained backup directory is available for restoration.', { cause }), {
        code: 'DEPLOYMENT_BACKUP_MISSING',
      });
    }
    const snapshot = await verifySnapshot(backup, { signal: stageSignal });
    const runtime = snapshot.runtime;
    if (snapshot.project !== root || snapshot.scope !== 'project' || runtime?.platform !== 'linux'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(runtime.unit ?? '')
      || !Array.isArray(runtime.executables) || runtime.executables.length !== 2
      || runtime.executables.some(executable => !['file', 'target'].every(key =>
        typeof executable?.[key] === 'string' && path.isAbsolute(executable[key])
        && !/[\0\r\n]/.test(executable[key]) && !inside(root, executable[key])))
      || inside(root, process.execPath)) {
      throw new Error('Saved backup does not establish this project and an external Linux runtime.');
    }
    const directory = await locateRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
    const engine = await inspectRecoveryEngineFiles({ directory, manifestSha256: snapshot.recoveryEngine, signal: stageSignal });
    return Object.freeze({
      file: process.execPath,
      args: Object.freeze([path.join(directory, 'linux-restore-entry.mjs'), control, engine.manifestSha256, '--accept-data-loss']),
      input: Object.freeze({ project: root, unit: runtime.unit,
        npm: runtime.executables[0].file, node: runtime.executables[1].file,
        backup, port: 3010, waitSeconds: 120, timeoutSeconds }),
      backupId: snapshot.id,
    });
  }, { timeoutMs: Math.min(timeoutSeconds * 1000, 2147483647), signal });
}
