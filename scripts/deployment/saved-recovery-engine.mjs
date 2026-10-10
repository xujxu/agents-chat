import { lstat, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { workerEngineFiles } from './saved-worker-engine.mjs';
import { recoveryDigest as digest, inspectRecoveryEngineFiles, locateRecoveryEngine } from './recovery-engine-files.mjs';

const files = Object.freeze([...new Set([
  'saved-recovery-engine.mjs', 'retirement-recovery-entry.mjs', 'retirement-recovery.mjs',
  'recovery-engine-files.mjs', 'deployment-diagnostics.mjs',
  'saved-worker-engine.mjs', 'worker-files.mjs', 'worker-identity.mjs', 'process-identity.mjs', 'state.mjs',
  'linux-service-recovery.mjs', 'linux-service-inspection.mjs', 'linux-runtime.mjs', 'linux-systemd.mjs',
  'linux-recovery-admission.mjs', 'linux-recovery-completion.mjs',
  'linux-live-retirement.mjs',
  'linux-worker-retirement-handoff.mjs',
  ...workerEngineFiles,
  'linux-restore-entry.mjs', 'linux-restore.mjs', 'linux-restore-compatibility.mjs',
  'linux-cold-service.mjs', 'linux-cold-restore-admission.mjs',
  'linux-cold-restore-lease.mjs',
  'linux-cold-restore-files.mjs',
  'linux-cold-restore-activation.mjs',
  'linux-cold-activation-recovery.mjs',
  'linux-cold-retirement-proof.mjs', 'linux-cold-restore-completion.mjs',
  'linux-cold-restore.mjs',
  'restore-transaction.mjs', 'restore-project.mjs', 'restore-external.mjs',
  'restore-windows-external.mjs',
  'linux-configuration.mjs', 'configuration-files.mjs', 'configuration-compatibility.mjs',
  'linux-inactive-configuration.mjs', 'linux-inactive-discovery.mjs',
  'snapshot-configuration.mjs',
  'git-metadata.mjs', 'snapshot-git.mjs', 'restore-git.mjs', 'git-objects.mjs', 'git-graph-metadata.mjs',
  'snapshot.mjs', 'snapshot-files.mjs', 'snapshot-copy.mjs', 'snapshot-scope.mjs', 'snapshot-external.mjs', 'snapshot-rotation.mjs',
  'windows-snapshot-security.mjs', 'windows-snapshot-security.ps1',
  'windows-external-snapshot-security.mjs',
  'windows-task-snapshot.mjs',
  'windows-completed-closeout.mjs',
  'windows-deployment-acceptance.mjs', 'windows-current-deployment.mjs', 'deployment-receipt.mjs',
  'windows-configuration.mjs', 'windows-configuration-files.mjs', 'windows-configuration-files.ps1',
  'windows-first-install.mjs', 'windows-first-install-controller.ps1',
  'windows-first-runtime.mjs', 'windows-first-runtime.ps1',
  'windows-first-task.ps1', 'windows-first-task-registration.ps1',
  'windows-first-activation-handoff.ps1',
  'windows-first-activation.ps1',
  'windows-first-completion-handoff.ps1',
  'windows-first-completion.ps1',
  'build-artifacts.mjs',
  'windows-runtime-publication.mjs', 'windows-runtime-publication.ps1', 'windows-worker-scope.mjs',
  'windows-restore-security.mjs', 'windows-restore-security.ps1', 'WindowsPrivateFile.SourceSecurity.cs',
  'WindowsPrivateFile.SourceReparse.cs',
  'windows-source-security-controller.mjs', 'windows-git-object-security.mjs', 'windows-git-object-security.ps1',
  'windows-git-snapshot-security.mjs',
  'windows-git-metadata-security.mjs', 'windows-git-metadata-security.ps1',
  'linux-readiness.mjs', 'linux-listener.mjs',
])]);
const descriptor = (directory, manifestSha256) => Object.freeze({
  directory, entrypoint: path.join(directory, 'retirement-recovery-entry.mjs'), manifestSha256,
});

export async function verifyRecoveryEngine({ control, manifestSha256 }) {
  if (typeof manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error('Invalid recovery manifest digest.');
  }
  const directory = await locateRecoveryEngine({ control, manifestSha256 });
  const { manifest } = await inspectRecoveryEngineFiles({ directory, manifestSha256 });
  if (JSON.stringify(manifest.files.map(entry => entry.name)) !== JSON.stringify(files)) {
    throw new Error('Incomplete or unexpected recovery engine files.');
  }
  return descriptor(directory, manifestSha256);
}

export async function saveRecoveryEngine({ source, control, allowVersionChange = false }) {
  const { root: origin } = await canonicalWorkerDirectory(source);
  const { root } = await canonicalWorkerDirectory(control, { privateMode: true });
  let directory = path.join(root, 'recovery-engine');
  const entries = [];
  let total = 0;
  for (const name of files) {
    const bytes = await readWorkerFile(path.join(origin, name), 1024 * 1024);
    total += bytes.length;
    if (total > 16 * 1024 * 1024) throw new Error('Recovery source exceeds the supported byte budget.');
    entries.push({ name, bytes: bytes.length, sha256: digest(bytes) });
  }
  const manifest = Buffer.from(`${JSON.stringify({ version: 1, files: entries })}\n`);
  const manifestSha256 = digest(manifest);
  let exists = true;
  try { await lstat(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  if (exists) {
    const legacy = await inspectRecoveryEngineFiles({ directory });
    if (legacy.manifestSha256 === manifestSha256) return verifyRecoveryEngine({ control: root, manifestSha256 });
    if (!allowVersionChange) throw new Error('Recovery source differs from the retained engine.');
    directory = path.join(root, `recovery-engine-${manifestSha256}`);
    try { await lstat(directory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exists = false;
    }
  }
  if (!exists) {
    const staging = `${directory}.staging`;
    await mkdir(staging, { mode: 0o700 });
    await syncWorkerDirectory(root);
    for (const entry of entries) {
      const content = await readWorkerFile(path.join(origin, entry.name), 1024 * 1024);
      if (content.length !== entry.bytes || digest(content) !== entry.sha256) throw new Error('Recovery source changed while saving.');
      await writeWorkerFile(path.join(staging, entry.name), content);
    }
    for (const entry of entries) {
      if (digest(await readWorkerFile(path.join(origin, entry.name), 1024 * 1024)) !== entry.sha256) {
        throw new Error('Recovery source changed while saving.');
      }
    }
    await writeWorkerFile(path.join(staging, 'manifest.json'), manifest);
    await syncWorkerDirectory(staging);
    await inspectRecoveryEngineFiles({ directory: staging, manifestSha256 });
    await rename(staging, directory);
    await syncWorkerDirectory(root);
  }
  return verifyRecoveryEngine({ control: root, manifestSha256 });
}

export function retirementRecoveryInvocation(saved, { control, project, operationId, kind = 'worker', pwsh }) {
  const fields = captureWorkerFields(saved, ['directory', 'entrypoint', 'manifestSha256'], 'saved recovery engine');
  const kinds = process.platform === 'win32' ? ['worker', 'task'] : ['worker', 'service'];
  if (!kinds.includes(kind) || !path.isAbsolute(control) || path.resolve(control) !== control
    || !path.isAbsolute(project) || path.resolve(project) !== project
    || typeof operationId !== 'string' || !operationId || operationId.length > 4096 || /[\0\r\n]/.test(operationId)
    || !['recovery-engine', `recovery-engine-${fields.manifestSha256}`].some(name => fields.directory === path.join(control, name))
    || fields.entrypoint !== path.join(fields.directory, 'retirement-recovery-entry.mjs')
    || !/^[a-f0-9]{64}$/.test(fields.manifestSha256)) throw new Error('Invalid saved recovery invocation.');
  if (process.platform === 'win32' && (typeof pwsh !== 'string'
    || !path.isAbsolute(pwsh) || path.resolve(pwsh) !== pwsh || pwsh.length > 4096 || /[\0\r\n]/.test(pwsh))) {
    throw new Error('Saved Windows recovery requires an explicit canonical PowerShell path.');
  }
  return {
    file: process.execPath,
    args: [fields.entrypoint, control, fields.manifestSha256, project, operationId,
      ...(process.platform === 'win32' ? [kind, pwsh] : kind === 'service' ? [kind] : [])],
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))),
  };
}
