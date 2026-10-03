import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { captureOwner, captureWorkerFields } from './worker-identity.mjs';
import {
  canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile,
  writeWorkerFile, syncWorkerDirectory,
} from './worker-files.mjs';

export const workerEngineFiles = Object.freeze([
  'linux-worker-bootstrap.mjs', 'linux-worker.mjs', 'owned-worker.mjs', 'process-identity.mjs',
  'saved-worker-engine.mjs', 'saved-worker-inspect.mjs',
  'stage-runner.mjs', 'worker-errors.mjs', 'worker-files.mjs',
  'worker-identity.mjs', 'worker-journal.mjs', 'worker-wire.mjs',
  'WindowsWorkerJob.cs', 'windows-worker-launcher.ps1', 'windows-worker-owner.ps1', 'windows-worker.mjs',
  'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs', 'WindowsRuntimeControl.cs',
  'WindowsPrivateFile.cs', 'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'windows-runtime-host.ps1',
  'WindowsPrivateFile.Admission.cs',
  'windows-admission.mjs', 'windows-admission.ps1', 'windows-controller-transport.mjs',
  'windows-runtime-bundle.ps1',
  'WindowsControllerToken.cs', 'WindowsControllerProcess.cs',
  'windows-task-owner-binding.ps1', 'windows-task-maintenance.ps1',
  'windows-task-controller.ps1', 'windows-task-controller.mjs',
  'windows-task-transaction.ps1', 'windows-task-transaction.mjs',
  'windows-task-retirement.ps1', 'windows-task-replacement.ps1', 'windows-task-activation.ps1', 'WindowsRuntimeListener.cs',
  'windows-task-listener.ps1', 'windows-readiness.mjs', 'http-readiness.mjs',
  'windows-task-completion.ps1', 'windows-task-completion.mjs',
  'windows-task-completion-records.ps1', 'windows-task-completion-proof.ps1',
  'windows-task-completion-proof.mjs', 'windows-task-completion-controller.ps1',
  'windows-task-completion-recovery.ps1', 'windows-task-completion-recovery-controller.ps1',
  'windows-task-completion-recovery.mjs',
  'windows-managed-task.ps1', 'windows-managed-task-controller.ps1', 'windows-managed-task.mjs',
  'windows-task-completion-record.mjs', 'windows-task-retirement-record.mjs', 'windows-task-retirement-intent.ps1',
  'windows-task-retirement-checkpoint.mjs', 'windows-task-retirement-checkpoint.ps1',
  'windows-task-retirement-records.ps1', 'windows-task-retirement-scope.ps1', 'windows-task-retirement-scope.mjs',
  'windows-deployment-retirement-record.mjs', 'windows-deployment-retirement-evidence.mjs',
  'windows-deployment-retirement-evidence.ps1', 'windows-deployment-retirement.ps1',
  'evidence-journal.mjs', 'worker-operation.mjs', 'state.mjs',
  'worker-retirement.mjs',
  'linux-systemd.mjs', 'linux-runtime.mjs',
  'linux-service-inspection.mjs', 'linux-service-sources.mjs',
  'linux-inactive-service.mjs',
  'linux-service-stop.mjs', 'linux-service-stop-evidence.mjs',
  'linux-service-activation.mjs', 'linux-activation-stop.mjs', 'service-activation-workers.mjs',
  'linux-service-retirement.mjs',
  'linux-recovery-admission.mjs',
  'linux-live-retirement.mjs',
  'linux-startup-link.mjs',
  'linux-cold-retirement-proof.mjs', 'linux-cold-activation-state.mjs',
]);
const files = workerEngineFiles;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function identity(project, operationId) {
  if (typeof project !== 'string' || !path.isAbsolute(project) || path.resolve(project) !== project
    || project.length > 4096
    || typeof operationId !== 'string' || !operationId || operationId.length > 4096
    || /[\0\r\n]/.test(project + operationId)) {
    throw new Error('Invalid saved worker engine identity.');
  }
}

function descriptor(directory, manifestSha256) {
  return Object.freeze({
    directory, entrypoint: path.join(directory, 'saved-worker-inspect.mjs'), manifestSha256,
  });
}

