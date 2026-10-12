import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalWorkerDirectory, externalWorkerDirectory } from './worker-files.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { runStage } from './stage-runner.mjs';
import { inspectRecoveryEngineFiles, locateRecoveryEngine } from './recovery-engine-files.mjs';

const canonical = value => typeof value === 'string' && value.length <= 4096
  && /^[A-Za-z]:\\/.test(value) && path.resolve(value) === value
  && !/[\0\r\n]/.test(value) && !value.slice(2).includes(':');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function prepareWindowsRestoreInvocation({
  project, taskName, pwsh, waitSeconds = 120, timeoutSeconds = 1800, signal,
}) {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24
    || ![project, pwsh, process.execPath].every(canonical) || path.dirname(project) === project
    || inside(project, pwsh) || inside(project, process.execPath)
    || typeof taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)
    || ![waitSeconds, timeoutSeconds].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Public Windows restore requires canonical external tools, a task and positive deadlines.');
  }
  return runStage('restore-command-admission', async stageSignal => {
    const { root } = await canonicalWorkerDirectory(project);
    if (root !== project) throw new Error('Installed restore project must be canonical.');
    for (const file of [pwsh, process.execPath]) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)).toLowerCase() !== file.toLowerCase()) {
        throw new Error('Restore executable must be an original canonical file.');
      }
    }
    const control = path.join(path.dirname(project), `.${path.basename(project)}.deployment`);
    await externalWorkerDirectory(control, project);
    const backup = path.join(control, 'backup');
    try { await lstat(backup); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      throw Object.assign(new Error('No retained backup is available for restoration.', { cause }), {
        code: 'DEPLOYMENT_BACKUP_MISSING',
      });
    }
    const snapshot = await verifySnapshot(backup, { signal: stageSignal });
    if (snapshot.version !== 3 || snapshot.scope !== 'project' || snapshot.project !== project
      || snapshot.runtime?.platform !== 'win32' || snapshot.runtime.task?.name !== taskName
      || typeof snapshot.recoveryEngine !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.recoveryEngine)) {
      throw new Error('Saved backup does not establish the requested complete Windows project and task.');
    }
    const directory = await locateRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
    const engine = await inspectRecoveryEngineFiles({
      directory, manifestSha256: snapshot.recoveryEngine, signal: stageSignal,
    });
    if (!engine.manifest.files.some(file => file.name === 'windows-restore-entry.mjs')) {
      throw Object.assign(new Error('This historical recovery engine has no Windows restore process entry.'), {
        code: 'DEPLOYMENT_SAVED_RESTORE_UNSUPPORTED',
      });
    }
    return Object.freeze({
      file: process.execPath,
      args: Object.freeze([path.join(engine.directory, 'windows-restore-entry.mjs'),
        control, engine.manifestSha256, '--accept-data-loss']),
      input: Object.freeze({ project, taskName, pwsh, backup, port: 3010, waitSeconds, timeoutSeconds }),
      backupId: snapshot.id,
    });
  }, { timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER), signal });
}