export async function saveWorkerEngine({ source, control, project, operationId }) {
  identity(project, operationId);
  await canonicalWorkerDirectory(project);
  const origin = await canonicalWorkerDirectory(source);
  const location = await externalWorkerDirectory(control, project);
  const directory = path.join(location.root, 'worker-engine');
  await mkdir(directory, { mode: 0o700 });
  await syncWorkerDirectory(location.root);
  const entries = [];
  for (const name of files) {
    const bytes = await readWorkerFile(path.join(origin.root, name), 1024 * 1024);
    await writeWorkerFile(path.join(directory, name), bytes);
    entries.push({ name, bytes: bytes.length, sha256: digest(bytes) });
  }
  for (const entry of entries) {
    const bytes = await readWorkerFile(path.join(origin.root, entry.name), 1024 * 1024);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
      throw new Error('Saved worker engine source changed while copying.');
    }
  }
  const manifest = Buffer.from(`${JSON.stringify({ version: 1, project, operationId, files: entries })}\n`);
  if (manifest.length > 32768) throw new Error('Saved worker engine manifest exceeds size limit.');
  await syncWorkerDirectory(directory);
  await writeWorkerFile(path.join(directory, 'manifest.json'), manifest);
  await syncWorkerDirectory(directory);
  return verifyWorkerEngine({ control, project, operationId, manifestSha256: digest(manifest) });
}

export async function verifyWorkerEngine({ control, project, operationId, manifestSha256 }) {
  identity(project, operationId);
  if (!validDigest(manifestSha256)) throw new Error('Invalid saved worker engine manifest digest.');
  const location = await externalWorkerDirectory(control, project);
  const { root: directory } = await canonicalWorkerDirectory(
    path.join(location.root, 'worker-engine'), { privateMode: true },
  );
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify([...files, 'manifest.json'].sort())) {
    throw new Error('Saved worker engine contains missing or unexpected files.');
  }
  const bytes = await readWorkerFile(path.join(directory, 'manifest.json'), 32768, { privateMode: true });
  if (digest(bytes) !== manifestSha256) throw new Error('Saved worker engine manifest digest changed.');
  const manifest = captureWorkerFields(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ['version', 'project', 'operationId', 'files'], 'engine manifest',
  );
  if (manifest.version !== 1 || manifest.project !== project || manifest.operationId !== operationId
    || !Array.isArray(manifest.files) || manifest.files.length !== files.length) {
    throw new Error('Unsupported or mismatched saved worker engine manifest.');
  }
  for (let index = 0; index < files.length; index++) {
    const entry = captureWorkerFields(manifest.files[index], ['name', 'bytes', 'sha256'], 'engine file');
    if (entry.name !== files[index] || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0 || entry.bytes > 1024 * 1024 || !validDigest(entry.sha256)) {
      throw new Error('Invalid saved worker engine file entry.');
    }
    const content = await readWorkerFile(path.join(directory, entry.name), 1024 * 1024, { privateMode: true });
    if (content.length !== entry.bytes || digest(content) !== entry.sha256) {
      throw new Error('Saved worker engine file hash changed.');
    }
  }
  return descriptor(directory, manifestSha256);
}

export function workerInspectionInvocation(saved, suppliedOwner) {
  const owner = captureOwner(suppliedOwner);
  const fields = captureWorkerFields(saved, ['directory', 'entrypoint', 'manifestSha256'], 'saved engine');
  if (typeof fields.directory !== 'string' || !path.isAbsolute(fields.directory)
    || path.basename(fields.directory) !== 'worker-engine'
    || fields.entrypoint !== path.join(fields.directory, 'saved-worker-inspect.mjs')
    || !validDigest(fields.manifestSha256)) {
    throw new Error('Invalid saved worker inspection entrypoint.');
  }
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
  return {
    file: process.execPath,
    args: [fields.entrypoint, path.dirname(fields.directory), fields.manifestSha256],
    env, input: `${JSON.stringify(owner)}\n`,
  };
}
